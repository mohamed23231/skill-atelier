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

/**
 * Cost tiers, cheapest first. A tier is a property of how YOU run a worker
 * (which model, which plan), not of the CLI: `opencode` on a local model is
 * cheap and on a frontier model is premium. So it lives in config, never in
 * an adapter, and an untiered worker is simply unranked.
 */
const TIERS = Object.freeze(['cheap', 'standard', 'premium']);
const MAX_FIX_ATTEMPTS = 3;
const ROUTE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** Keys a route candidate may set; each overrides the worker's own default. */
const ROUTE_KEYS = ['backend', 'model', 'effort', 'timeoutSeconds', 'maxTurns', 'maxBudgetUsd', 'fixAttempts'];
const TOP_LEVEL_KEYS = ['_readme', 'workers', 'routes', 'limits'];

const positiveInt = (v) => Number.isInteger(Number(v)) && Number(v) > 0 && typeof v !== 'boolean';

/**
 * Validate the per-run fields shared by a worker entry and a route candidate.
 * Returns the cleaned entry; pushes one error per bad field.
 */
function readRunFields(cfg, where, errors) {
  const entry = {};
  for (const key of ['model', 'effort']) {
    if (cfg[key] === undefined) continue;
    if (typeof cfg[key] !== 'string' || !cfg[key].trim()) errors.push(`${where}.${key}: expected a non-empty string`);
    else entry[key] = cfg[key].trim();
  }
  for (const key of ['timeoutSeconds', 'maxTurns']) {
    if (cfg[key] === undefined) continue;
    if (!positiveInt(cfg[key])) errors.push(`${where}.${key}: expected a positive integer`);
    else entry[key] = Number(cfg[key]);
  }
  if (cfg.maxBudgetUsd !== undefined) {
    const n = Number(cfg.maxBudgetUsd);
    if (!Number.isFinite(n) || n <= 0 || typeof cfg.maxBudgetUsd === 'boolean') errors.push(`${where}.maxBudgetUsd: expected a positive number`);
    else entry.maxBudgetUsd = n;
  }
  if (cfg.fixAttempts !== undefined) {
    const n = Number(cfg.fixAttempts);
    if (!Number.isInteger(n) || n < 0 || n > MAX_FIX_ATTEMPTS || typeof cfg.fixAttempts === 'boolean') {
      errors.push(`${where}.fixAttempts: expected an integer from 0 to ${MAX_FIX_ATTEMPTS}`);
    } else entry.fixAttempts = n;
  }
  return entry;
}

/**
 * Routes: a task class the orchestrator names, mapped to an ordered list of
 * candidates. The model classifies the slice; code owns the flags. The first
 * candidate that is installed, capable, under its limit and not exhausted wins.
 */
function readRoutes(raw, errors) {
  const routes = {};
  if (raw === undefined) return routes;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${CONFIG_FILE}: "routes" must be an object keyed by task class`);
    return routes;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!ROUTE_NAME.test(name)) { errors.push(`routes.${name}: a route name must be lowercase letters, digits and hyphens`); continue; }
    const list = Array.isArray(value) ? value : [value];
    if (list.length === 0) { errors.push(`routes.${name}: needs at least one candidate`); continue; }
    const candidates = [];
    list.forEach((c, i) => {
      const where = `routes.${name}[${i}]`;
      if (!c || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${where}: expected an object`); return; }
      if (typeof c.backend !== 'string' || !c.backend.trim()) { errors.push(`${where}.backend: required`); return; }
      for (const key of Object.keys(c)) {
        if (!ROUTE_KEYS.includes(key)) errors.push(`${where}.${key}: unknown option; this field would be silently ignored`);
      }
      candidates.push({ backend: c.backend.trim(), ...readRunFields(c, where, errors) });
    });
    routes[name] = candidates;
  }
  return routes;
}

