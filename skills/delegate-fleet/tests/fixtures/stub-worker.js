#!/usr/bin/env node
'use strict';
/**
 * A worker that can misbehave on demand.
 *
 * Every real failure mode the relay claims to detect is reproduced here, so
 * the contract is tested against behaviour rather than against mocks. Driven
 * entirely by environment variables so it can stand in for any adapter's argv.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const env = process.env;
const cwd = process.cwd();
const abs = (p) => (path.isAbsolute(p) ? p : path.join(cwd, p));

// Prove which argv the adapter actually produced.
if (env.STUB_ECHO_ARGV) {
  fs.writeFileSync(env.STUB_ECHO_ARGV, JSON.stringify({ argv: process.argv.slice(2), cwd }, null, 2));
}
// Prove the brief arrived on stdin when the adapter says so.
if (env.STUB_ECHO_STDIN) {
  let data = '';
  process.stdin.on('data', (d) => { data += d; });
  process.stdin.on('end', () => { try { fs.writeFileSync(env.STUB_ECHO_STDIN, data); } catch {} });
}

if (env.STUB_PRINT) process.stdout.write(`${env.STUB_PRINT}\n`);

if (env.STUB_CREATE) {
  for (const f of env.STUB_CREATE.split(',')) {
    fs.mkdirSync(path.dirname(abs(f)), { recursive: true });
    fs.writeFileSync(abs(f), `created by stub worker\n`);
  }
}
if (env.STUB_MODIFY) {
  for (const f of env.STUB_MODIFY.split(',')) fs.appendFileSync(abs(f), 'stub worker appended this line\n');
}
if (env.STUB_DELETE) {
  for (const f of env.STUB_DELETE.split(',')) { try { fs.unlinkSync(abs(f)); } catch {} }
}
if (env.STUB_RENAME) {
  const [from, to] = env.STUB_RENAME.split(':');
  spawnSync('git', ['mv', from, to], { cwd });
}
if (env.STUB_COMMIT) {
  spawnSync('git', ['add', '-A'], { cwd });
  spawnSync('git', ['-c', 'user.email=stub@example.com', '-c', 'user.name=Stub', 'commit', '-m', 'stub worker committed'], { cwd });
}
if (env.STUB_STASH) {
  spawnSync('git', ['-c', 'user.email=stub@example.com', '-c', 'user.name=Stub', 'stash', 'push', '-u', '-m', 'stub'], { cwd });
}

// A grandchild in the same process group: if the watchdog only kills the
// direct child, this one survives and keeps the stdout pipe open.
if (env.STUB_SPAWN_CHILD) {
  const child = spawn(process.execPath, ['-e', `setTimeout(()=>{},${Number(env.STUB_SPAWN_CHILD)})`], { stdio: 'inherit' });
  if (env.STUB_CHILD_PIDFILE) fs.writeFileSync(env.STUB_CHILD_PIDFILE, String(child.pid));
}

const exitCode = Number(env.STUB_EXIT || 0);
const sleepMs = Number(env.STUB_SLEEP || 0);
if (sleepMs > 0) setTimeout(() => process.exit(exitCode), sleepMs);
else if (!env.STUB_ECHO_STDIN) process.exit(exitCode);
else process.stdin.on('end', () => process.exit(exitCode));
