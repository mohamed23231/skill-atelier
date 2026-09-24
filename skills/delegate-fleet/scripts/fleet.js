#!/usr/bin/env node
'use strict';

/**
 * delegate-fleet · fleet
 *
 * Everything about WHICH worker, and nothing about running one.
 *
 *   discover   what the framework supports, and what exists on this machine
 *   doctor     verify what the installed CLIs can really do; record evidence
 *   select     which available workers satisfy a set of required capabilities
 *   init       write a starter .delegate-fleet/config.json
 *
 * Supported is a property of this framework. Available is a property of this
 * machine. Verified is a property of the installed version. They are reported
 * separately and never conflated.
 */

const fs = require('node:fs');
const path = require('node:path');

const registryLib = require('./adapters/index.js');
const environment = require('./lib/environment.js');
const caps = require('./lib/capabilities.js');
const ledger = require('./lib/ledger.js');

const VERSION = '2.3.0';

const HELP = `
delegate-fleet fleet ${VERSION}

  node fleet.js discover [--workspace <dir>] [--json]
  node fleet.js doctor   [--backend <id>] [--workspace <dir>] [--json]
  node fleet.js select   --need <cap,cap> [--verified] [--max-tier <tier>] [--workspace <dir>] [--json]
  node fleet.js init     [--workspace <dir>]
  node fleet.js report   [--since <+24h|ISO>] [--workspace <dir>] [--json]
  node fleet.js quota    [--mark <id> --until <+2h|HH:MM|ISO> | --clear <id>] [--workspace <dir>] [--json]

Capabilities: ${caps.CAPABILITY_NAMES.join(', ')}
Backends supported by this framework (${registryLib.adapterIds().length}):
  ${registryLib.adapterIds().join(', ')}
Plus any adapter in <workspace>/.delegate-fleet/adapters/*.js

  discover  Reports every supported backend and whether its CLI is installed here.
            Never removes a backend for being absent.
  doctor    Runs each installed CLI's --help and records what it ACTUALLY supports
            into .delegate-fleet/verification.json. This is what promotes a
            "documented" capability to "verified" — and what demotes a wrong one.
  select    Lists the available workers that satisfy every capability you name.
            --verified restricts to capabilities proven on this machine.
            Results are ordered cheapest tier first (tiers come from
            workers.<id>.tier in config: ${environment.TIERS.join(' < ')});
            untiered workers come last. --max-tier drops pricier tiers.
  report    What delegated runs cost: runs, outcomes, tokens and USD per worker
            and per tier, from .delegate-fleet/runs/*/result.json. Self-reported
            usage, summed; a worker that reports nothing counts as unknown.
  quota     List workers marked out of quota, mark one (--mark), or clear one.
            Routes skip a marked worker until its time passes.
`;

function parse(argv) {
  const o = { cmd: argv[0] || 'help', workspace: process.cwd(), backend: null, need: [], json: false, verified: false, maxTier: null, since: null, mark: null, until: null, clear: null };
  const missing = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    // A missing value must be an error. Defaulting it silently turns
    // `doctor --backend` into a fleet-wide run, which is not what was asked.
    const value = () => {
      const v = argv[i + 1];
      // Do not consume the next token when it is itself an option, or the
      // option after this one would be misread as a stray positional.
      if (v === undefined || v.startsWith('--')) { missing.push(a); return null; }
      i += 1;
      return v;
    };
    if (a === '--json') o.json = true;
    else if (a === '--verified') o.verified = true;
    else if (a === '--workspace') { const v = value(); if (v !== null) o.workspace = path.resolve(v); }
    else if (a === '--backend') { const v = value(); if (v !== null) o.backend = v; }
    else if (a === '--max-tier') {
      const v = value();
      if (v !== null) {
        if (!environment.TIERS.includes(v)) return { error: `--max-tier must be one of ${environment.TIERS.join(', ')}`, ...o };
        o.maxTier = v;
      }
    } else if (a === '--since') { const v = value(); if (v !== null) o.since = v; }
    else if (a === '--mark') { const v = value(); if (v !== null) o.mark = v; }
    else if (a === '--until') { const v = value(); if (v !== null) o.until = v; }
    else if (a === '--clear') { const v = value(); if (v !== null) o.clear = v; }
    else if (a === '--need') { const v = value(); if (v !== null) o.need = v.split(',').map((s) => s.trim()).filter(Boolean); }
    else if (a === '--help' || a === '-h') o.cmd = 'help';
    else return { error: `unknown option "${a}"`, ...o };
  }
  if (missing.length) return { error: `${missing.join(', ')} requires a value`, ...o };
  return o;
}

