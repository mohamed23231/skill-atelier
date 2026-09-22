'use strict';

/**
 * Environment discovery and local verification.
 *
 * Three questions, kept apart on purpose:
 *
 *   supported  Does the framework have an adapter?   -> adapters/index.js
 *   available  Is the CLI installed on THIS machine? -> discover(), runtime
 *   verified   What can the INSTALLED version do?    -> verify(), recorded
 *
 * A backend stays supported on a machine where it is not installed. Nothing in
 * here ever deletes or disables an adapter; it only annotates one.
 */

const fs = require('node:fs');
const path = require('node:path');
const { probeCommand } = require('./exec.js');
const { AVAILABILITY, applyLocalEvidence, clampToExpressible, CAPABILITY_NAMES } = require('./capabilities.js');

const STATE_DIR = '.delegate-fleet';
const CONFIG_FILE = 'config.json';
const VERIFICATION_FILE = 'verification.json';

/** Install locations a non-login shell commonly misses. */
const EXTRA_BIN_DIRS = ['~/.local/bin', '~/.npm-global/bin', '/usr/local/bin', '/opt/homebrew/bin'];

function candidateDirs(env = process.env) {
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const home = env.HOME || env.USERPROFILE || '';
  for (const extra of EXTRA_BIN_DIRS) {
    const expanded = extra.replace(/^~/, home);
    if (expanded && !dirs.includes(expanded)) dirs.push(expanded);
  }
  try {
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvmDir)) {
      const bin = path.join(nvmDir, v, 'bin');
      if (fs.existsSync(bin) && !dirs.includes(bin)) dirs.push(bin);
    }
  } catch { /* no nvm; fine */ }
  return dirs;
}

/** Resolve a CLI name (or an absolute override) to an executable path. */
function resolveCli(cli, env = process.env) {
  if (!cli) return null;
  if (cli.includes('/') || cli.includes('\\')) {
    try { fs.accessSync(cli, fs.constants.X_OK); return cli; } catch { return null; }
  }
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of candidateDirs(env)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cli + ext);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
  }
  return null;
}

function stateDir(repoRoot) { return path.join(repoRoot, STATE_DIR); }

/**
 * A cheap identity for the executable a verification record was taken from.
 *
 * Comparing the path alone is not enough: a package upgrade replaces the
 * binary in place, and evidence about the old version would keep authorising
 * runs against the new one. Size and mtime change on replacement and cost one
 * stat, where running `--version` would cost a process spawn on every
 * discover.
 */
