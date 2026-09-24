'use strict';

/**
 * Option parsing and validation.
 *
 * Two hard rules, both of which v1 broke:
 *   1. Every option either affects execution or is rejected. Nothing is parsed
 *      and quietly dropped.
 *   2. An option is only accepted when the chosen backend can actually honour
 *      it, and a SAFETY-CRITICAL capability must be verified on this machine —
 *      not merely documented — before the relay will rely on it.
 */

const path = require('node:path');
const checksLib = require('./checks.js');
const { claims, isVerified, isSafetyCritical } = require('./capabilities.js');

const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_TIMEOUT_SECONDS = 1200;
const MAX_TURNS = 10_000;
const MAX_BUDGET_USD = 100_000;
const MAX_FIX_ATTEMPTS = 3;

const FLAGS_WITH_VALUES = new Set([
  '--backend', '--brief', '--model', '--effort', '--session', '--timeout',
  '--workspace', '--out-dir', '--max-turns', '--max-budget-usd',
  '--check', '--check-timeout', '--route', '--fix-attempts', '--state-root',
]);
const BOOLEAN_FLAGS = new Set([
  '--read-only', '--dry-run', '--json', '--help', '-h', '--version', '--allow-unverified',
  '--stream',
]);

/** Strictly a positive, finite, whole number of seconds. */
function parseTimeout(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { error: '--timeout requires a value in seconds' };
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return { error: `--timeout must be a whole number of seconds, got "${text}"` };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { error: `--timeout must be a positive integer, got "${text}"` };
  }
  if (n > MAX_TIMEOUT_SECONDS) {
    return { error: `--timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds, got ${n}` };
  }
  return { value: n };
}

/** Strictly a positive, finite, whole number of turns. */
function parseMaxTurns(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { error: '--max-turns requires a positive integer' };
  }
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    return { error: `--max-turns must be a positive integer, got "${text}"` };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return { error: `--max-turns must be a positive integer, got "${text}"` };
  }
  if (n > MAX_TURNS) {
    return { error: `--max-turns must be at most ${MAX_TURNS}, got ${n}` };
  }
  return { value: n };
}

/** Strictly a positive, finite number in USD (decimals accepted). */
function parseMaxBudgetUsd(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { error: '--max-budget-usd requires a positive number' };
  }
  const text = String(raw).trim();
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(text)) {
    return { error: `--max-budget-usd must be a positive number, got "${text}"` };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `--max-budget-usd must be a positive number, got "${text}"` };
  }
  if (n > MAX_BUDGET_USD) {
    return { error: `--max-budget-usd must be at most ${MAX_BUDGET_USD}, got ${n}` };
  }
  return { value: n };
}

function parseArgs(argv) {
  const opts = {
    backend: null, brief: null, model: null, effort: null, session: null,
    timeoutSeconds: null, maxTurns: null, maxBudgetUsd: null,
    workspace: process.cwd(), outDir: null, stream: false,
    readOnly: false, dryRun: false, json: false, help: false, version: false,
    allowUnverified: false,
    checks: [], checkTimeoutSeconds: null, route: null, fixAttempts: null, stateRoot: null,
  };
  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-')) { errors.push(`unexpected positional argument "${arg}"`); continue; }

    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) { errors.push(`${arg} requires a value`); continue; }
      switch (arg) {
        case '--backend': opts.backend = value; break;
        case '--brief': opts.brief = value; break;
        case '--model': opts.model = value; break;
        case '--effort': opts.effort = value; break;
        case '--session': opts.session = value; break;
        case '--workspace': opts.workspace = path.resolve(value); break;
        case '--out-dir': opts.outDir = path.resolve(value); break;
        case '--timeout': {
          const t = parseTimeout(value);
          if (t.error) errors.push(t.error); else opts.timeoutSeconds = t.value;
          break;
        }
        case '--max-turns': {
          const t = parseMaxTurns(value);
          if (t.error) errors.push(t.error); else opts.maxTurns = t.value;
          break;
        }
        case '--check': {
          const t = checksLib.tokenize(value);
          if (t.error) errors.push(t.error);
          else if (opts.checks.length >= checksLib.MAX_CHECKS) errors.push(`at most ${checksLib.MAX_CHECKS} --check commands per run`);
          else opts.checks.push({ command: value, argv: t.argv });
          break;
        }
        case '--route': opts.route = value; break;
        case '--state-root': opts.stateRoot = path.resolve(value); break;
        case '--fix-attempts': {
          const text = String(value).trim();
          if (!/^\d+$/.test(text) || Number(text) > MAX_FIX_ATTEMPTS) errors.push(`--fix-attempts must be an integer from 0 to ${MAX_FIX_ATTEMPTS}, got "${text}"`);
          else opts.fixAttempts = Number(text);
          break;
        }
        case '--check-timeout': {
          const t = parseTimeout(value);
          if (t.error) errors.push(t.error.replace('--timeout', '--check-timeout'));
          else opts.checkTimeoutSeconds = t.value;
          break;
        }
        case '--max-budget-usd': {
          const b = parseMaxBudgetUsd(value);
          if (b.error) errors.push(b.error); else opts.maxBudgetUsd = b.value;
          break;
        }
        default: break;
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--read-only') opts.readOnly = true;
      else if (arg === '--dry-run') opts.dryRun = true;
      else if (arg === '--json') opts.json = true;
      else if (arg === '--stream') opts.stream = true;
      else if (arg === '--version') opts.version = true;
      else if (arg === '--allow-unverified') opts.allowUnverified = true;
      else opts.help = true;
      continue;
    }

    errors.push(`unknown option "${arg}"`);
  }

  opts.mode = opts.readOnly ? 'read-only' : 'edit';
  // Checks judge an implementation. A read-only run produced none, and running
  // arbitrary commands inside an analysis run would undo its whole point.
  if (opts.readOnly && opts.checks.length) errors.push('--check cannot be combined with --read-only');
  if (opts.checkTimeoutSeconds != null && opts.checks.length === 0) errors.push('--check-timeout was passed without any --check');
  // A fix attempt is driven by failing checks; without one there is nothing to fix against.
  if (opts.fixAttempts > 0 && opts.checks.length === 0) errors.push('--fix-attempts needs at least one --check to fix against');
  if (opts.route && opts.backend) errors.push('pass --route or --backend, not both');
  return { opts, errors };
}