function loadViews(workspace) {
  const config = environment.loadConfig(workspace);
  const verification = environment.loadVerification(workspace);
  const local = registryLib.loadLocalAdapters(workspace);
  const registry = registryLib.buildRegistry(local.loaded);
  const adapters = [...registry.values()];
  return {
    config, verification, registry, adapterErrors: local.errors,
    views: environment.discover(adapters, { repoRoot: workspace, config, verification }),
  };
}

function stateMark(state) {
  return { verified: 'verified  ', documented: 'documented', unsupported: 'no        ', unknown: 'unknown   ' }[state] || state;
}

function cmdDiscover(o) {
  const { views, config, adapterErrors } = loadViews(o.workspace);
  if (o.json) { console.log(JSON.stringify({ workspace: o.workspace, backends: views, configErrors: config.errors, adapterErrors }, null, 2)); return 0; }

  const available = views.filter((v) => v.availability === caps.AVAILABILITY.available);
  const absent = views.filter((v) => v.availability !== caps.AVAILABILITY.available);

  console.log(`delegate-fleet · ${views.length} backends supported by this framework\n`);
  console.log(`AVAILABLE HERE (${available.length}) — installed on this machine`);
  for (const v of available) {
    const local = v.localVerification ? `verified ${v.localVerification.at.slice(0, 10)}` : 'not verified locally — run doctor';
    console.log(`  ${v.id.padEnd(9)} ${String(v.cliPath).padEnd(52)} ${local}`);
    console.log(`            ${caps.CAPABILITY_NAMES.map((n) => `${n}=${v.capabilities[n]}`).join('  ')}`);
  }
  console.log(`\nSUPPORTED, NOT INSTALLED HERE (${absent.length}) — still fully supported; install the CLI to use them`);
  for (const v of absent) console.log(`  ${v.id.padEnd(9)} ${v.cli.padEnd(16)} ${v.docs}`);
  if (config.errors.length) {
    console.log('\nCONFIG ERRORS in .delegate-fleet/config.json:');
    for (const e of config.errors) console.log(`  - ${e}`);
  }
  if (adapterErrors && adapterErrors.length) {
    console.log('\nPROJECT ADAPTER ERRORS in .delegate-fleet/adapters/:');
    for (const e of adapterErrors) console.log(`  - ${e}`);
  }
  console.log('\nNext: node scripts/fleet.js doctor   (records what the installed versions really support)');
  return 0;
}

