'use strict';

/**
 * Processes working inside the workspace.
 *
 * The relay kills whatever a worker leaves in its own process group. A
 * process that detached into a new session escapes that, and can keep
 * writing after the tree was measured. It still has its working directory
 * inside the workspace, so the relay compares that set before dispatch and
 * after the worker exits. Anything new is reported, never killed: it could as
 * easily be a dev server the owner started in the meantime.
 *
 * Best effort and read-only. macOS and other BSDs via `lsof`, Linux via
 * /proc. Where neither works the answer is null, meaning "not observed".
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function inside(dir, root) {
  return dir === root || dir.startsWith(root + path.sep);
}

function realRoot(root) {
  try { return fs.realpathSync(root); } catch { return root; }
}

function fromProc(root) {
  let names;
  try { names = fs.readdirSync('/proc'); } catch { return null; }
  const pids = new Set();
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    try { if (inside(fs.readlinkSync(`/proc/${n}/cwd`), root)) pids.add(Number(n)); } catch { /* gone or not ours */ }
  }
  return pids;
}

function fromLsof(root) {
  const r = spawnSync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || !r.stdout) return null;
  const pids = new Set();
  let pid = null;
  for (const line of r.stdout.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n' && pid && inside(line.slice(1), root)) pids.add(pid);
  }
  return pids;
}

/** PIDs whose cwd is the workspace or below it, or null when unobservable. */
function workingIn(workspace) {
  if (process.platform === 'win32') return null;
  const root = realRoot(workspace);
  return process.platform === 'linux' ? fromProc(root) : fromLsof(root);
}

/**
 * New since `before`, excluding this relay and the worker's own process group
 * (the relay already killed that). Each with its command line.
 */
function newSince(before, workspace, workerPgid) {
  if (!before) return null;
  const now = workingIn(workspace);
  if (!now) return null;
  const fresh = [...now].filter((p) => !before.has(p) && p !== process.pid && p !== process.ppid);
  if (!fresh.length) return [];
  const table = processTable();
  const out = [];
  for (const pid of fresh) {
    const row = table.get(pid);
    if (!row) continue; // exited in the meantime
    if (workerPgid && row.pgid === workerPgid) continue;
    // Another relay in the same workspace, or its worker, is not ours to report.
    if (underRelay(pid, table)) continue;
    out.push({ pid, command: row.command.slice(0, 200) });
  }
  return out;
}

/** pid -> { ppid, pgid, command } for every process, from one `ps` call. */
function processTable() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
  const table = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] });
  }
  return table;
}

const RELAY_SCRIPT = path.join(__dirname, '..', 'relay.js');

function underRelay(pid, table) {
  for (let p = pid, hops = 0; p > 1 && hops < 32; hops++) {
    const row = table.get(p);
    if (!row) return false;
    if (row.command.includes(RELAY_SCRIPT)) return true;
    p = row.ppid;
  }
  return false;
}

module.exports = { workingIn, newSince };
