#!/usr/bin/env node
'use strict';

/**
 * delegate-fleet A/B benchmark.
 *
 * The claim this skill makes is economic: the expensive model plans and
 * reviews, cheaper workers spend the tokens, and the result is as good. That
 * claim needs numbers, including the ones that go against it. This runs each
 * task twice from the same fixture:
 *
 *   solo   the orchestrator model does the task itself
 *   fleet  the same model, told to delegate through delegate-fleet
 *
 * and scores both with acceptance tests the agents never see (copied in only
 * after the run). Cost comes from each CLI's own JSON: the orchestrator's
 * `total_cost_usd`, plus the workers' self-reported usage summed by
 * `fleet.js report`.
 *
 * The orchestrator is Claude Code (`claude -p`), the only orchestrator wired
 * here. It spends real money: nothing runs without --yes.
 *
 *   node bench/bench.js                                  list the plan, spend nothing
 *   node bench/bench.js --yes --fleet-config my.json     run every task, both arms
 *   node bench/bench.js --yes --tasks rename,multi --arms fleet --repeat 3
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const SKILL = path.resolve(HERE, '..');
const FIXTURE = path.join(HERE, 'fixture');
const TASKS = path.join(HERE, 'tasks');
const ARMS = ['solo', 'fleet'];

const FLEET_INSTRUCTIONS = `

Work as an orchestrator using the delegate-fleet skill in .claude/skills/delegate-fleet.
Plan the change yourself, then delegate every implementation slice to a worker through its relay
(prefer --route with --check and --fix-attempts, or batch.js for independent slices). Do not edit
source files yourself. Review each result, then leave the accepted changes in the working tree.`;

function parse(argv) {
  const o = { yes: false, tasks: null, arms: ARMS, repeat: 1, model: 'opus', fleetConfig: null, timeout: 1800, out: null, keep: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--yes') o.yes = true;
    else if (a === '--keep') o.keep = true;
    else if (a === '--tasks') o.tasks = String(v() || '').split(',').filter(Boolean);
    else if (a === '--arms') o.arms = String(v() || '').split(',').filter(Boolean);
    else if (a === '--repeat') o.repeat = Number(v());
    else if (a === '--model') o.model = v();
    else if (a === '--fleet-config') o.fleetConfig = path.resolve(v() || '');
    else if (a === '--timeout') o.timeout = Number(v());
    else if (a === '--out') o.out = path.resolve(v() || '');
    else errors.push(`unknown option ${a}`);
  }
  if (o.arms.some((x) => !ARMS.includes(x))) errors.push(`--arms takes ${ARMS.join(',')}`);
  if (!Number.isInteger(o.repeat) || o.repeat < 1 || o.repeat > 10) errors.push('--repeat must be 1-10');
  if (!Number.isInteger(o.timeout) || o.timeout < 60) errors.push('--timeout must be at least 60 seconds');
  if (o.arms.includes('fleet') && o.yes && (!o.fleetConfig || !fs.existsSync(o.fleetConfig))) {
    errors.push('the fleet arm needs --fleet-config <config.json> naming your workers, tiers and routes');
  }
  return { o, errors };
}

/** Every task directory with a prompt and an acceptance test. */
function loadTasks(only) {
  const all = fs.readdirSync(TASKS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const tasks = [];
  for (const id of only || all) {
    const dir = path.join(TASKS, id);
    const prompt = path.join(dir, 'task.md');
    const accept = path.join(dir, 'accept.test.js');
    if (!fs.existsSync(prompt) || !fs.existsSync(accept)) throw new Error(`task "${id}" needs task.md and accept.test.js`);
    tasks.push({ id, prompt: fs.readFileSync(prompt, 'utf8').trim(), accept });
  }
  return tasks;
}

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** A fresh, committed copy of the fixture. The fleet arm also gets the skill and a config. */
function prepareRepo(arm, fleetConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `df-bench-${arm}-`));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'bench@example.com');
  git(dir, 'config', 'user.name', 'Bench');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), '.claude/\n.delegate-fleet/\n');
  if (arm === 'fleet') {
    const skillDest = path.join(dir, '.claude', 'skills', 'delegate-fleet');
    fs.mkdirSync(path.dirname(skillDest), { recursive: true });
    fs.cpSync(SKILL, skillDest, { recursive: true, filter: (src) => !src.startsWith(HERE) && !src.includes(`${path.sep}tests${path.sep}`) });
    fs.mkdirSync(path.join(dir, '.delegate-fleet'), { recursive: true });
    fs.copyFileSync(fleetConfig, path.join(dir, '.delegate-fleet', 'config.json'));
  }
  return dir;
}

