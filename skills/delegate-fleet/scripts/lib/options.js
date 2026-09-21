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
const { claims, isVerified, isSafetyCritical } = require('./capabilities.js');

const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const DEFAULT_TIMEOUT_SECONDS = 1200;

const FLAGS_WITH_VALUES = new Set(['--backend', '--brief', '--model', '--effort', '--session', '--timeout', '--workspace', '--out-dir']);
const BOOLEAN_FLAGS = new Set(['--read-only', '--dry-run', '--json', '--help', '-h', '--version', '--allow-unverified']);

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

function parseArgs(argv) {
  const opts = {
    backend: null, brief: null, model: null, effort: null, session: null,
    timeoutSeconds: null, workspace: process.cwd(), outDir: null,
    readOnly: false, dryRun: false, json: false, help: false, version: false,
    allowUnverified: false,
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
        default: break;
      }
      continue;
    }

    if (BOOLEAN_FLAGS.has(arg)) {
      if (arg === '--read-only') opts.readOnly = true;
      else if (arg === '--dry-run') opts.dryRun = true;
      else if (arg === '--json') opts.json = true;
      else if (arg === '--version') opts.version = true;
      else if (arg === '--allow-unverified') opts.allowUnverified = true;
      else opts.help = true;
      continue;
    }

    errors.push(`unknown option "${arg}"`);
  }

  opts.mode = opts.readOnly ? 'read-only' : 'edit';
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
  return merged;
}

module.exports = {
  parseArgs, parseTimeout, validateAgainstCapabilities, applyDefaults,
  DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS,
};
