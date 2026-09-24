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

const VERSION = '2.1.0';

const HELP = `
delegate-fleet relay ${VERSION}

  node relay.js --backend <id> --brief <file.md> [options]

Required
  --backend <id>        Worker to dispatch to. ${registryLib.adapterIds().length} supported;
                        run: node fleet.js discover   to see which exist here.
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

Output
  --stream              Tee worker stdout and stderr to relay stderr as they arrive.
  --out-dir <dir>       Where run artifacts go (default: <workspace>/.delegate-fleet/runs/<stamp>).
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
  if (r.backend) lines.push(`[relay] worker: ${r.backend.id} (${r.backend.cliPath || r.backend.cli}) · mode ${r.request.mode}`);
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

async function main() {
  const { opts, errors: argErrors } = options.parseArgs(process.argv.slice(2));

  if (opts.help || process.argv.length <= 2) { console.log(HELP); return; }
  if (opts.version) { console.log(VERSION); return; }

  const request = {
    backend: opts.backend, brief: opts.brief, mode: opts.mode,
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
  if (!opts.backend) invalid('--backend is required');
  if (!opts.brief) invalid('--brief is required');

  if (!fs.existsSync(opts.workspace)) invalid(`--workspace does not exist: ${opts.workspace}`);

  // Built-ins plus any adapter the project supplies in .delegate-fleet/adapters/.
  const local = registryLib.loadLocalAdapters(opts.workspace);
  const registry = registryLib.buildRegistry(local.loaded);
  if (local.errors.length) invalid('a project adapter failed to load', local.errors);

  const adapter = registryLib.getAdapter(opts.backend, registry);
  if (!adapter) invalid(`unknown backend "${opts.backend}". Supported: ${registryLib.adapterIds(registry).join(', ')}`);

  const config = environment.loadConfig(opts.workspace);
  if (config.errors.length) invalid('invalid .delegate-fleet/config.json', config.errors);
  const verification = environment.loadVerification(opts.workspace);
  if (verification.warning) {
    capWarnings.push(verification.warning);
  }
  const view = environment.inspect(adapter, { repoRoot: opts.workspace, config, verification, env: process.env });

  // Supported everywhere; available only where the CLI actually is.
  if (view.availability !== capabilities.AVAILABILITY.available) {
    fail(contract.preDispatchResult({
      status: contract.STATUS.BACKEND_UNAVAILABLE,
      reason: `"${adapter.id}" is supported by this framework but its CLI ("${view.cli}") is not installed on this machine`,
      request, backend: { id: adapter.id, cli: view.cli, cliPath: null },
      warnings: capWarnings,
    }), opts);
  }
  // Defaults must be folded in BEFORE the capability check, or a model or
  // effort supplied by .delegate-fleet/config.json reaches the invocation
  // without ever being checked against what this backend can honour.
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
    if (view.capabilities.readOnly === 'verified') {
      freshVerifiedReadOnly = true;
    } else {
      capWarnings.push('saved verification was not accepted as read-only proof; a fresh CLI probe did not verify it');
    }
  }
  if (view.staleVerification) {
    // Not fatal: the merged view already dropped the record, so anything
    // safety-critical will fail the gate below on its own. Say why.
    capWarnings.push(
      `local verification for "${adapter.id}" was recorded for ${view.staleVerification.recordedFor} ` +
      `but the CLI now resolves to ${view.staleVerification.nowResolvesTo}; that evidence was discarded. ` +
      `Run: node scripts/fleet.js doctor --backend ${adapter.id}`
    );
  }
  const capCheck = options.validateAgainstCapabilities(effective, view);
  if (capCheck.errors.length) invalid('the request asks for capabilities this worker does not have here', capCheck.errors);

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
  let promptFile = null;
  if (delivery === 'file') {
    promptFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-fleet-')), 'brief.md');
    fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
  }
  const cleanupPromptFile = () => {
    if (promptFile) {
      // Remove only the private temp dir this relay created; never touch the repo.
      try { fs.rmSync(path.dirname(promptFile), { recursive: true, force: true }); } catch { /* best effort */ }
      promptFile = null;
    }
  };

  const built = adapter.build({
    prompt, mode: effective.mode, model: effective.model,
    effort: effective.effort, session: effective.session,
    maxTurns: effective.maxTurns, maxBudgetUsd: effective.maxBudgetUsd,
    cwd: effective.workspace, promptFile,
  });
  const stdinPayload = delivery === 'stdin' ? prompt : null;
  const command = view.cliPath;
  const warnings = [...capWarnings, ...capCheck.warnings, ...lint.warnings];

  if (opts.dryRun) {
    cleanupPromptFile();
    const plan = {
      dryRun: true, backend: adapter.id, cli: view.cli, cliPath: view.cliPath,
      mode: effective.mode, command, args: built.args,
      promptDelivery: delivery,
      capabilities: view.capabilities, declaredCapabilities: view.declaredCapabilities,
      localVerification: view.localVerification,
      effective: {
        model: effective.model, effort: effective.effort, session: effective.session,
        timeoutSeconds: effective.timeoutSeconds,
        maxTurns: effective.maxTurns, maxBudgetUsd: effective.maxBudgetUsd,
      },
      brief: { path: briefPath, scope: lint.scope, warnings: lint.warnings },
      warnings,
    };
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // ---- dispatch -----------------------------------------------------------
  // Note: The relay is synchronous by design; running it in the background is
  // the orchestrator's job. There is deliberately no daemon mode, poller, or
  // "running" status.
  const liveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-fleet-live-'));
  const liveStdout = path.join(liveDir, 'stdout.log');
  const liveStderr = path.join(liveDir, 'stderr.log');
  fs.writeFileSync(liveStdout, '');
  fs.writeFileSync(liveStderr, '');

  if (!opts.json) {
    console.log(`[relay] dispatching ${adapter.id} (${view.cliPath}) · mode ${effective.mode} · timeout ${effective.timeoutSeconds}s · live log: ${liveStdout}`);
  }

  const onStdout = (chunk) => {
    try { fs.appendFileSync(liveStdout, chunk); } catch { /* best effort */ }
    if (opts.stream) {
      try { process.stderr.write(chunk); } catch { /* best effort */ }
    }
  };
  const onStderr = (chunk) => {
    try { fs.appendFileSync(liveStderr, chunk); } catch { /* best effort */ }
    if (opts.stream) {
      try { process.stderr.write(chunk); } catch { /* best effort */ }
    }
  };

  const before = repo.snapshot(effective.workspace);
  let execResult;
  try {
    execResult = await exec.run({
      command, args: built.args, cwd: effective.workspace,
      env: process.env, timeoutSeconds: effective.timeoutSeconds,
      stdin: stdinPayload,
      onStdout, onStderr,
    });
  } finally {
    cleanupPromptFile();
  }
  const after = repo.snapshot(effective.workspace);

  const observed = before.ok && after.ok;
  let diff = null;
  let scopeReport = null;
  if (observed) {
    diff = repo.diffSnapshots(before, after);
    // No path is filtered out here. The relay's own artifacts are written
    // after the post-run snapshot, so they cannot appear in this diff -- and
    // excluding .delegate-fleet/ wholesale would hide a worker planting an
    // adapter that the NEXT run loads with require().
    scopeReport = repo.reconcileScope(repo.changedPaths(diff), lint.scope);
  }

  const findings = contract.deriveFindings({ mode: effective.mode, diff, scopeReport });
  const { status, reason, warning: statusWarning } = contract.deriveStatus({
    execResult, mode: effective.mode, diff, denyPatterns: adapter.denyPatterns,
  });
  if (statusWarning) warnings.push(statusWarning);

  if (!observed) {
    warnings.push(`repository facts unavailable (${before.reason || after.reason}); scope, noop and commit detection are all disabled for this run`);
  }

  // Artifacts are written only after the post-run snapshot, so they cannot
  // pollute it in a repository that does not ignore .delegate-fleet/.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = path.basename(briefPath).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '-').slice(0, 60);
  // pid keeps two concurrent runs of the same brief from sharing a directory.
  const outDir = effective.outDir || path.join(effective.workspace, environment.STATE_DIR, 'runs', `${stamp}-${adapter.id}-${slug}-${process.pid}`);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    fs.copyFileSync(liveStdout, path.join(outDir, 'stdout.log'));
    fs.copyFileSync(liveStderr, path.join(outDir, 'stderr.log'));
  } catch { /* best effort */ }
  if (execResult.truncated || !fs.existsSync(path.join(outDir, 'stdout.log'))) {
    fs.writeFileSync(path.join(outDir, 'stdout.log'), execResult.stdout);
  }
  if (execResult.truncated || !fs.existsSync(path.join(outDir, 'stderr.log'))) {
    fs.writeFileSync(path.join(outDir, 'stderr.log'), execResult.stderr);
  }
  try { fs.rmSync(liveDir, { recursive: true, force: true }); } catch { /* best effort */ }
  fs.writeFileSync(path.join(outDir, 'command.json'), `${JSON.stringify({ command, args: built.args, cwd: effective.workspace }, null, 2)}\n`);

  const result = contract.buildResult({
    status, reason, findings, warnings,
    request: {
      ...request, mode: effective.mode, model: effective.model,
      effort: effective.effort, session: effective.session,
      maxTurns: effective.maxTurns, maxBudgetUsd: effective.maxBudgetUsd,
      timeoutSeconds: effective.timeoutSeconds, briefPath,
    },
    backend: {
      id: adapter.id, cli: view.cli, cliPath: view.cliPath,
      capabilities: view.capabilities,
      capabilitiesVerifiedLocally: Boolean(view.localVerification) || freshVerifiedReadOnly,
    },
    execution: {
      exitCode: execResult.exitCode, signal: execResult.signal,
      outcome: execResult.outcome, startedAt: new Date(execResult.startedAt).toISOString(),
      durationSeconds: Math.round(execResult.durationMs / 1000),
      outputTruncated: execResult.truncated,
    },
    repository: observed ? {
      observed: true,
      changed: { created: diff.created, modified: diff.modified, deleted: diff.deleted, renamed: diff.renamed },
      scope: { declared: scopeReport.declared, inScope: scopeReport.inScope, outOfScope: scopeReport.outOfScope },
      preExisting: diff.preExisting,
      preExistingModified: diff.preExistingModified,
      vanished: diff.vanished,
      head: { before: diff.headBefore, after: diff.headAfter, changed: diff.headChanged },
      stashChanged: diff.stashChanged,
    } : { observed: false, reason: before.reason || after.reason || 'git could not report' },
    artifacts: { dir: outDir, stdout: path.join(outDir, 'stdout.log'), stderr: path.join(outDir, 'stderr.log'), result: path.join(outDir, 'result.json') },
  });

  fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  emit(result, opts);
  process.exit(result.blocked ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`relay: fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = { VERSION, render };