/** Limits: how many runs each tier may start in any rolling 24 hours. */
function readLimits(raw, errors) {
  const limits = { runsPer24h: {} };
  if (raw === undefined) return limits;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push(`${CONFIG_FILE}: "limits" must be an object`);
    return limits;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'runsPer24h') errors.push(`limits.${key}: unknown option; this field would be silently ignored`);
  }
  const per = raw.runsPer24h;
  if (per === undefined) return limits;
  if (per === null || typeof per !== 'object' || Array.isArray(per)) {
    errors.push('limits.runsPer24h: expected an object keyed by tier');
    return limits;
  }
  for (const [tier, n] of Object.entries(per)) {
    if (!TIERS.includes(tier)) errors.push(`limits.runsPer24h.${tier}: expected one of ${TIERS.join(', ')}`);
    else if (!Number.isInteger(n) || n < 0) errors.push(`limits.runsPer24h.${tier}: expected a non-negative integer`);
    else limits.runsPer24h[tier] = n;
  }
  return limits;
}
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
  const empty = { workers, routes: {}, limits: { runsPer24h: {} } };
  if (read.error) return { ...empty, errors: [`${CONFIG_FILE}: could not be read as JSON (${read.error})`] };
  const raw = read.value;
  if (read.present && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    return { ...empty, errors: [`${CONFIG_FILE}: expected a JSON object at the top level`] };
  }
  const rawWorkers = raw && raw.workers !== undefined ? raw.workers : {};
  if (rawWorkers === null || typeof rawWorkers !== 'object' || Array.isArray(rawWorkers)) {
    return { ...empty, errors: [`${CONFIG_FILE}: "workers" must be an object keyed by backend id`] };
  }
  for (const key of Object.keys(raw || {})) {
    if (!TOP_LEVEL_KEYS.includes(key)) errors.push(`${CONFIG_FILE}: unknown top-level key "${key}"; it would be silently ignored`);
  }
  for (const [id, cfg] of Object.entries(rawWorkers)) {
    if (!cfg || typeof cfg !== 'object') { errors.push(`workers.${id}: expected an object`); continue; }
    const entry = {};
    if (cfg.cli !== undefined) {
      if (typeof cfg.cli !== 'string' || !cfg.cli.trim()) errors.push(`workers.${id}.cli: expected a non-empty string`);
      else entry.cli = cfg.cli.trim();
    }
    Object.assign(entry, readRunFields(cfg, `workers.${id}`, errors));
    if (cfg.tier !== undefined) {
      if (!TIERS.includes(cfg.tier)) errors.push(`workers.${id}.tier: expected one of ${TIERS.join(', ')}`);
      else entry.tier = cfg.tier;
    }
    // Any other key is a field with no consumer: reject it rather than let it
    // look meaningful. This is the class of bug that made v1 untrustworthy.
    for (const key of Object.keys(cfg)) {
      if (!['cli', 'model', 'effort', 'timeoutSeconds', 'maxTurns', 'maxBudgetUsd', 'tier', 'fixAttempts'].includes(key)) {
        errors.push(`workers.${id}.${key}: unknown option; this field would be silently ignored`);
      }
    }
    workers[id] = entry;
  }
  const routes = readRoutes(raw ? raw.routes : undefined, errors);
  const limits = readLimits(raw ? raw.limits : undefined, errors);
  return { workers, routes, limits, errors };
}

/** Locally recorded capability evidence, written by `fleet.js doctor`. */
function loadVerification(repoRoot) {
  const file = path.join(stateDir(repoRoot), VERIFICATION_FILE);
  const read = readJson(file);
  if (!read.present) return { backends: {} };
  if (read.error) {
    return {
      backends: {},
      warning: `the verification record (${VERIFICATION_FILE}) could not be read (${read.error}); nothing is verified as a result`,
    };
  }
  const raw = read.value;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      backends: {},
      warning: `the verification record (${VERIFICATION_FILE}) could not be read (expected a JSON object); nothing is verified as a result`,
    };
  }
  const backends = raw && typeof raw.backends === 'object' && !Array.isArray(raw.backends) ? raw.backends : {};
  return { ...raw, backends };
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
    tier: cfg.tier || null,
    availability: resolved ? AVAILABILITY.available : AVAILABILITY.unavailable,
    declaredCapabilities: { ...adapter.capabilities },
    capabilities: applyLocalEvidence(adapter.capabilities, local && local.capabilities),
    localVerification: local ? { at: local.at, version: local.version, platform: local.platform } : null,
    staleVerification: staleFor ? { recordedFor: staleFor, nowResolvesTo: resolved } : null,
    defaults: {
      model: cfg.model || null,
      effort: cfg.effort || null,
      timeoutSeconds: cfg.timeoutSeconds || null,
      maxTurns: cfg.maxTurns ?? null,
      maxBudgetUsd: cfg.maxBudgetUsd ?? null,
      fixAttempts: cfg.fixAttempts ?? null,
    },
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
  const hasEvidence = Boolean(helpText.trim() || extra.some((e) => e && e.trim()));
  if (!hasEvidence) {
    return { id: adapter.id, availability: AVAILABILITY.available, capabilities: null, reason: 'the CLI produced no --help output to verify against' };
  }
  // A probe reads help text, which says what flags exist -- not what this
  // adapter passes. Clamp it so a probe can never promote a capability the
  // invocation would silently drop.
  let observed;
  try {
    observed = clampToExpressible(adapter.probe(helpText, { extra }) || {}, adapter);
  } catch (err) {
    return {
      id: adapter.id,
      availability: AVAILABILITY.available,
      capabilities: null,
      reason: `probe failed: ${err && err.message ? err.message : err}`,
    };
  }
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
  STATE_DIR, CONFIG_FILE, VERIFICATION_FILE, TIERS, MAX_FIX_ATTEMPTS, ROUTE_KEYS,
  resolveCli, candidateDirs, stateDir, cliIdentity, sameIdentity,
  loadConfig, loadVerification, saveVerification,
  inspect, discover, verify,
};