function cmdDoctor(o) {
  const { config, verification, registry, adapterErrors } = loadViews(o.workspace);
  if (config.errors.length || (adapterErrors && adapterErrors.length)) {
    const errs = [...config.errors, ...(adapterErrors || [])];
    if (o.json) {
      console.log(JSON.stringify({ error: 'broken configuration or adapter', errors: errs }, null, 2));
    } else {
      console.error('doctor: refusing to run with broken configuration or adapters:');
      for (const e of errs) console.error(`  - ${e}`);
    }
    return 2;
  }

  const all = [...registry.values()];
  const targets = o.backend ? all.filter((a) => a.id === o.backend) : all;
  if (o.backend && targets.length === 0) { console.error(`unknown backend "${o.backend}"`); return 2; }
  void verification;

  const report = { schemaVersion: 1, at: new Date().toISOString(), platform: process.platform, backends: { ...(verification.backends || {}) } };
  const rows = [];

  for (const adapter of targets) {
    let res;
    try {
      res = environment.verify(adapter, { config, env: process.env });
    } catch (err) {
      res = {
        id: adapter.id,
        availability: caps.AVAILABILITY.available,
        capabilities: null,
        reason: `probe failed: ${err && err.message ? err.message : err}`,
      };
    }
    if (res.capabilities) {
      report.backends[adapter.id] = {
        at: res.at, platform: res.platform, version: res.version,
        cliPath: res.cliPath, cli: res.cli, capabilities: res.capabilities,
      };
    } else {
      // Verification was attempted and did not succeed. Keeping the previous
      // record would let evidence from an older CLI authorise a run against
      // whatever is installed now.
      delete report.backends[adapter.id];
    }
    rows.push({ id: adapter.id, ...res });
  }

  const file = environment.saveVerification(o.workspace, report);
  if (o.json) { console.log(JSON.stringify({ file, rows }, null, 2)); return 0; }

  console.log('delegate-fleet doctor — local capability verification\n');
  for (const r of rows) {
    if (!r.capabilities) { console.log(`  ${r.id.padEnd(9)} ${r.availability.padEnd(11)} ${r.reason || ''}`); continue; }
    const declared = registry.get(r.id).capabilities;
    const changes = caps.CAPABILITY_NAMES.filter((n) => r.capabilities[n] && r.capabilities[n] !== declared[n]);
    console.log(`  ${r.id.padEnd(9)} available   ${r.version || ''}`);
    console.log(`            ${caps.CAPABILITY_NAMES.map((n) => `${n}=${r.capabilities[n] || declared[n]}`).join('  ')}`);
    for (const n of changes) console.log(`            corrected ${n}: declared ${declared[n]} -> observed ${r.capabilities[n]}`);
  }
  console.log(`\nwrote ${file}`);
  return 0;
}

function cmdSelect(o) {
  if (o.need.length === 0) { console.error('select: --need <capability,...> is required'); return 2; }
  const unknown = o.need.filter((n) => !caps.CAPABILITY_NAMES.includes(n));
  if (unknown.length) { console.error(`select: unknown capability: ${unknown.join(', ')}. Known: ${caps.CAPABILITY_NAMES.join(', ')}`); return 2; }

  const { views, config, registry, adapterErrors } = loadViews(o.workspace);
  if (config.errors.length || (adapterErrors && adapterErrors.length)) {
    const errs = [...config.errors, ...(adapterErrors || [])];
    if (o.json) {
      console.log(JSON.stringify({ error: 'broken configuration or adapter', errors: errs }, null, 2));
    } else {
      console.error('select: refusing to run with broken configuration or adapters:');
      for (const e of errs) console.error(`  - ${e}`);
    }
    return 2;
  }
  if (o.verified) {
    for (const view of views) {
      if (view.availability !== caps.AVAILABILITY.available) continue;
      let fresh;
      try {
        fresh = environment.verify(registry.get(view.id), { config, env: process.env });
      } catch {
        fresh = { capabilities: null };
      }
      for (const name of o.need) view.capabilities[name] = fresh.capabilities?.[name] || 'unknown';
    }
  }
  const quota = ledger.loadQuota(o.workspace);
  // Capability is the hard filter; cost only orders what survives it. An
  // untiered worker is unranked, not cheap, so it sorts after every tiered one.
  const rank = (v) => (v.tier ? environment.TIERS.indexOf(v.tier) : environment.TIERS.length);
  const ceiling = o.maxTier ? environment.TIERS.indexOf(o.maxTier) : Infinity;
  const matches = views.filter((v) => {
    if (v.availability !== caps.AVAILABILITY.available) return false;
    if (o.maxTier && (!v.tier || rank(v) > ceiling)) return false;
    return o.need.every((n) => (o.verified ? caps.isVerified(v.capabilities[n]) : caps.claims(v.capabilities[n])));
  }).map((v, i) => ({ v, i })).sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i).map(({ v }) => v);

  if (o.json) {
    console.log(JSON.stringify({
      need: o.need, verifiedOnly: o.verified, maxTier: o.maxTier,
      matches: matches.map((m) => m.id),
      workers: matches.map((m) => ({ id: m.id, tier: m.tier, model: m.defaults.model, exhaustedUntil: ledger.exhaustedUntil(quota, m.id)?.until || null })),
    }, null, 2));
    return 0;
  }
  if (matches.length === 0) {
    console.log(`No available worker satisfies: ${o.need.join(', ')}${o.verified ? ' (verified only)' : ''}${o.maxTier ? ` at tier ${o.maxTier} or cheaper` : ''}`);
    console.log('That route is closed on this machine. Say so rather than substituting a worker that cannot do the job.');
    return 1;
  }
  console.log(`Workers that can do [${o.need.join(', ')}]${o.verified ? ' with locally verified evidence' : ''}, cheapest first:`);
  for (const m of matches) {
    const out = ledger.exhaustedUntil(quota, m.id);
    console.log(`  ${m.id.padEnd(9)} ${(m.tier || 'untiered').padEnd(9)} ${o.need.map((n) => `${n}=${m.capabilities[n]}`).join('  ')}${out ? `  OUT OF QUOTA until ${out.until}` : ''}`);
  }
  return 0;
}

