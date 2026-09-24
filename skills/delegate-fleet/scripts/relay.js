#!/usr/bin/env node
'use strict';

/**
 * delegate-fleet · relay
 *
 * The trust boundary between the orchestrator and a worker.
 *
 * It dispatches one bounded brief to one worker, watches the process, and
 * reports facts: what the process did, and what the repository did. It makes
 * no quality judgement, never verifies the work, and never commits. Those
 * belong to the orchestrator.
 *
 * Trust posture: no dependencies, no network calls of its own, no telemetry,
 * no credential handling. It spawns exactly two kinds of process — `git` for
 * read-only status, and the worker CLI you named — always with an argv array
 * and never through a shell.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registryLib = require('./adapters/index.js');
const capabilities = require('./lib/capabilities.js');
const environment = require('./lib/environment.js');
const options = require('./lib/options.js');
const briefLib = require('./lib/brief.js');
const repo = require('./lib/repo.js');
const exec = require('./lib/exec.js');
const contract = require('./lib/contract.js');
const report = require('./lib/report.js');
const checksLib = require('./lib/checks.js');
const ledger = require('./lib/ledger.js');

const VERSION = '2.3.0';
/** Worker stdout larger than this is not parsed for a report; the log keeps it all. */
const REPORT_READ_CAP_BYTES = 32 * 1024 * 1024;

const HELP = `
delegate-fleet relay ${VERSION}

  node relay.js --backend <id> --brief <file.md> [options]
  node relay.js --route <class> --brief <file.md> [options]

Required
  --backend <id>        Worker to dispatch to. ${registryLib.adapterIds().length} supported;
                        run: node fleet.js discover   to see which exist here.
  --route <class>       Or: a task class from config "routes". The first candidate that is
                        installed, capable, under its tier limit and not out of quota runs.
  --brief <file>        The task brief. Linted before anything is dispatched.

Run shape
  --read-only           Analysis run. Requires a backend whose read-only mode is
                        VERIFIED on this machine; the prompt alone is not a guarantee.
  --model <id>          Model for this run. Rejected if the backend cannot select one.
  --effort <level>      Reasoning effort. Rejected if the backend has no such control.
  --session <id>        Resume a prior run by id. Rejected if the backend cannot.
  --max-turns <n>       Turn cap. Rejected if the backend cannot cap turns.
  --max-budget-usd <n>  Spend cap in USD. Rejected if the backend cannot cap budget.
  --timeout <seconds>   Watchdog, positive integer, default ${options.DEFAULT_TIMEOUT_SECONDS}, max ${options.MAX_TIMEOUT_SECONDS}.
  --workspace <dir>     Repository the worker runs in (default: cwd).

Checks (edit runs only; run after the worker, only when it completed)
  --check "<command>"   A project gate to run in the workspace, e.g. --check "pnpm test".
                        Repeatable. No shell: pipes and && are rejected; use a script.
                        A failing check blocks the result. Full output goes to an
                        artifact; the result carries only the tail.
  --check-timeout <s>   Watchdog per check, default ${checksLib.DEFAULT_CHECK_TIMEOUT_SECONDS}.
  --fix-attempts <n>    0-${options.MAX_FIX_ATTEMPTS}. When checks fail on a clean completed run, re-run the SAME
                        worker with only the failing tails, up to n times. Stops at any finding.

Output
  --stream              Tee worker stdout and stderr to relay stderr as they arrive.
  --out-dir <dir>       Where run artifacts go (default: <workspace>/.delegate-fleet/runs/<stamp>).
  --state-root <dir>    Where quota marks and run history are kept (default: the workspace).
  --dry-run             Print the exact argv and the lint result. Dispatch nothing.
  --json                Print only the result JSON.
  --allow-unverified    Proceed when a safety-critical capability is merely documented.
  --version, --help

Exit codes
  0  completed with no outstanding findings
  1  dispatched, but the result is blocked (failure, or a finding to review)
  2  invalid request — nothing was dispatched
`;

function fail(result, opts) {
  emit(result, opts);
  process.exit(contract.PRE_DISPATCH.has(result.status) ? 2 : 1);
}

