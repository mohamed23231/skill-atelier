#!/usr/bin/env node
'use strict';

/**
 * delegate-fleet smoke test against REAL worker CLIs.
 *
 * The contract tests use a stub worker, which proves the relay's logic but
 * not that a real CLI's argv, output format and permission mode still match
 * the adapter. This does: one tiny brief per installed backend, in a throwaway
 * repository, checked by a real gate.
 *
 * It spends real tokens, so it never runs in CI and never runs without --yes.
 *
 *   node tests/smoke.js --yes                         every installed backend
 *   node tests/smoke.js --yes --backend claude,codex  just these
 *   node tests/smoke.js --yes --config my-config.json use your models/tiers
 *   node tests/smoke.js                               list what WOULD run
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const registryLib = require('../scripts/adapters/index.js');
const environment = require('../scripts/lib/environment.js');
const capabilities = require('../scripts/lib/capabilities.js');

const RELAY = path.join(__dirname, '..', 'scripts', 'relay.js');

const BRIEF = `# Objective
Add a named export \`smokeOk\` to \`src/smoke.js\` that returns the string "ok".

## Context
This is an automated smoke test of the delegation relay. Keep the change minimal.

## Scope
- \`src/smoke.js\` — add and export the function

## Non-goals
- Do not create any other file.

## Acceptance criteria
1. \`src/smoke.js\` exports a function named \`smokeOk\`.
2. Calling \`smokeOk()\` returns exactly the string "ok".

## Verification
- The orchestrator runs the check afterwards.
`;

const CHECK = `${JSON.stringify(process.execPath)} -e "const m=require('./src/smoke.js'); if (typeof m.smokeOk!=='function'||m.smokeOk()!=='ok'){console.error('smokeOk missing or wrong');process.exit(1)}"`;

function parse(argv) {
  const o = { yes: false, backends: null, config: null, timeout: '600', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a === '--backend') o.backends = String(argv[++i] || '').split(',').filter(Boolean);
    else if (a === '--config') o.config = path.resolve(argv[++i] || '');
    else if (a === '--timeout') o.timeout = String(argv[++i] || '600');
    else { console.error(`unknown option ${a}`); process.exit(2); }
  }
  return o;
}

function tmpRepo(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-smoke-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'Smoke');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'smoke.js'), "'use strict';\n\nmodule.exports = {};\n");
  fs.writeFileSync(path.join(dir, '.gitignore'), '.delegate-fleet/\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  fs.mkdirSync(path.join(dir, '.delegate-fleet'));
  if (config) fs.copyFileSync(config, path.join(dir, '.delegate-fleet', 'config.json'));
  fs.writeFileSync(path.join(dir, '.delegate-fleet', 'brief.md'), BRIEF);
  return dir;
}

function main() {
  const o = parse(process.argv.slice(2));
  const probeRoot = o.config ? path.dirname(path.dirname(o.config)) : process.cwd();
  const config = o.config ? environment.loadConfig(path.dirname(path.dirname(o.config))) : { workers: {}, routes: {}, limits: { runsPer24h: {} }, errors: [] };
  const registry = registryLib.buildRegistry([]);
  const views = environment.discover([...registry.values()], { repoRoot: probeRoot, config, verification: { backends: {} } });
  const installed = views.filter((v) => v.availability === capabilities.AVAILABILITY.available && capabilities.claims(v.capabilities.edit));
  const targets = o.backends ? installed.filter((v) => o.backends.includes(v.id)) : installed;

  if (!o.yes) {
    console.log('delegate-fleet smoke test — spends real tokens on each backend below. Nothing ran.');
    for (const v of targets) console.log(`  ${v.id.padEnd(12)} ${v.cliPath}${v.defaults.model ? `  model ${v.defaults.model}` : '  (CLI default model)'}`);
    console.log('\nRun with --yes to dispatch. Pass --config <.delegate-fleet/config.json> to use your cheaper models.');
    return 0;
  }

  const rows = [];
  for (const v of targets) {
    const repo = tmpRepo(o.config);
    const res = spawnSync(process.execPath, [RELAY, '--backend', v.id, '--brief', path.join(repo, '.delegate-fleet', 'brief.md'),
      '--workspace', repo, '--check', CHECK, '--timeout', o.timeout, '--json'], { encoding: 'utf8', timeout: (Number(o.timeout) + 120) * 1000 });
    let r = null;
    try { r = JSON.parse(res.stdout); } catch { /* reported below */ }
    const check = r && r.verification && r.verification.checks[0];
    rows.push({
      backend: v.id,
      ok: Boolean(r && r.status === 'completed' && !r.blocked),
      status: r ? r.status : 'relay-crashed',
      reason: r ? r.reason : (res.stderr || '').trim().split('\n').pop(),
      check: check ? (check.passed ? 'pass' : check.passed === false ? 'FAIL' : 'skipped') : '—',
      findings: r ? r.findings.map((f) => f.type) : [],
      reportSource: r && r.worker ? r.worker.source : null,
      usage: r && r.worker ? r.worker.usage : null,
      seconds: r && r.execution ? r.execution.durationSeconds : null,
      repo,
    });
    const last = rows[rows.length - 1];
    if (!o.json) {
      console.log(`${last.ok ? 'PASS' : 'FAIL'}  ${v.id.padEnd(12)} ${last.status.padEnd(20)} check ${last.check.padEnd(7)} report ${String(last.reportSource).padEnd(10)} ` +
        `${last.usage && last.usage.costUsd != null ? `$${last.usage.costUsd}` : 'cost n/a'}  ${last.seconds ?? '?'}s${last.ok ? '' : `  ${last.reason || last.findings.join(',')}`}`);
    }
    if (last.ok) fs.rmSync(repo, { recursive: true, force: true });
  }
  if (o.json) console.log(JSON.stringify(rows, null, 2));
  else if (rows.some((r) => !r.ok)) console.log('\nFailed runs keep their repository for inspection (see "repo" in --json).');
  // `report: structured` is what proves the output parser works on this CLI.
  return rows.every((r) => r.ok) ? 0 : 1;
}

process.exit(main());