/**
 * Check the request against what this backend can really do here.
 * Returns hard errors (refuse to dispatch) and soft warnings (dispatch, but
 * say the claim is only documented).
 */
function validateAgainstCapabilities(opts, view) {
  const errors = [];
  const warnings = [];
  const caps = view.capabilities;

  const need = (capability, because) => {
    const state = caps[capability];
    if (!claims(state)) {
      errors.push(`backend "${view.id}" does not support ${capability} (${state}), required because ${because}`);
      return;
    }
    if (isSafetyCritical(capability) && !isVerified(state)) {
      if (opts.allowUnverified) {
        warnings.push(`${capability} on "${view.id}" is ${state}, not verified on this machine; proceeding only because --allow-unverified was passed`);
      } else {
        errors.push(
          `${capability} on "${view.id}" is "${state}", not verified on this machine. ` +
          `A read-only guarantee that has not been checked here is not a guarantee. ` +
          `Run: node scripts/fleet.js doctor --backend ${view.id}   (or pass --allow-unverified to accept the risk)`
        );
      }
      return;
    }
    if (!isVerified(state)) {
      warnings.push(`${capability} on "${view.id}" is ${state}, not verified on this machine; the flag may not behave as described`);
    }
  };

  if (opts.mode === 'read-only') need('readOnly', 'the run was requested with --read-only');
  else need('edit', 'this is an implementation run');

  if (opts.model) need('modelSelection', '--model was passed');
  if (opts.effort) need('effort', '--effort was passed');
  if (opts.session) need('resumeById', '--session was passed');
  if (opts.maxTurns) need('turnLimit', '--max-turns was passed');
  if (opts.maxBudgetUsd) need('budgetLimit', '--max-budget-usd was passed');

  return { errors, warnings };
}

/** Merge configured defaults under explicit flags. Explicit always wins. */
function applyDefaults(opts, view) {
  const merged = { ...opts };
  if (!merged.model && view.defaults.model) merged.model = view.defaults.model;
  if (!merged.effort && view.defaults.effort) merged.effort = view.defaults.effort;
  if (merged.timeoutSeconds == null) {
    merged.timeoutSeconds = view.defaults.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
  }
  if (merged.maxTurns == null && view.defaults.maxTurns != null) {
    merged.maxTurns = view.defaults.maxTurns;
  }
  if (merged.maxBudgetUsd == null && view.defaults.maxBudgetUsd != null) {
    merged.maxBudgetUsd = view.defaults.maxBudgetUsd;
  }
  if (merged.fixAttempts == null) merged.fixAttempts = view.defaults.fixAttempts ?? 0;
  // A configured default only applies when there is something to fix against.
  if (!merged.checks || merged.checks.length === 0) merged.fixAttempts = 0;
  return merged;
}

module.exports = {
  parseArgs, parseTimeout, parseMaxTurns, parseMaxBudgetUsd, validateAgainstCapabilities, applyDefaults,
  DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MAX_TURNS, MAX_BUDGET_USD, MAX_FIX_ATTEMPTS,
};