function emit(result, opts) {
  if (opts && opts.json) { console.log(JSON.stringify(result, null, 2)); return; }
  console.log(render(result));
}

function render(r) {
  const lines = [];
  lines.push(`[relay] ${r.status}${r.reason ? ` — ${r.reason}` : ''}`);
  if (r.backend) lines.push(`[relay] worker: ${r.backend.id}${r.backend.tier ? ` [${r.backend.tier}]` : ''} (${r.backend.cliPath || r.backend.cli}) · mode ${r.request.mode}`);
  if (r.route) lines.push(`[relay] route: ${r.route.name} -> ${r.route.chosen}${r.route.skipped.length ? ` (skipped ${r.route.skipped.map((x) => x.backend).join(', ')})` : ''}`);
  if (r.attempts && r.attempts.length > 1) {
    lines.push(`[relay] attempts: ${r.attempts.map((a) => `#${a.attempt} ${a.status}${a.checksFailed.length ? ` (${a.checksFailed.length} check(s) failing)` : ''}`).join(' -> ')}`);
  }
  if (r.execution) {
    lines.push(`[relay] process: exit ${r.execution.exitCode}${r.execution.signal ? ` signal ${r.execution.signal}` : ''} in ${r.execution.durationSeconds}s`);
  }
  if (r.repository && r.repository.observed) {
    const c = r.repository.changed;
    lines.push(`[relay] repository: +${c.created.length} ~${c.modified.length} -${c.deleted.length} renamed ${c.renamed.length} · in-scope ${r.repository.scope.inScope.length}, out-of-scope ${r.repository.scope.outOfScope.length}`);
    if (r.repository.preExisting.length) {
      lines.push(`[relay] pre-existing dirty files at dispatch: ${r.repository.preExisting.length} (untouched unless a finding says otherwise)`);
    }
  } else if (r.repository) {
    lines.push(`[relay] repository: NOT OBSERVED — ${r.repository.reason}`);
  }
  for (const w of r.warnings) lines.push(`[relay] warning: ${w}`);
  for (const f of r.findings) {
    lines.push(`[relay] FINDING ${f.type}: ${f.detail}`);
    for (const p of f.paths.slice(0, 20)) lines.push(`           ${p}`);
    if (f.paths.length > 20) lines.push(`           … ${f.paths.length - 20} more`);
  }
  const checks = (r.verification && r.verification.checks) || [];
  for (const c of checks) {
    const state = c.passed === true ? 'pass' : c.passed === false ? 'FAIL' : 'skipped';
    lines.push(`[relay] check ${state}: ${c.command}${c.exitCode != null ? ` (exit ${c.exitCode}, ${c.durationSeconds}s)` : ''}`);
    // A failure is only actionable with its reason; the full log stays an artifact.
    if (c.passed === false && c.tail) for (const l of c.tail.split('\n').slice(-10)) lines.push(`           ${l}`);
  }
  if (r.worker && r.worker.usage) {
    const u = r.worker.usage;
    const parts = [];
    if (u.inputTokens != null) parts.push(`in ${u.inputTokens}`);
    if (u.outputTokens != null) parts.push(`out ${u.outputTokens}`);
    if (u.cacheReadTokens != null) parts.push(`cache-read ${u.cacheReadTokens}`);
    if (u.costUsd != null) parts.push(`$${u.costUsd}`);
    lines.push(`[relay] worker usage (self-reported): ${parts.join(' · ')}`);
  }
  if (r.worker && r.worker.summary) {
    lines.push('[relay] worker says (self-reported, not verified):');
    for (const l of r.worker.summary.split('\n').slice(-15)) lines.push(`           ${l}`);
  }
  if (r.artifacts) lines.push(`[relay] artifacts: ${r.artifacts.dir}`);
  if (!r.execution) {
    // Nothing was dispatched, so there is no diff to send anyone to read.
    lines.push('[relay] nothing was dispatched — fix the request and try again.');
  } else {
    lines.push(r.blocked
      ? '[relay] BLOCKED — the orchestrator must read the diff and decide: accept, retry, or escalate.'
      : '[relay] not blocked — still the orchestrator\'s job to review the diff and run the project gates.');
  }
  return lines.join('\n');
}

const ROUTE_OVERRIDES = ['model', 'effort', 'timeoutSeconds', 'maxTurns', 'maxBudgetUsd', 'fixAttempts'];

/**
 * Decide whether ONE backend can take this request on this machine: installed,
 * capable of everything asked, under its tier's budget, not out of quota.
 * Pure with respect to the repository; it may re-probe the CLI for read-only.
 */
function planWorker({ adapter, opts, config, verification, routeEntry, quota, runs }) {
  const warnings = [];
  const view = environment.inspect(adapter, { repoRoot: opts.workspace, config, verification, env: process.env });
  if (routeEntry) {
    // A route candidate's settings beat the worker's own defaults; explicit
    // flags still beat both (applyDefaults only fills what is unset).
    for (const k of ROUTE_OVERRIDES) if (routeEntry[k] !== undefined) view.defaults[k] = routeEntry[k];
  }
  if (view.availability !== capabilities.AVAILABILITY.available) {
    return { view, unavailable: `its CLI ("${view.cli}") is not installed on this machine` };
  }
  // Defaults must be folded in BEFORE the capability check, or a model or
  // effort supplied by config reaches the invocation without ever being
  // checked against what this backend can honour.
  const effective = options.applyDefaults(opts, view);
  let freshVerifiedReadOnly = false;
  if (effective.mode === 'read-only') {
    // verification.json lives in the worker's writable workspace and can be
    // edited by hand or by a previous worker. Re-probe the installed CLI at
    // the trust boundary; the saved record alone cannot authorize read-only.
    const fresh = environment.verify(adapter, { config, env: process.env });
    const observed = fresh.capabilities?.readOnly || 'unknown';
    view.capabilities.readOnly = observed === 'unknown' && opts.allowUnverified &&
      capabilities.claims(view.capabilities.readOnly) ? 'documented' : observed;
    if (view.capabilities.readOnly === 'verified') freshVerifiedReadOnly = true;
    else warnings.push('saved verification was not accepted as read-only proof; a fresh CLI probe did not verify it');
  }
  if (view.staleVerification) {
    // Not fatal: the merged view already dropped the record, so anything
    // safety-critical fails the capability gate on its own. Say why.
    warnings.push(
      `local verification for "${adapter.id}" was recorded for ${view.staleVerification.recordedFor} ` +
      `but the CLI now resolves to ${view.staleVerification.nowResolvesTo}; that evidence was discarded. ` +
      `Run: node scripts/fleet.js doctor --backend ${adapter.id}`
    );
  }
  const capCheck = options.validateAgainstCapabilities(effective, view);
  if (capCheck.errors.length) return { view, errors: capCheck.errors, warnings };
  const limit = view.tier ? config.limits.runsPer24h[view.tier] : undefined;
  const used = limit !== undefined ? ledger.runsInLastDay(runs(), view.tier) : 0;
  return {
    view, effective, freshVerifiedReadOnly,
    warnings: [...warnings, ...capCheck.warnings],
    exhausted: ledger.exhaustedUntil(quota, adapter.id),
    overLimit: limit !== undefined && used >= limit ? { tier: view.tier, limit, used } : null,
  };
}

async function main() {
  const { opts, errors: argErrors } = options.parseArgs(process.argv.slice(2));

  if (opts.help || process.argv.length <= 2) { console.log(HELP); return; }
  if (opts.version) { console.log(VERSION); return; }

  const request = {
    backend: opts.backend, route: opts.route, brief: opts.brief, mode: opts.mode,
    model: opts.model, effort: opts.effort, session: opts.session,
    maxTurns: opts.maxTurns, maxBudgetUsd: opts.maxBudgetUsd,
    workspace: opts.workspace, readOnly: opts.readOnly,
  };

  const capWarnings = [];

  const invalid = (reason, extra = []) => fail(contract.preDispatchResult({
    status: contract.STATUS.INVALID_REQUEST,
    reason: [reason, ...extra].join('; '),
    request, backend: null,
    warnings: capWarnings,
  }), opts);

  if (argErrors.length) invalid('invalid arguments', argErrors);
  if (!opts.backend && !opts.route) invalid('--backend or --route is required');
  if (!opts.brief) invalid('--brief is required');

  if (!fs.existsSync(opts.workspace)) invalid(`--workspace does not exist: ${opts.workspace}`);

  // Built-ins plus any adapter the project supplies in .delegate-fleet/adapters/.
  const local = registryLib.loadLocalAdapters(opts.workspace);
  const registry = registryLib.buildRegistry(local.loaded);
  if (local.errors.length) invalid('a project adapter failed to load', local.errors);

  const config = environment.loadConfig(opts.workspace);
  if (config.errors.length) invalid('invalid .delegate-fleet/config.json', config.errors);
  const verification = environment.loadVerification(opts.workspace);
  if (verification.warning) capWarnings.push(verification.warning);
  // Quota marks and the run history can live in another checkout: a batch runs
  // each slice in its own worktree but keeps one ledger in the main one.
  const stateRoot = opts.stateRoot || opts.workspace;
  const quota = ledger.loadQuota(stateRoot);
  let runsCache = null;
  const runs = () => (runsCache ||= ledger.loadRuns(stateRoot));

  // ---- choose the worker ---------------------------------------------------
  let adapter;
  let plan;
  let routeInfo = null;
  if (opts.route) {
    const candidates = config.routes[opts.route];
    if (!candidates) {
      const known = Object.keys(config.routes);
      invalid(`unknown route "${opts.route}"`, [known.length ? `configured routes: ${known.join(', ')}` : 'no routes are configured in .delegate-fleet/config.json']);
    }
    const skipped = [];
    let allUnavailable = true;
    for (let i = 0; i < candidates.length; i++) {
      const entry = candidates[i];
      const a = registryLib.getAdapter(entry.backend, registry);
      if (!a) { skipped.push({ backend: entry.backend, reason: 'unknown backend' }); allUnavailable = false; continue; }
      const p = planWorker({ adapter: a, opts, config, verification, routeEntry: entry, quota, runs });
      if (p.unavailable) { skipped.push({ backend: a.id, reason: p.unavailable }); continue; }
      allUnavailable = false;
      if (p.errors) { skipped.push({ backend: a.id, reason: p.errors.join('; ') }); continue; }
      if (p.exhausted) { skipped.push({ backend: a.id, reason: `out of quota until ${p.exhausted.until}` }); continue; }
      if (p.overLimit) { skipped.push({ backend: a.id, reason: `${p.overLimit.tier} tier used ${p.overLimit.used} of ${p.overLimit.limit} runs in the last 24h` }); continue; }
      adapter = a; plan = p;
      routeInfo = { name: opts.route, chosen: a.id, candidate: i, skipped };
      break;
    }
    if (!adapter) {
      const detail = skipped.map((x) => `${x.backend}: ${x.reason}`);
      if (allUnavailable) {
        fail(contract.preDispatchResult({
          status: contract.STATUS.BACKEND_UNAVAILABLE,
          reason: `no candidate for route "${opts.route}" is installed on this machine (${detail.join('; ')})`,
          request, backend: null, warnings: capWarnings,
        }), opts);
      }
      invalid(`no candidate for route "${opts.route}" can take this run`, detail);
    }
    if (skipped.length) capWarnings.push(`route "${opts.route}" fell through to ${adapter.id}: ${skipped.map((x) => `${x.backend} (${x.reason})`).join('; ')}`);
  } else {
    adapter = registryLib.getAdapter(opts.backend, registry);
    if (!adapter) invalid(`unknown backend "${opts.backend}". Supported: ${registryLib.adapterIds(registry).join(', ')}`);
    plan = planWorker({ adapter, opts, config, verification, routeEntry: null, quota, runs });
    // Say why evidence was discarded even when the request is then refused.
    if (plan.errors) capWarnings.push(...plan.warnings);
    // Supported everywhere; available only where the CLI actually is.
    if (plan.unavailable) {
      fail(contract.preDispatchResult({
        status: contract.STATUS.BACKEND_UNAVAILABLE,
        reason: `"${adapter.id}" is supported by this framework but ${plan.unavailable}`,
        request, backend: { id: adapter.id, cli: plan.view.cli, cliPath: null },
        warnings: capWarnings,
      }), opts);
    }
    if (plan.errors) invalid('the request asks for capabilities this worker does not have here', plan.errors);
    if (plan.overLimit) {
      invalid(`the ${plan.overLimit.tier} tier has used ${plan.overLimit.used} of its ${plan.overLimit.limit} runs in the last 24 hours`,
        [`raise limits.runsPer24h.${plan.overLimit.tier} in .delegate-fleet/config.json, or pick a cheaper worker`]);
    }
    if (plan.exhausted) {
      // Named explicitly, so it is the orchestrator's call; say what is known.
      capWarnings.push(`"${adapter.id}" was marked out of quota until ${plan.exhausted.until}${plan.exhausted.reason ? ` (${plan.exhausted.reason})` : ''}; dispatching because it was named explicitly`);
    }
  }
  const { view, effective, freshVerifiedReadOnly } = plan;
  if (!plan.errors) capWarnings.push(...plan.warnings);

  // ---- the brief -------------------------------------------------------------
  const briefPath = path.resolve(opts.brief);
  if (!fs.existsSync(briefPath)) invalid(`brief not found: ${briefPath}`);
  let briefText;
  try {
    briefText = fs.readFileSync(briefPath, 'utf8');
  } catch (err) {
    invalid(`could not read brief at "${briefPath}"`, [err.message]);
  }
  const lint = briefLib.lint(briefText);
  if (!lint.ok) invalid('the brief failed the quality gate before any worker was paid', lint.errors);

  const prompt = briefLib.buildPrompt({ briefText, mode: effective.mode, scope: lint.scope });
  const oversize = briefLib.promptTooLarge(prompt);
  if (oversize) invalid(`brief renders to ${oversize} bytes, over the ${briefLib.MAX_PROMPT_BYTES}-byte argv budget; split the slice`);

  // How this CLI wants the brief: in argv, on stdin, or as a file it reads.
  const delivery = adapter.promptDelivery || 'argv';
  const buildFor = (text, promptFile) => adapter.build({
    prompt: text, mode: effective.mode, model: effective.model,
    effort: effective.effort, session: effective.session,
    maxTurns: effective.maxTurns, maxBudgetUsd: effective.maxBudgetUsd,
    cwd: effective.workspace, promptFile,
  });
  const command = view.cliPath;
  const warnings = [...capWarnings, ...lint.warnings];

  if (opts.dryRun) {
    const built = buildFor(prompt, delivery === 'file' ? path.join(os.tmpdir(), 'delegate-fleet-dry-run', 'brief.md') : null);
    const dry = {
      dryRun: true, backend: adapter.id, cli: view.cli, cliPath: view.cliPath, tier: view.tier,
      route: routeInfo,
      mode: effective.mode, command, args: built.args,
      promptDelivery: delivery,
      capabilities: view.capabilities, declaredCapabilities: view.declaredCapabilities,
      localVerification: view.localVerification,
      effective: {
        model: effective.model, effort: effective.effort, session: effective.session,
        timeoutSeconds: effective.timeoutSeconds,
        maxTurns: effective.maxTurns, maxBudgetUsd: effective.maxBudgetUsd,
        fixAttempts: effective.fixAttempts,
      },
      brief: { path: briefPath, scope: lint.scope, warnings: lint.warnings },
      checks: opts.checks.map((c) => ({ command: c.command, argv: c.argv })),
      warnings,
    };
    console.log(JSON.stringify(dry, null, 2));
    return;
  }

  // ---- dispatch -----------------------------------------------------------
  // The relay is synchronous by design; running it in the background is the
  // orchestrator's job. There is deliberately no daemon mode or poller.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = path.basename(briefPath).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 60);
  // pid keeps two concurrent runs of the same brief from sharing a directory.
  // runs/ is excluded from every snapshot, so writing here mid-run is safe.
  const outDir = effective.outDir || path.join(effective.workspace, environment.STATE_DIR, 'runs', `${stamp}-${adapter.id}-${slug}-${process.pid}`);
  const streamOut = (chunk) => { try { process.stderr.write(chunk); } catch { /* best effort */ } };

  /** One worker process: deliver the prompt, capture live logs, copy them to `dir`. */
  async function runWorker(text, dir) {
    let promptFile = null;
    if (delivery === 'file') {
      promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-fleet-')), 'brief.md');
      fs.writeFileSync(promptFile, text, { mode: 0o600 });
    }
    const built = buildFor(text, promptFile);
    const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-fleet-live-'));
    const liveStdout = path.join(liveDir, 'stdout.log');
    const liveStderr = path.join(liveDir, 'stderr.log');
    fs.writeFileSync(liveStdout, '');
    fs.writeFileSync(liveStderr, '');
    if (!opts.json) {
      console.log(`[relay] dispatching ${adapter.id} (${view.cliPath}) · mode ${effective.mode} · timeout ${effective.timeoutSeconds}s · live log: ${liveStdout}`);
    }
    let execResult;
    try {
      execResult = await exec.run({
        command, args: built.args, cwd: effective.workspace,
        env: process.env, timeoutSeconds: effective.timeoutSeconds,
        stdin: delivery === 'stdin' ? text : null,
        onStdout: (c) => { try { fs.appendFileSync(liveStdout, c); } catch { /* best effort */ } if (opts.stream) streamOut(c); },
        onStderr: (c) => { try { fs.appendFileSync(liveStderr, c); } catch { /* best effort */ } if (opts.stream) streamOut(c); },
      });
    } finally {
      // Remove only the private temp dir this relay created; never touch the repo.
      if (promptFile) { try { fs.rmSync(path.dirname(promptFile), { recursive: true, force: true }); } catch { /* best effort */ } }
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [live, name, mem] of [[liveStdout, 'stdout.log', execResult.stdout], [liveStderr, 'stderr.log', execResult.stderr]]) {
      const dest = path.join(dir, name);
      try { fs.copyFileSync(live, dest); } catch { /* fall back below */ }
      if (execResult.truncated || !fs.existsSync(dest)) fs.writeFileSync(dest, mem);
    }
    try { fs.rmSync(liveDir, { recursive: true, force: true }); } catch { /* best effort */ }
    fs.writeFileSync(path.join(dir, 'command.json'), `${JSON.stringify({ command, args: built.args, cwd: effective.workspace }, null, 2)}\n`);
    // The worker's own account, parsed from the full log rather than the
    // capped in-memory copy: the final result object sits at the END.
    let rawStdout = execResult.stdout;
    try {
      const logPath = path.join(dir, 'stdout.log');
      if (fs.statSync(logPath).size <= REPORT_READ_CAP_BYTES) rawStdout = fs.readFileSync(logPath, 'utf8');
    } catch { /* keep the in-memory copy */ }
    return { execResult, worker: report.extract(rawStdout, adapter) };
  }

  const before = repo.snapshot(effective.workspace);
  let prev = before;
  let findings = [];
  const attempts = [];
  const usageTotal = {};
  let status; let reason; let execResult; let worker; let diff = null; let scopeReport = null;
  let checkResults = [];
  let attemptDir = outDir;
  let currentPrompt = prompt;
  const observedAll = () => before.ok && prev.ok;

  for (let n = 0; n <= effective.fixAttempts; n++) {
    attemptDir = n === 0 ? outDir : path.join(outDir, `attempt-${n + 1}`);
    const ran = await runWorker(currentPrompt, attemptDir);
    execResult = ran.execResult;
    worker = ran.worker;
    const after = repo.snapshot(effective.workspace);

    // Cumulative facts are always measured against the ORIGINAL baseline, so
    // pre-existing work stays pre-existing across every attempt. No path is
    // filtered out: excluding .delegate-fleet/ wholesale would hide a worker
    // planting an adapter that the NEXT run loads with require().
    let stepDiff = null;
    if (before.ok && after.ok) {
      diff = repo.diffSnapshots(before, after);
      scopeReport = repo.reconcileScope(repo.changedPaths(diff), lint.scope);
      stepDiff = n === 0 ? diff : (prev.ok ? repo.diffSnapshots(prev, after) : null);
    } else {
      diff = null; scopeReport = null;
    }
    prev = after;
    const stepFindings = contract.deriveFindings({ mode: effective.mode, diff, scopeReport });
    findings = mergeFindings(findings, stepFindings);
    const derived = contract.deriveStatus({ execResult, mode: effective.mode, diff: stepDiff, denyPatterns: adapter.denyPatterns });
    status = derived.status; reason = derived.reason;
    if (derived.warning) warnings.push(derived.warning);
    for (const [k, v] of Object.entries((worker && worker.usage) || {})) if (typeof v === 'number') usageTotal[k] = (usageTotal[k] || 0) + v;

    // Out of quota is a fact about the account, not the task: remember it so
    // routes skip this worker for a while. It never changes the status.
    if (status !== contract.STATUS.COMPLETED && status !== contract.STATUS.NOOP) {
      const hit = ledger.matchesQuota(`${execResult.stdout}\n${execResult.stderr}`);
      if (hit) {
        const until = Date.now() + ledger.DEFAULT_COOLDOWN_MINUTES * 60e3;
        try { ledger.markExhausted(stateRoot, adapter.id, until, `output matched ${hit}`); } catch { /* best effort */ }
        worker = { ...worker, quotaExhausted: true };
        warnings.push(`"${adapter.id}" looks out of quota (output matched ${hit}); marked exhausted for ${ledger.DEFAULT_COOLDOWN_MINUTES} minutes. Clear with: node scripts/fleet.js quota --clear ${adapter.id}`);
      }
    }

    // A fix attempt that changed nothing leaves the previous attempt's work
    // and its failing checks in place. That is still a completed run.
    if (n > 0 && status === contract.STATUS.NOOP) {
      status = contract.STATUS.COMPLETED; reason = null;
      warnings.push(`fix attempt ${n} changed nothing; the previous attempt's work and check results stand`);
      attempts.push(attemptRecord(n, 'noop', execResult, worker, checkResults, attemptDir));
      break;
    }

    // Checks run only on a completed edit run: on anything else the tree is
    // not a candidate for acceptance, and running gates would only spend time.
    checkResults = [];
    if (opts.checks.length) {
      if (status !== contract.STATUS.COMPLETED) {
        checkResults = opts.checks.map((c) => ({ command: c.command, outcome: 'skipped', exitCode: null, passed: null, durationSeconds: 0, tail: '', log: null }));
        warnings.push(`checks were skipped because the run status is ${status}`);
      } else {
        checkResults = await checksLib.runAll({
          checks: opts.checks, cwd: effective.workspace, env: process.env,
          timeoutSeconds: effective.checkTimeoutSeconds, outDir: attemptDir,
          onOutput: opts.stream ? streamOut : null,
        });
        // A check that rewrites files (a formatter, a snapshot update) changes
        // what the orchestrator is about to review. Say so; never undo it.
        const afterChecks = repo.snapshot(effective.workspace);
        if (after.ok && afterChecks.ok) {
          const moved = repo.changedPaths(repo.diffSnapshots(after, afterChecks));
          if (moved.length) {
            warnings.push(`the checks themselves changed ${moved.length} path(s) after the worker finished: ${moved.slice(0, 10).join(', ')}${moved.length > 10 ? ', …' : ''}`);
          }
        }
        prev = afterChecks;
      }
    }
    attempts.push(attemptRecord(n, status, execResult, worker, checkResults, attemptDir));

    // Loop only while it is safe and useful: the run completed, nothing needs
    // a human decision, and a check the orchestrator named still fails.
    const failing = checkResults.filter((c) => c.passed === false);
    if (n >= effective.fixAttempts || status !== contract.STATUS.COMPLETED || findings.length || failing.length === 0) break;
    const ownPaths = scopeReport ? scopeReport.inScope : [];
    const next = briefLib.buildFixPrompt({
      briefText, scope: lint.scope, attempt: n + 1, failures: failing, ownPaths,
      previousSummary: worker && worker.summary,
    });
    if (briefLib.promptTooLarge(next)) { warnings.push('the fix prompt would exceed the argv budget; stopping the fix loop'); break; }
    if (!opts.json) console.log(`[relay] ${failing.length} check(s) failed; fix attempt ${n + 1} of ${effective.fixAttempts}`);
    currentPrompt = next;
  }

  const observed = observedAll();
  if (!observed) {
    warnings.push(`repository facts unavailable (${before.reason || prev.reason}); scope, noop and commit detection are all disabled for this run`);
  }
  if (worker && Object.keys(usageTotal).length && attempts.length > 1) {
    worker = { ...worker, usage: { ...worker.usage, ...usageTotal, costUsd: usageTotal.costUsd == null ? null : Math.round(usageTotal.costUsd * 1e6) / 1e6 }, usageAcrossAttempts: true };
  }

  const result = contract.buildResult({
    status, reason, findings, warnings,
    request: {
      ...request, backend: adapter.id, mode: effective.mode, model: effective.model,
      effort: effective.effort, session: effective.session,
      maxTurns: effective.maxTurns, maxBudgetUsd: effective.maxBudgetUsd,
      timeoutSeconds: effective.timeoutSeconds, briefPath,
      checks: opts.checks.map((c) => c.command),
      fixAttempts: effective.fixAttempts,
    },
    route: routeInfo,
    backend: {
      id: adapter.id, cli: view.cli, cliPath: view.cliPath, tier: view.tier,
      capabilities: view.capabilities,
      capabilitiesVerifiedLocally: Boolean(view.localVerification) || freshVerifiedReadOnly,
    },
    execution: {
      exitCode: execResult.exitCode, signal: execResult.signal,
      outcome: execResult.outcome, startedAt: new Date(attempts.length ? attempts[0].startedAt : execResult.startedAt).toISOString(),
      durationSeconds: attempts.reduce((sum, a) => sum + a.durationSeconds, 0),
      outputTruncated: execResult.truncated,
      attempts: attempts.length,
    },
    attempts: attempts.map(({ startedAt, ...rest }) => rest),
    repository: observed && diff ? {
      observed: true,
      changed: { created: diff.created, modified: diff.modified, deleted: diff.deleted, renamed: diff.renamed },
      scope: { declared: scopeReport.declared, inScope: scopeReport.inScope, outOfScope: scopeReport.outOfScope },
      preExisting: diff.preExisting,
      preExistingModified: diff.preExistingModified,
      vanished: diff.vanished,
      head: { before: diff.headBefore, after: diff.headAfter, changed: diff.headChanged },
      stashChanged: diff.stashChanged,
    } : { observed: false, reason: before.reason || prev.reason || 'git could not report' },
    worker,
    checks: checkResults,
    artifacts: { dir: outDir, stdout: path.join(attemptDir, 'stdout.log'), stderr: path.join(attemptDir, 'stderr.log'), result: path.join(outDir, 'result.json') },
  });

  fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  emit(result, opts);
  process.exit(result.blocked ? 1 : 0);
}

/** One compact line per attempt, so the orchestrator sees the loop without its logs. */
function attemptRecord(n, status, execResult, worker, checks, dir) {
  return {
    attempt: n + 1,
    status,
    exitCode: execResult.exitCode,
    startedAt: execResult.startedAt,
    durationSeconds: Math.round(execResult.durationMs / 1000),
    checksFailed: checks.filter((c) => c.passed === false).map((c) => c.command),
    usage: (worker && worker.usage) || null,
    dir,
  };
}

/** Union findings by type, so a violation from an early attempt is never lost. */
function mergeFindings(all, step) {
  const byType = new Map(all.map((f) => [f.type, { ...f, paths: [...f.paths] }]));
  for (const f of step) {
    const cur = byType.get(f.type);
    if (!cur) { byType.set(f.type, { ...f, paths: [...f.paths] }); continue; }
    cur.paths = [...new Set([...cur.paths, ...f.paths])].sort();
    cur.detail = f.detail;
  }
  return [...byType.values()];
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`relay: fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { VERSION, render };
