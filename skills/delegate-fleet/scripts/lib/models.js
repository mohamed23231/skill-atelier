'use strict';

/**
 * Model selection against the live catalog.
 *
 * A model id pinned in config goes stale the week a vendor ships a new one. A
 * worker or route may instead name a model FAMILY, resolved at dispatch from
 * the list the installed CLI itself prints:
 *
 *   "model": { "latest": "gemini-*-flash-low", "min": "3.7", "deny": ["preview"] }
 *
 *   latest  a pattern with exactly one `*`. Every catalog id it matches is a
 *           candidate, and the text the `*` stood for is the version.
 *   min     optional floor, compared against that version.
 *   deny    optional substrings; a candidate containing any of them is out.
 *
 * The highest version wins. Versions compare as dotted numbers ("3.10" beats
 * "3.9"), so no date or lexical accident picks an older model.
 */

const { probeCommand } = require('./exec.js');

const SPEC_KEYS = ['latest', 'min', 'deny'];
const CATALOG_TIMEOUT_MS = 30_000;

/** Validate a model spec from config. Returns the cleaned spec, or pushes errors. */
function readSpec(raw, where, errors) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { errors.push(`${where}: expected a model id or { latest, min?, deny? }`); return null; }
  for (const k of Object.keys(raw)) if (!SPEC_KEYS.includes(k)) errors.push(`${where}.${k}: unknown option; this field would be silently ignored`);
  if (typeof raw.latest !== 'string' || (raw.latest.match(/\*/g) || []).length !== 1) {
    errors.push(`${where}.latest: expected a pattern with exactly one "*" standing for the version, e.g. "gemini-*-flash"`);
    return null;
  }
  const spec = { latest: raw.latest.trim() };
  if (raw.min !== undefined) {
    if (typeof raw.min !== 'string' || !/\d/.test(raw.min)) errors.push(`${where}.min: expected a version string such as "3.7"`);
    else spec.min = raw.min.trim();
  }
  if (raw.deny !== undefined) {
    if (!Array.isArray(raw.deny) || !raw.deny.every((d) => typeof d === 'string' && d.trim())) errors.push(`${where}.deny: expected an array of non-empty strings`);
    else spec.deny = raw.deny.map((d) => d.trim());
  }
  return spec;
}

const isSpec = (m) => Boolean(m) && typeof m === 'object' && typeof m.latest === 'string';

/** Human-readable form, for warnings and dry runs. */
function describe(spec) {
  return `${spec.latest}${spec.min ? ` >= ${spec.min}` : ''}${spec.deny && spec.deny.length ? ` excluding ${spec.deny.join(', ')}` : ''}`;
}

function versionParts(v) { return (String(v).match(/\d+/g) || []).map(Number); }

function compareVersions(a, b) {
  const x = versionParts(a); const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

function escapeRe(s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Pick the newest catalog id matching the spec. Pure.
 * Returns { model, version, candidates } or { error }.
 */
function pick(spec, catalog) {
  const [pre, post] = spec.latest.split('*');
  const re = new RegExp(`^${escapeRe(pre)}(.+?)${escapeRe(post)}$`);
  const deny = spec.deny || [];
  const candidates = [];
  for (const id of catalog) {
    const m = re.exec(id);
    if (!m || !/\d/.test(m[1])) continue;
    if (deny.some((d) => id.includes(d))) continue;
    if (spec.min && compareVersions(m[1], spec.min) < 0) continue;
    candidates.push({ id, version: m[1] });
  }
  if (!candidates.length) return { error: `no model in the live catalog matches ${describe(spec)}` };
  candidates.sort((a, b) => compareVersions(b.version, a.version) || a.id.localeCompare(b.id));
  return { model: candidates[0].id, version: candidates[0].version, candidates: candidates.map((c) => c.id) };
}

const cache = new Map();

/** The installed CLI's model list, once per process. */
function catalog(adapter, cliPath, env = process.env) {
  if (!adapter.listModels) return { error: `"${adapter.id}" has no way to list its models, so a model family cannot be resolved; name an exact model` };
  const key = `${cliPath}\u0000${adapter.listModels.args.join(' ')}`;
  if (cache.has(key)) return cache.get(key);
  const res = probeCommand(cliPath, adapter.listModels.args, CATALOG_TIMEOUT_MS, env);
  let out;
  if (!res.ok) out = { error: `\`${adapter.cli} ${adapter.listModels.args.join(' ')}\` failed (${res.error}); the model family could not be resolved` };
  else {
    let ids = [];
    try { ids = adapter.listModels.parse(res.output || '') || []; } catch (err) { ids = []; out = { error: `could not parse the ${adapter.id} model list: ${err.message}` }; }
    if (!out) out = ids.length ? { ids } : { error: `\`${adapter.cli} ${adapter.listModels.args.join(' ')}\` listed no models` };
  }
  cache.set(key, out);
  return out;
}

/** Resolve a spec for one worker. Returns { model, detail } or { error }. */
function resolve(spec, adapter, cliPath, env) {
  const cat = catalog(adapter, cliPath, env);
  if (cat.error) return { error: cat.error };
  const p = pick(spec, cat.ids);
  if (p.error) return { error: p.error };
  return { model: p.model, detail: `model ${describe(spec)} resolved to ${p.model} from the live ${adapter.id} catalog (${p.candidates.length} match${p.candidates.length === 1 ? '' : 'es'})` };
}

module.exports = { readSpec, isSpec, describe, compareVersions, pick, catalog, resolve, SPEC_KEYS };
