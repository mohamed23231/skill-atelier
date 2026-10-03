'use strict';

/**
 * Concurrency slots: at most N live runs of one worker at a time.
 *
 * Some accounts only tolerate one task at a time, and a batch fans out into
 * several worktrees. The slots therefore live in git's COMMON directory
 * (`git rev-parse --git-common-dir`), which every worktree of a repository
 * shares, so a batch and a hand-started run count against the same limit.
 *
 * A slot is a file named for the process that holds it. A holder is judged
 * alive by its PID, never by matching a command line: a waiter's own command
 * line would match its own label. Taking a slot happens under a short mutex
 * (an atomic mkdir), so two runs cannot both see the last free slot.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const POLL_MS = 1000;
const MUTEX_STALE_MS = 10_000;
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

/** Where slots live: the git common dir when there is one, else the state root. */
function slotRoot(workspace, stateRoot) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: workspace, encoding: 'utf8', timeout: 10_000 });
  const dir = r.status === 0 ? (r.stdout || '').trim() : '';
  return dir ? path.join(dir, 'delegate-fleet', 'slots') : path.join(stateRoot, '.delegate-fleet', 'slots');
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return Boolean(err && err.code === 'EPERM'); }
}

/** Live holders for one worker, pruning any whose process is gone. */
function holders(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const live = [];
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (alive(pid)) {
      let info = {};
      try { info = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { /* still a holder */ }
      live.push({ pid, ...info });
    } else {
      try { fs.unlinkSync(path.join(dir, name)); } catch { /* another pruner won */ }
    }
  }
  return live;
}

function withMutex(dir, fn) {
  const m = path.join(dir, '.mutex');
  for (let i = 0; i < 200; i++) {
    try {
      fs.mkdirSync(m);
      try { return fn(); } finally { try { fs.rmdirSync(m); } catch { /* gone */ } }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      // A holder that died inside the critical section leaves the mutex behind.
      try { if (Date.now() - fs.statSync(m).mtimeMs > MUTEX_STALE_MS) fs.rmdirSync(m); } catch { /* raced */ }
      Atomics.wait(SLEEPER, 0, 0, 25); // the critical section is a few syscalls
    }
  }
  throw new Error(`could not take the slot mutex at ${m}`);
}

/** Try once to take a slot. Returns { ok, holders }. */
function tryTake(dir, max, info) {
  fs.mkdirSync(dir, { recursive: true });
  return withMutex(dir, () => {
    const live = holders(dir).filter((h) => h.pid !== process.pid);
    if (live.length >= max) return { ok: false, holders: live };
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ ...info, at: new Date().toISOString() }));
    return { ok: true, holders: live };
  });
}

/**
 * Wait for a slot, up to `waitSeconds`. Released automatically when this
 * process exits. Returns { ok, waitedSeconds, holders, release }.
 */
async function acquire({ workspace, stateRoot, backend, max, waitSeconds, info = {}, onWait }) {
  const dir = path.join(slotRoot(workspace, stateRoot), backend.replace(/[^\w.-]/g, '_'));
  const started = Date.now();
  let told = false;
  for (;;) {
    const r = tryTake(dir, max, info);
    if (r.ok) {
      const file = path.join(dir, `${process.pid}.json`);
      const release = () => { try { fs.unlinkSync(file); } catch { /* already gone */ } };
      process.once('exit', release);
      return { ok: true, waitedSeconds: Math.round((Date.now() - started) / 1000), holders: r.holders, release, dir };
    }
    if (Date.now() - started >= waitSeconds * 1000) {
      return { ok: false, waitedSeconds: Math.round((Date.now() - started) / 1000), holders: r.holders, dir };
    }
    if (!told && typeof onWait === 'function') { told = true; onWait(r.holders); }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
}

/** Is a slot free right now? For routes deciding whether to fall through. */
function busy({ workspace, stateRoot, backend, max }) {
  const dir = path.join(slotRoot(workspace, stateRoot), backend.replace(/[^\w.-]/g, '_'));
  const live = holders(dir).filter((h) => h.pid !== process.pid);
  return live.length >= max ? live : null;
}

module.exports = { acquire, busy, slotRoot, holders, alive };
