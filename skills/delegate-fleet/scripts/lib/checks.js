'use strict';

/**
 * Orchestrator-named checks, run by the relay after the worker finishes.
 *
 * The orchestrator still decides what the project's gates are; the relay only
 * runs the commands it was handed and records pass/fail plus a short tail of
 * output. That is a fact about a process, not a judgement about the work, so
 * it stays on the relay's side of the trust boundary.
 *
 * Why the relay and not the orchestrator: every gate the orchestrator runs
 * itself lands its full output in the orchestrator's context. Here the full
 * log goes to an artifact and the result carries only the tail.
 *
 * No shell. A check is split into argv with simple quoting rules and spawned
 * directly, exactly like the worker. Pipes, `&&`, redirects and globs are
 * rejected rather than silently passed as literal arguments; put anything
 * compound in a script and check that.
 */

const fs = require('node:fs');
const path = require('node:path');
const exec = require('./exec.js');

const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;
const MAX_CHECKS = 20;
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;
const SHELL_OPERATORS = /^(\||\|\||&&|;|>|>>|<|2>|2>&1|&)$/;

/**
 * Split a command line into argv. Supports '…' and "…" quoting and backslash
 * escapes outside single quotes. Returns { argv } or { error }.
 */
function tokenize(line) {
  const argv = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  const s = String(line || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") quote = null; else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && ['"', '\\'].includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inToken = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; inToken = true; continue; }
    if (/\s/.test(c)) {
      if (inToken) { argv.push(cur); cur = ''; inToken = false; }
      continue;
    }
    cur += c;
    inToken = true;
  }
  if (quote) return { error: `unterminated ${quote} quote in check "${s}"` };
  if (inToken) argv.push(cur);
  if (argv.length === 0) return { error: 'a check must name a command' };
  const op = argv.find((a) => SHELL_OPERATORS.test(a));
  if (op) {
    return { error: `check "${s}" uses the shell operator "${op}"; checks run without a shell. Put compound commands in a script` };
  }
  return { argv };
}

/** The last few lines of output, bounded in both lines and characters. */
function tail(text) {
  const lines = String(text || '').replace(/\s+$/, '').split('\n');
  let out = lines.slice(-TAIL_LINES).join('\n');
  if (out.length > TAIL_CHARS) out = out.slice(out.length - TAIL_CHARS);
  return out;
}

/**
 * Run each check in order, in the workspace. Every check runs even after one
 * fails, so the orchestrator gets the whole picture in one result.
 */
async function runAll({ checks, cwd, env, timeoutSeconds, outDir, onOutput }) {
  const results = [];
  for (let i = 0; i < checks.length; i++) {
    const { command, argv } = checks[i];
    const r = await exec.run({
      command: argv[0], args: argv.slice(1), cwd, env: env || process.env,
      timeoutSeconds: timeoutSeconds || DEFAULT_CHECK_TIMEOUT_SECONDS,
      onStdout: onOutput, onStderr: onOutput,
    });
    const combined = [r.stdout, r.stderr].filter(Boolean).join('\n');
    let log = null;
    if (outDir) {
      log = path.join(outDir, `check-${i + 1}.log`);
      try { fs.writeFileSync(log, combined); } catch { log = null; }
    }
    results.push({
      command,
      outcome: r.outcome,
      exitCode: r.exitCode,
      passed: r.outcome === 'exited' && r.exitCode === 0 && !r.signal,
      durationSeconds: Math.round(r.durationMs / 1000),
      tail: tail(combined),
      log,
    });
  }
  return results;
}

module.exports = { tokenize, tail, runAll, DEFAULT_CHECK_TIMEOUT_SECONDS, MAX_CHECKS };