/** Copy the hidden acceptance test in, run the whole suite, report pass/fail. */
function score(dir, accept) {
  fs.copyFileSync(accept, path.join(dir, 'test', 'zz-accept.test.js'));
  const r = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  const pass = (r.stdout.match(/^ℹ pass (\d+)/m) || [])[1];
  const fail = (r.stdout.match(/^ℹ fail (\d+)/m) || [])[1];
  return { accepted: r.status === 0, tests: { pass: Number(pass || 0), fail: Number(fail || 0) } };
}

function runOne(task, arm, o) {
  const dir = prepareRepo(arm, o.fleetConfig);
  const prompt = arm === 'fleet' ? `${task.prompt}${FLEET_INSTRUCTIONS}` : task.prompt;
  const started = Date.now();
  const r = spawnSync('claude', ['-p', prompt, '--model', o.model, '--output-format', 'json', '--permission-mode', 'acceptEdits'], {
    cwd: dir, encoding: 'utf8', timeout: o.timeout * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  let orch = null;
  try { orch = JSON.parse(r.stdout); } catch { /* reported as unknown cost */ }
  let workers = { costUsd: 0, runs: 0, unreported: 0 };
  if (arm === 'fleet') {
    const rep = spawnSync(process.execPath, [path.join(SKILL, 'scripts', 'fleet.js'), 'report', '--workspace', dir, '--json'], { encoding: 'utf8' });
    try { const t = JSON.parse(rep.stdout).total; workers = { costUsd: t.costUsd, runs: t.runs, unreported: t.unreported }; } catch { /* none */ }
  }
  const s = score(dir, task.accept);
  const orchCost = orch && typeof orch.total_cost_usd === 'number' ? orch.total_cost_usd : null;
  const row = {
    task: task.id, arm, accepted: s.accepted, tests: s.tests,
    orchestratorCostUsd: orchCost,
    orchestratorTokens: orch && orch.usage ? { input: orch.usage.input_tokens, output: orch.usage.output_tokens, cacheRead: orch.usage.cache_read_input_tokens } : null,
    workerCostUsd: workers.costUsd, workerRuns: workers.runs, workerRunsUnreported: workers.unreported,
    totalCostUsd: orchCost == null ? null : Math.round((orchCost + workers.costUsd) * 1e4) / 1e4,
    seconds: Math.round((Date.now() - started) / 1000),
    exit: r.status, dir,
  };
  if (!o.keep && s.accepted) fs.rmSync(dir, { recursive: true, force: true });
  return row;
}

function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const b = (by[r.arm] ||= { runs: 0, accepted: 0, orchestratorCostUsd: 0, workerCostUsd: 0, totalCostUsd: 0, unknownCost: 0 });
    b.runs += 1;
    if (r.accepted) b.accepted += 1;
    if (r.totalCostUsd == null) { b.unknownCost += 1; continue; }
    b.orchestratorCostUsd += r.orchestratorCostUsd;
    b.workerCostUsd += r.workerCostUsd;
    b.totalCostUsd += r.totalCostUsd;
  }
  for (const b of Object.values(by)) {
    for (const k of ['orchestratorCostUsd', 'workerCostUsd', 'totalCostUsd']) b[k] = Math.round(b[k] * 1e4) / 1e4;
    b.costPerAcceptedUsd = b.accepted ? Math.round((b.totalCostUsd / b.accepted) * 1e4) / 1e4 : null;
  }
  return by;
}

function main() {
  const { o, errors } = parse(process.argv.slice(2));
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  const tasks = loadTasks(o.tasks);
  const plan = tasks.flatMap((t) => o.arms.flatMap((arm) => Array.from({ length: o.repeat }, (_, i) => ({ task: t.id, arm, run: i + 1 }))));
  if (!o.yes) {
    console.log(`delegate-fleet bench — ${plan.length} run(s), orchestrator model "${o.model}". Spends real money; nothing ran.`);
    for (const p of plan) console.log(`  ${p.task.padEnd(10)} ${p.arm.padEnd(6)} #${p.run}`);
    console.log('\nRun with --yes --fleet-config <config.json>. See bench/README.md for how to publish results honestly.');
    return 0;
  }
  const rows = [];
  for (const p of plan) {
    const task = tasks.find((t) => t.id === p.task);
    process.stderr.write(`[bench] ${p.task} ${p.arm} #${p.run} … `);
    const row = runOne(task, p.arm, o);
    rows.push(row);
    process.stderr.write(`${row.accepted ? 'accepted' : 'REJECTED'}  $${row.totalCostUsd ?? '?'}  ${row.seconds}s\n`);
  }
  const out = { at: new Date().toISOString(), model: o.model, repeat: o.repeat, summary: summarize(rows), rows };
  const file = o.out || path.join(process.cwd(), `bench-${out.at.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out.summary, null, 2));
  console.log(`\nfull results: ${file}`);
  return 0;
}

if (require.main === module) process.exit(main());
module.exports = { loadTasks, score, summarize, prepareRepo, FIXTURE };
