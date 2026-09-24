'use strict';

/**
 * Bounded execution.
 *
 * The worker is launched as a direct process with an argv array — never
 * through a shell — so nothing in a brief can be interpreted as a shell
 * metacharacter. On POSIX the child gets its own process group so that a
 * watchdog kill reaches the grandchildren too; without that, an orphaned
 * grandchild keeps the stdout pipe open and the relay hangs long past its
 * own timeout.
 */

const { spawn, spawnSync } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const OUTPUT_CAP_BYTES = 8 * 1024 * 1024;
const SIGKILL_GRACE_MS = 5000;
const IS_WINDOWS = process.platform === 'win32';

/** Bounded, append-only output buffer. Keeps the head and notes the loss. */
/**
 * Byte-capped capture of a child stream.
 *
 * Buffers are kept as bytes and decoded once, at the end. Decoding each chunk
 * on arrival corrupts any multi-byte character that straddles a chunk
 * boundary, and measuring the cap in UTF-16 code units makes a "byte cap" a
 * different size for every alphabet.
 */
function makeSink(cap = OUTPUT_CAP_BYTES) {
  const chunks = [];
  let bytes = 0;
  let dropped = 0;
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (bytes >= cap) { dropped += buf.length; return; }
      const room = cap - bytes;
      if (buf.length <= room) {
        chunks.push(buf);
        bytes += buf.length;
        return;
      }
      chunks.push(buf.subarray(0, room));
      bytes += room;
      dropped += buf.length - room;
    },
    get value() {
      // One contiguous decode, so every interior boundary is safe. Only a
      // character cut by the cap itself can be incomplete, and that sits at
      // the very end where the truncation notice explains it.
      const text = new StringDecoder('utf8').write(Buffer.concat(chunks));
      return dropped > 0 ? `${text}\n[relay: ${dropped} further bytes dropped at the ${cap}-byte capture cap]` : text;
    },
    get truncated() { return dropped > 0; },
  };
}

/**
 * Kill a whole process tree.
 * POSIX: signal the negated pid, which is the process group created by
 * `detached: true`. Windows has no such group, so use taskkill /T.
 */
function killTree(child, signal) {
  if (!child || child.pid == null) return;
  if (IS_WINDOWS) {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000 });
    } catch { /* fall through */ }
    try { child.kill(signal); } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * Run a command to completion under a watchdog.
 *
 * Resolves (never rejects) with:
 *   outcome  'exited' | 'timeout' | 'aborted' | 'launch_failure'
 */
function run({ command, args, cwd, env, timeoutSeconds, onStart, stdin, onStdout, onStderr }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const stdout = makeSink();
    const stderr = makeSink();

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: env || process.env,
        stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: false,          // never a shell: argv is passed through verbatim
        detached: !IS_WINDOWS, // own process group, so the watchdog reaches children
        windowsHide: true,
      });
    } catch (err) {
      resolve({
        outcome: 'launch_failure', exitCode: null, signal: null,
        stdout: '', stderr: String(err), startedAt,
        durationMs: Date.now() - startedAt, error: String(err), truncated: false,
      });
      return;
    }

    // Some CLIs take the brief on stdin rather than in argv. Write it and
    // close the pipe; EPIPE just means the child exited without reading.
    if (stdin != null && child.stdin) {
      child.stdin.on('error', () => {});
      try { child.stdin.end(stdin); } catch { /* child already gone */ }
    }

    if (typeof onStart === 'function') onStart(child);

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let sigkillTimer = null;

    const finish = (outcome, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (sigkillTimer) clearTimeout(sigkillTimer);
      for (const sig of ['SIGINT', 'SIGTERM']) process.removeListener(sig, onRelaySignal);
      resolve({
        outcome,
        exitCode: extra.exitCode ?? null,
        signal: extra.signal ?? null,
        stdout: stdout.value,
        stderr: stderr.value,
        truncated: stdout.truncated || stderr.truncated,
        startedAt,
        durationMs: Date.now() - startedAt,
        error: extra.error ?? null,
      });
    };

    // The relay itself being killed must not leave the worker running.
    function onRelaySignal() {
      aborted = true;
      killTree(child, 'SIGTERM');
      sigkillTimer = setTimeout(() => killTree(child, 'SIGKILL'), SIGKILL_GRACE_MS);
      sigkillTimer.unref();
    }
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, onRelaySignal);

    const watchdog = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGTERM');
      sigkillTimer = setTimeout(() => killTree(child, 'SIGKILL'), SIGKILL_GRACE_MS);
      sigkillTimer.unref();
    }, timeoutSeconds * 1000);
    watchdog.unref();

    child.stdout.on('data', (d) => {
      stdout.push(d);
      if (typeof onStdout === 'function') {
        try { onStdout(d); } catch { /* a throwing callback must not kill the run */ }
      }
    });
    child.stderr.on('data', (d) => {
      stderr.push(d);
      if (typeof onStderr === 'function') {
        try { onStderr(d); } catch { /* a throwing callback must not kill the run */ }
      }
    });
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    child.on('error', (err) => {
      const missing = err && (err.code === 'ENOENT' || err.code === 'EACCES');
      finish(missing ? 'launch_failure' : 'exited', { error: String(err && err.message ? err.message : err) });
    });

    child.on('close', (exitCode, signal) => {
      if (timedOut) finish('timeout', { exitCode, signal });
      else if (aborted) finish('aborted', { exitCode, signal });
      else finish('exited', { exitCode, signal });
    });
  });
}

/** Is this CLI on PATH and executable? Used by discovery, never by dispatch. */
function probeCommand(command, args = ['--version'], timeoutMs = 10_000, env = process.env) {
  try {
    const res = spawnSync(command, args, {
      encoding: 'utf8', timeout: timeoutMs, shell: false, env,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error) {
      return { ok: false, found: res.error.code !== 'ENOENT' ? true : false, output: '', error: String(res.error.code || res.error) };
    }
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    return { ok: res.status === 0, found: true, output, error: res.status === 0 ? null : `exit ${res.status}` };
  } catch (err) {
    return { ok: false, found: false, output: '', error: String(err) };
  }
}

module.exports = { run, killTree, probeCommand, makeSink, OUTPUT_CAP_BYTES, IS_WINDOWS };