function cliIdentity(cliPath) {
  if (!cliPath) return null;
  try {
    const st = fs.statSync(cliPath);
    return { path: cliPath, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }
}

function sameIdentity(a, b) {
  if (!a || !b) return false;
  return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/**
 * Read a JSON file. Distinguishes "absent" from "malformed": a config the user
 * meant to apply but mistyped must be an error, not a silent fall-back to
 * defaults.
 */
function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Only "not there" is absence. A permissions problem or a directory in the
    // file's place would otherwise silently become "use the defaults", running
    // with options the user did not configure.
    if (err && err.code === 'ENOENT') return { present: false, value: null, error: null };
    return { present: true, value: null, error: `${(err && err.code) || 'read failed'}: ${file}` };
  }
  try {
    return { present: true, value: JSON.parse(text), error: null };
  } catch (err) {
    return { present: true, value: null, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Project configuration. Intentionally tiny: every field below is consumed at
 * dispatch, and a test proves each one reaches the backend invocation.
 */
function loadConfig(repoRoot) {
  const file = path.join(stateDir(repoRoot), CONFIG_FILE);
  const read = readJson(file);
  const workers = {};
  const errors = [];
  if (read.error) return { workers, errors: [`${CONFIG_FILE}: could not be read as JSON (${read.error})`] };
  const raw = read.value;
  if (read.present && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    return { workers, errors: [`${CONFIG_FILE}: expected a JSON object at the top level`] };
  }
  const rawWorkers = raw && raw.workers !== undefined ? raw.workers : {};
  if (rawWorkers === null || typeof rawWorkers !== 'object' || Array.isArray(rawWorkers)) {
    return { workers, errors: [`${CONFIG_FILE}: "workers" must be an object keyed by backend id`] };
  }
  for (const [id, cfg] of Object.entries(rawWorkers)) {
    if (!cfg || typeof cfg !== 'object') { errors.push(`workers.${id}: expected an object`); continue; }
    const entry = {};
    if (cfg.cli !== undefined) {
      if (typeof cfg.cli !== 'string' || !cfg.cli.trim()) errors.push(`workers.${id}.cli: expected a non-empty string`);
      else entry.cli = cfg.cli.trim();
    }
    if (cfg.model !== undefined) {
      if (typeof cfg.model !== 'string' || !cfg.model.trim()) errors.push(`workers.${id}.model: expected a non-empty string`);
      else entry.model = cfg.model.trim();
    }
    if (cfg.effort !== undefined) {
      if (typeof cfg.effort !== 'string' || !cfg.effort.trim()) errors.push(`workers.${id}.effort: expected a non-empty string`);
      else entry.effort = cfg.effort.trim();
    }
    if (cfg.timeoutSeconds !== undefined) {
      const n = Number(cfg.timeoutSeconds);
      if (!Number.isInteger(n) || n <= 0) errors.push(`workers.${id}.timeoutSeconds: expected a positive integer`);
      else entry.timeoutSeconds = n;
    }
    // Any other key is a field with no consumer: reject it rather than let it
    // look meaningful. This is the class of bug that made v1 untrustworthy.
    for (const key of Object.keys(cfg)) {
      if (!['cli', 'model', 'effort', 'timeoutSeconds'].includes(key)) {
        errors.push(`workers.${id}.${key}: unknown option; this field would be silently ignored`);
      }
    }
    workers[id] = entry;
  }
  return { workers, errors };
}

/** Locally recorded capability evidence, written by `fleet.js doctor`. */
function loadVerification(repoRoot) {
  const raw = readJson(path.join(stateDir(repoRoot), VERIFICATION_FILE)).value;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { backends: {} };
}

function saveVerification(repoRoot, report) {
  const dir = stateDir(repoRoot);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, VERIFICATION_FILE), `${JSON.stringify(report, null, 2)}\n`);
  return path.join(dir, VERIFICATION_FILE);
}

/**
 * The full picture for one backend on this machine: what it claims, whether it
 * is here, and what local evidence says.
 */
function inspect(adapter, { config, verification, env } = {}) {
  const cfg = (config && config.workers && config.workers[adapter.id]) || {};
  const cli = cfg.cli || adapter.cli;
  const resolved = resolveCli(cli, env);
  const record = verification && verification.backends ? verification.backends[adapter.id] : null;
  // Evidence is about one executable, not about a backend id. A record that
  // does not identify the binary it came from, or that identifies a different
  // one, proves nothing about what is about to run.
  const current = cliIdentity(resolved);
  const usable = Boolean(record) && sameIdentity(record.cli, current);
  const staleFor = record && !usable ? (record.cli ? record.cli.path : 'an unidentified executable') : null;
  const local = usable ? record : null;

  return {
    id: adapter.id,
    title: adapter.title,
    cli,
    cliPath: resolved,
    supported: true, // always: the adapter exists in this framework
    availability: resolved ? AVAILABILITY.available : AVAILABILITY.unavailable,
    declaredCapabilities: { ...adapter.capabilities },
    capabilities: applyLocalEvidence(adapter.capabilities, local && local.capabilities),
    localVerification: local ? { at: local.at, version: local.version, platform: local.platform } : null,
    staleVerification: staleFor ? { recordedFor: staleFor, nowResolvesTo: resolved } : null,
    defaults: { model: cfg.model || null, effort: cfg.effort || null, timeoutSeconds: cfg.timeoutSeconds || null },
    docs: adapter.docs,
    staticEvidence: adapter.evidence || null,
  };
}

/** Discover every supported backend's state on this machine. */
function discover(adapters, opts = {}) {
  return adapters.map((a) => inspect(a, opts));
}

/**
 * Local verification: ask the installed CLI what it supports and record it.
 * This can promote a `documented` claim to `verified` and can equally demote
 * one to `unsupported`. The installed version is the authority.
 */
function verify(adapter, opts = {}) {
  const env = opts.env || process.env;
  const cfg = (opts.config && opts.config.workers && opts.config.workers[adapter.id]) || {};
  const cli = cfg.cli || adapter.cli;
  const cliPath = resolveCli(cli, env);
  if (!cliPath) {
    return { id: adapter.id, availability: AVAILABILITY.unavailable, capabilities: null, reason: `${cli} not found on PATH` };
  }
  const version = probeCommand(cliPath, ['--version'], 10_000, env);
  const help = probeCommand(cliPath, adapter.helpArgs || ['--help'], 10_000, env);
  // Output from a --help that crashed or timed out is not evidence of
  // anything; treating it as such would record capabilities from noise.
  if (!help.ok) {
    return {
      id: adapter.id, availability: AVAILABILITY.available, capabilities: null,
      reason: `\`${cli} ${(adapter.helpArgs || ['--help']).join(' ')}\` failed; nothing was verified`,
    };
  }
  // Some capabilities cannot be proven from --help alone -- whether a named
  // agent or profile exists, for instance. An adapter names the extra probes
  // it needs, and their output joins the evidence its probe() reads.
  const extra = [];
  for (const args of adapter.evidenceArgs || []) {
    const res = probeCommand(cliPath, args, 10_000, env);
    extra.push(res.ok ? (res.output || '') : '');
  }
  const helpText = [help.output || '', version.output || ''].join('\n');
  if (!helpText.trim()) {
    return { id: adapter.id, availability: AVAILABILITY.available, capabilities: null, reason: 'the CLI produced no --help output to verify against' };
  }
  // A probe reads help text, which says what flags exist -- not what this
  // adapter passes. Clamp it so a probe can never promote a capability the
  // invocation would silently drop.
  const observed = clampToExpressible(adapter.probe(helpText, { extra }) || {}, adapter);
  const capabilities = {};
  for (const name of CAPABILITY_NAMES) if (observed[name]) capabilities[name] = observed[name];

  return {
    id: adapter.id,
    availability: AVAILABILITY.available,
    at: new Date().toISOString(),
    platform: process.platform,
    version: (version.output || '').trim().split('\n')[0]?.slice(0, 120) || null,
    cliPath,
    cli: cliIdentity(cliPath),
    capabilities,
    reason: null,
  };
}

module.exports = {
  STATE_DIR, CONFIG_FILE, VERIFICATION_FILE,
  resolveCli, candidateDirs, stateDir, cliIdentity, sameIdentity,
  loadConfig, loadVerification, saveVerification,
  inspect, discover, verify,
};