function cmdInit(o) {
  const dir = environment.stateDir(o.workspace);
  const file = path.join(dir, environment.CONFIG_FILE);
  if (fs.existsSync(file)) { console.log(`already exists: ${file}`); return 0; }
  const { views } = loadViews(o.workspace);
  const workers = {};
  for (const v of views) if (v.availability === caps.AVAILABILITY.available) workers[v.id] = { model: null };
  // Only fields with a real consumer are ever written.
  for (const k of Object.keys(workers)) if (workers[k].model === null) delete workers[k].model;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    _readme: 'Optional per-worker defaults. Valid keys: cli, model, effort, timeoutSeconds, maxTurns, maxBudgetUsd, tier (cheap|standard|premium; orders fleet.js select). Any other key is rejected, because a field with no consumer is a lie.',
    workers,
  }, null, 2)}\n`);
  console.log(`wrote ${file}`);
  return 0;
}

/** Sum what the runs themselves reported. Unknown stays unknown, never zero. */
function aggregate(runs) {
  const blank = () => ({ runs: 0, completed: 0, blocked: 0, attempts: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0, unreported: 0, durationSeconds: 0 });
  const total = blank();
  const byBackend = {};
  const byTier = {};
  for (const r of runs) {
    const id = r.backend ? r.backend.id : 'unknown';
    const tier = (r.backend && r.backend.tier) || 'untiered';
    for (const bucket of [total, (byBackend[id] ||= blank()), (byTier[tier] ||= blank())]) {
      bucket.runs += 1;
      if (r.status === 'completed') bucket.completed += 1;
      if (r.blocked) bucket.blocked += 1;
      bucket.attempts += (r.execution && r.execution.attempts) || 1;
      bucket.durationSeconds += (r.execution && r.execution.durationSeconds) || 0;
      const u = r.worker && r.worker.usage;
      if (!u) { bucket.unreported += 1; continue; }
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'costUsd']) if (typeof u[k] === 'number') bucket[k] += u[k];
    }
  }
  const round = (b) => ({ ...b, costUsd: Math.round(b.costUsd * 1e4) / 1e4 });
  return {
    total: round(total),
    byBackend: Object.fromEntries(Object.entries(byBackend).map(([k, v]) => [k, round(v)])),
    byTier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, round(v)])),
  };
}

function cmdReport(o) {
  let sinceMs = null;
  if (o.since) {
    const m = String(o.since).match(/^\+?(\d+)([mhd])$/);
    sinceMs = m ? Date.now() - Number(m[1]) * { m: 60e3, h: 3600e3, d: ledger.DAY_MS }[m[2]] : Date.parse(o.since);
    if (!Number.isFinite(sinceMs)) { console.error('report: --since takes 24h, 7d, 90m or an ISO date'); return 2; }
  }
  const runs = ledger.loadRuns(o.workspace).filter((r) => sinceMs === null || Date.parse(r.execution.startedAt) >= sinceMs);
  const agg = aggregate(runs);
  if (o.json) { console.log(JSON.stringify({ since: sinceMs ? new Date(sinceMs).toISOString() : null, ...agg }, null, 2)); return 0; }
  if (runs.length === 0) { console.log('No delegated runs recorded in .delegate-fleet/runs/ yet.'); return 0; }
  const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const row = (name, b) => `  ${name.padEnd(12)} ${String(b.runs).padStart(4)} runs  ${String(b.completed).padStart(3)} ok  ${String(b.blocked).padStart(3)} blocked  ` +
    `in ${fmt(b.inputTokens).padStart(6)}  out ${fmt(b.outputTokens).padStart(6)}  cache ${fmt(b.cacheReadTokens).padStart(6)}  $${b.costUsd.toFixed(4)}` +
    `${b.unreported ? `  (${b.unreported} unreported)` : ''}`;
  console.log(`delegate-fleet report · ${runs.length} run(s)${sinceMs ? ` since ${new Date(sinceMs).toISOString()}` : ''} · usage is self-reported by each worker\n`);
  console.log('BY TIER');
  for (const [k, v] of Object.entries(agg.byTier)) console.log(row(k, v));
  console.log('\nBY WORKER');
  for (const [k, v] of Object.entries(agg.byBackend)) console.log(row(k, v));
  console.log(`\n${row('TOTAL', agg.total)}`);
  console.log('\nThis is what the workers spent. The orchestrator\'s own tokens are not visible here.');
  return 0;
}

function cmdQuota(o) {
  if (o.mark && o.clear) { console.error('quota: pass --mark or --clear, not both'); return 2; }
  if (o.mark) {
    if (!o.until) { console.error('quota: --mark needs --until <+2h|HH:MM|ISO>'); return 2; }
    const until = ledger.parseUntil(o.until);
    if (!until || until <= Date.now()) { console.error(`quota: --until "${o.until}" is not a future time`); return 2; }
    const rec = ledger.markExhausted(o.workspace, o.mark, until, 'marked by hand');
    if (o.json) console.log(JSON.stringify({ marked: o.mark, ...rec }, null, 2));
    else console.log(`${o.mark} marked out of quota until ${rec.until}; routes will skip it.`);
    return 0;
  }
  if (o.clear) {
    const had = ledger.clearExhausted(o.workspace, o.clear);
    if (o.json) console.log(JSON.stringify({ cleared: o.clear, wasMarked: had }, null, 2));
    else console.log(had ? `${o.clear} cleared.` : `${o.clear} was not marked.`);
    return 0;
  }
  const quota = ledger.loadQuota(o.workspace);
  const active = Object.entries(quota.backends).filter(([id]) => ledger.exhaustedUntil(quota, id));
  if (o.json) { console.log(JSON.stringify({ exhausted: Object.fromEntries(active) }, null, 2)); return 0; }
  if (active.length === 0) { console.log('No worker is marked out of quota.'); return 0; }
  for (const [id, rec] of active) console.log(`  ${id.padEnd(12)} until ${rec.until}${rec.reason ? `  (${rec.reason})` : ''}`);
  return 0;
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.error) { console.error(o.error); process.exit(2); }
  switch (o.cmd) {
    case 'discover': process.exit(cmdDiscover(o));
    case 'doctor': process.exit(cmdDoctor(o));
    case 'select': process.exit(cmdSelect(o));
    case 'init': process.exit(cmdInit(o));
    case 'report': process.exit(cmdReport(o));
    case 'quota': process.exit(cmdQuota(o));
    default: console.log(HELP); process.exit(0);
  }
}

if (require.main === module) main();
module.exports = { VERSION };
