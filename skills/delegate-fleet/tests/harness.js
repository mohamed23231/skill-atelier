'use strict';
/** Shared test scaffolding: throwaway git repos and relay/fleet invocation. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SKILL = path.resolve(__dirname, '..');
const RELAY = path.join(SKILL, 'scripts', 'relay.js');
const FLEET = path.join(SKILL, 'scripts', 'fleet.js');
const STUB = path.join(__dirname, 'fixtures', 'stub-worker.js');

const GOOD_BRIEF = `# Objective
Rename the settings screen component so it matches the naming used everywhere else in the app.

## Context
The settings feature still uses a legacy component name that no longer matches our conventions.

## Scope
- \`src/a.js\` — rename the component and update its export

## Non-goals
- Do not touch the navigation stack

## Acceptance criteria
1. The component is renamed
2. Every import of it resolves

## Verification
- The orchestrator runs the project gates afterwards
`;

const created = [];

function tmpRepo({ files = {}, dirty = {}, commit = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-test-'));
  created.push(dir);
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  if (commit) { git('add', '-A'); git('commit', '-qm', 'base'); }
  // Uncommitted work that existed BEFORE any delegation.
  for (const [rel, body] of Object.entries(dirty)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

function writeBrief(repo, text = GOOD_BRIEF, name = 'brief.md') {
  const p = path.join(repo, name);
  fs.writeFileSync(p, text);
  return p;
}

/** Point a backend id at the stub worker via project config. */
function useStub(repo, backend = 'claude', extra = {}) {
  const dir = path.join(repo, '.delegate-fleet');
  fs.mkdirSync(dir, { recursive: true });
  const cfgPath = path.join(dir, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { workers: {} };
  cfg.workers = cfg.workers || {};
  cfg.workers[backend] = { cli: STUB, ...extra };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

/**
 * Mark a backend's capabilities as locally verified, as `doctor` would --
 * including the executable identity, without which a record is not usable.
 */
function markVerified(repo, backend, capabilities, cliPath = STUB) {
  const dir = path.join(repo, '.delegate-fleet');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'verification.json');
  const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { backends: {} };
  const st = fs.statSync(cliPath);
  cur.backends[backend] = {
    at: new Date().toISOString(), platform: process.platform, version: 'stub',
    cliPath, cli: { path: cliPath, size: st.size, mtimeMs: Math.round(st.mtimeMs) },
    capabilities,
  };
  fs.writeFileSync(p, JSON.stringify(cur, null, 2));
}

function runRelay(args, { cwd, env = {} } = {}) {
  const res = spawnSync(process.execPath, [RELAY, ...args], {
    cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* text mode */ }
  return { ...res, json };
}

function runFleet(args, { cwd, env = {} } = {}) {
  const res = spawnSync(process.execPath, [FLEET, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env },
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* text mode */ }
  return { ...res, json };
}

/** Read the result.json the relay wrote, independent of stdout. */
function readResult(repo) {
  const runs = path.join(repo, '.delegate-fleet', 'runs');
  const dirs = fs.readdirSync(runs).sort();
  return JSON.parse(fs.readFileSync(path.join(runs, dirs[dirs.length - 1], 'result.json'), 'utf8'));
}

function cleanup() {
  for (const d of created) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
}

module.exports = { SKILL, RELAY, FLEET, STUB, GOOD_BRIEF, tmpRepo, writeBrief, useStub, markVerified, runRelay, runFleet, readResult, cleanup };
