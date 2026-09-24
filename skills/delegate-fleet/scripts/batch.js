#!/usr/bin/env node
'use strict';

/**
 * delegate-fleet · batch
 *
 * Several slices, each in its own git worktree, dispatched in parallel through
 * the relay, reported back as ONE summary. The point is the orchestrator's
 * context: N slices cost one command and one short table, not N dispatches,
 * N waits and N result reads.
 *
 * What it does to the repository, and nothing else:
 *   - `git worktree add --detach` one throwaway worktree per slice, outside
 *     the repository (default: the system temp directory);
 *   - for a slice with dependencies, a base commit OBJECT built with plumbing
 *     (a private index, `apply --cached`, `commit-tree`). No ref moves, no
 *     hook runs, the main working tree and index are never touched;
 *   - a `.patch` per slice under `.delegate-fleet/runs/batch-<id>/`.
 *
 * It never commits to a branch, never lands a patch, and never removes a
 * worktree unless `--cleanup <id>` is asked for. Landing is the
 * orchestrator's decision, slice by slice.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const checksLib = require('./lib/checks.js');
const environment = require('./lib/environment.js');

const VERSION = '2.3.0';
const RELAY = path.join(__dirname, 'relay.js');
const SLICE_KEYS = ['id', 'brief', 'backend', 'route', 'model', 'effort', 'checks', 'fixAttempts', 'timeoutSeconds', 'dependsOn'];
const PLAN_KEYS = ['_readme', 'concurrency', 'slices', 'setup', 'link'];
const MAX_CONCURRENCY = 8;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const HELP = `
delegate-fleet batch ${VERSION}

  node batch.js <plan.json> [--workspace <dir>] [--worktree-root <dir>] [--base <ref>]
                            [--concurrency <n>] [--dry-run] [--json]
  node batch.js --cleanup <batch-id> [--workspace <dir>]

Plan
  {
    "concurrency": 3,
    "setup": ["pnpm install --frozen-lockfile --offline"],   // optional, run in each worktree
    "link": ["node_modules"],                                 // optional, symlinked from the workspace
    "slices": [
      { "id": "api", "brief": "briefs/api.md", "route": "mechanical",
        "checks": ["pnpm test -- api"], "fixAttempts": 1 },
      { "id": "ui", "brief": "briefs/ui.md", "backend": "codex", "dependsOn": ["api"] }
    ]
  }

  Each slice runs in its own detached worktree at --base (default HEAD). A slice
  with dependsOn starts from its dependencies' results, and only runs when every
  dependency finished completed and unblocked. Uncommitted work in the workspace
  is NOT carried into worktrees.

Output
  One line per slice, a .patch per slice, and the order to land them in:
    git apply .delegate-fleet/runs/batch-<id>/<slice>.patch
  Worktrees stay for review until: node batch.js --cleanup <batch-id>
`;

function git(cwd, args, extraEnv) {
  return spawnSync('git', args, {
    cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function must(res, what) {
  if (res.status !== 0) throw new Error(`${what} failed: ${(res.stderr || res.stdout || '').trim()}`);
  return (res.stdout || '').trim();
}

function parseArgs(argv) {
  const o = { plan: null, workspace: process.cwd(), worktreeRoot: null, base: 'HEAD', concurrency: null, dryRun: false, json: false, cleanup: null, help: false };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { errors.push(`${a} requires a value`); return null; }
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version') o.version = true;
    else if (a === '--json') o.json = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--workspace') { const v = value(); if (v) o.workspace = path.resolve(v); }
    else if (a === '--worktree-root') { const v = value(); if (v) o.worktreeRoot = path.resolve(v); }
    else if (a === '--base') { const v = value(); if (v) o.base = v; }
    else if (a === '--cleanup') { const v = value(); if (v) o.cleanup = v; }
    else if (a === '--concurrency') {
      const v = value();
      if (v !== null) {
        if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > MAX_CONCURRENCY) errors.push(`--concurrency must be 1-${MAX_CONCURRENCY}`);
        else o.concurrency = Number(v);
      }
    } else if (a.startsWith('-')) errors.push(`unknown option "${a}"`);
    else if (!o.plan) o.plan = path.resolve(a);
    else errors.push(`unexpected argument "${a}"`);
  }
  return { o, errors };
}

/**
 * Validate a plan strictly. Every key is consumed or rejected, the dependency
 * graph must be acyclic, and every brief must exist before anything runs.
 */
function validatePlan(plan, planDir) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { errors: ['the plan must be a JSON object'] };
  for (const k of Object.keys(plan)) if (!PLAN_KEYS.includes(k)) errors.push(`unknown plan key "${k}"`);
  if (plan.concurrency !== undefined && !(Number.isInteger(plan.concurrency) && plan.concurrency >= 1 && plan.concurrency <= MAX_CONCURRENCY)) {
    errors.push(`concurrency must be an integer 1-${MAX_CONCURRENCY}`);
  }
  const setup = [];
  for (const [i, cmd] of (plan.setup || []).entries()) {
    const t = checksLib.tokenize(cmd);
    if (t.error) errors.push(`setup[${i}]: ${t.error}`); else setup.push({ command: cmd, argv: t.argv });
  }
  const link = [];
  for (const [i, p] of (plan.link || []).entries()) {
    if (typeof p !== 'string' || !p.trim() || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) errors.push(`link[${i}]: must be a relative path inside the workspace`);
    else link.push(p.replace(/\/+$/, ''));
  }
  if (!Array.isArray(plan.slices) || plan.slices.length === 0) {
    errors.push('slices must be a non-empty array');
    return { errors };
  }
  const slices = [];
  const ids = new Set();
  plan.slices.forEach((s, i) => {
    const where = `slices[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) { errors.push(`${where}: expected an object`); return; }
    for (const k of Object.keys(s)) if (!SLICE_KEYS.includes(k)) errors.push(`${where}.${k}: unknown key; it would be silently ignored`);
    if (typeof s.id !== 'string' || !ID.test(s.id)) errors.push(`${where}.id: lowercase letters, digits and hyphens`);
    else if (ids.has(s.id)) errors.push(`${where}.id: duplicate "${s.id}"`);
    else ids.add(s.id);
    if (Boolean(s.backend) === Boolean(s.route)) errors.push(`${where}: set exactly one of "backend" or "route"`);
    const brief = typeof s.brief === 'string' ? path.resolve(planDir, s.brief) : null;
    if (!brief || !fs.existsSync(brief)) errors.push(`${where}.brief: not found (${s.brief})`);
    const checks = [];
    for (const [j, c] of (s.checks || []).entries()) {
      const t = checksLib.tokenize(c);
      if (t.error) errors.push(`${where}.checks[${j}]: ${t.error}`); else checks.push(c);
    }
    if (s.fixAttempts !== undefined && !(Number.isInteger(s.fixAttempts) && s.fixAttempts >= 0 && s.fixAttempts <= environment.MAX_FIX_ATTEMPTS)) {
      errors.push(`${where}.fixAttempts: 0-${environment.MAX_FIX_ATTEMPTS}`);
    }
    if (s.fixAttempts > 0 && checks.length === 0) errors.push(`${where}.fixAttempts: needs checks to fix against`);
    if (s.dependsOn !== undefined && !Array.isArray(s.dependsOn)) errors.push(`${where}.dependsOn: expected an array of slice ids`);
    slices.push({ ...s, brief, checks, dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [] });
  });
  for (const s of slices) {
    for (const d of s.dependsOn) if (!ids.has(d)) errors.push(`slice "${s.id}" depends on unknown slice "${d}"`);
  }
  // Kahn's algorithm: waves double as the landing order.
  const waves = [];
  if (!errors.length) {
    const done = new Set();
    let remaining = [...slices];
    while (remaining.length) {
      const ready = remaining.filter((s) => s.dependsOn.every((d) => done.has(d)));
      if (!ready.length) { errors.push(`dependency cycle among: ${remaining.map((s) => s.id).join(', ')}`); break; }
      waves.push(ready.map((s) => s.id));
      for (const s of ready) done.add(s.id);
      remaining = remaining.filter((s) => !done.has(s.id));
    }
  }
  return { errors, slices, waves, setup, link, concurrency: plan.concurrency };
}

/** Every ancestor of a slice, dependencies first. */
function ancestors(id, byId) {
  const out = [];
  const seen = new Set();
  const visit = (x) => {
    for (const d of byId.get(x).dependsOn) {
      if (seen.has(d)) continue;
      seen.add(d);
      visit(d);
      out.push(d);
    }
  };
  visit(id);
  return out;
}

/**
 * The slice's own changes as a binary patch against its base, built through a
 * private index so the worktree's real index is left exactly as the worker
 * left it. Framework state is excluded; it is never part of a slice.
 */
function slicePatch(wt, links = []) {
  const idx = path.join(os.tmpdir(), `delegate-fleet-index-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    must(git(wt, ['read-tree', 'HEAD'], env), 'read-tree');
    must(git(wt, ['add', '-A'], env), 'add to private index');
    // Then drop what is never part of a slice. `rm --cached` on the private
    // index, because an exclude pathspec errors when the path is gitignored.
    must(git(wt, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', environment.STATE_DIR, ...links], env), 'drop framework state from the patch');
    const res = git(wt, ['diff', '--cached', '--binary', 'HEAD'], env);
    must(res, 'diff');
    return res.stdout;
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

/** A base commit object = base + each dependency patch, built without touching any tree or ref. */
function baseWithDependencies(workspace, baseSha, patches, label) {
  if (!patches.length) return baseSha;
  const idx = path.join(os.tmpdir(), `delegate-fleet-index-${crypto.randomBytes(6).toString('hex')}`);
  const env = { GIT_INDEX_FILE: idx };
  try {
    must(git(workspace, ['read-tree', baseSha], env), 'read-tree');
    for (const p of patches) {
      if (!fs.readFileSync(p, 'utf8').trim()) continue;
      must(git(workspace, ['apply', '--cached', '--binary', p], env), `apply ${path.basename(p)}`);
    }
    const tree = must(git(workspace, ['write-tree'], env), 'write-tree');
    return must(git(workspace, [
      '-c', 'user.name=delegate-fleet', '-c', 'user.email=delegate-fleet@localhost',
      'commit-tree', tree, '-p', baseSha, '-m', `delegate-fleet batch base for ${label}`,
    ], env), 'commit-tree');
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

/** Fingerprint of the orchestrator's own checkout, to notice writes from outside a worktree. */
function fingerprint(workspace) {
  const status = git(workspace, ['status', '--porcelain=v1', '-z', '-uall']).stdout || '';
  const h = crypto.createHash('sha256').update(status);
  const stateDir = path.join(workspace, environment.STATE_DIR);
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (r === 'runs' || r === 'quota.json') continue; // written by the relays themselves
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { h.update(r); h.update(fs.readFileSync(p)); }
    }
  };
  walk(stateDir, '');
  return h.digest('hex');
}

function runRelay(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out); } catch { /* reported below */ }
      resolve({ code, json, stderr: err });
    });
  });
}

function summarize(slice, r) {
  if (!r) return { id: slice.id, status: 'skipped' };
  const c = r.repository && r.repository.observed ? r.repository.changed : null;
  const checks = (r.verification && r.verification.checks) || [];
  return {
    id: slice.id,
    status: r.status,
    blocked: r.blocked,
    reason: r.reason,
    backend: r.backend ? r.backend.id : null,
    tier: r.backend ? r.backend.tier : null,
    route: r.route ? r.route.name : null,
    changed: c ? { created: c.created.length, modified: c.modified.length, deleted: c.deleted.length, renamed: c.renamed.length } : null,
    findings: (r.findings || []).map((f) => `${f.type}(${f.paths.length})`),
    checks: { passed: checks.filter((x) => x.passed === true).length, total: checks.length },
    attempts: r.execution ? r.execution.attempts || 1 : 0,
    costUsd: r.worker && r.worker.usage ? r.worker.usage.costUsd : null,
    summary: r.worker && r.worker.summary ? r.worker.summary.split('\n').slice(-3).join(' / ').slice(0, 240) : null,
    result: r.artifacts ? r.artifacts.result : null,
  };
}

async function runBatch(o) {
  const workspace = o.workspace;
  const planText = (() => { try { return fs.readFileSync(o.plan, 'utf8'); } catch (e) { throw new Error(`cannot read plan: ${e.message}`); } })();
  let raw;
  try { raw = JSON.parse(planText); } catch (e) { throw new Error(`plan is not JSON: ${e.message}`); }
  const v = validatePlan(raw, path.dirname(o.plan));
  if (v.errors.length) return { exit: 2, out: { error: 'invalid plan', errors: v.errors } };

  const inside = git(workspace, ['rev-parse', '--is-inside-work-tree']);
  if ((inside.stdout || '').trim() !== 'true') return { exit: 2, out: { error: 'the workspace is not a git work tree' } };
  const baseSha = git(workspace, ['rev-parse', '--verify', `${o.base}^{commit}`]);
  if (baseSha.status !== 0) return { exit: 2, out: { error: `--base "${o.base}" is not a commit` } };
  const base = baseSha.stdout.trim();

  const concurrency = o.concurrency || v.concurrency || 3;
  const batchId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const repoTag = `${path.basename(workspace)}-${crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 8)}`;
  const wtRoot = o.worktreeRoot || path.join(os.tmpdir(), 'delegate-fleet-worktrees', repoTag, batchId);
  const runDir = path.join(workspace, environment.STATE_DIR, 'runs', `batch-${batchId}`);

  const warnings = [];
  const dirty = (git(workspace, ['status', '--porcelain=v1', '-uall']).stdout || '')
    .split('\n').filter((l) => l.trim() && !l.slice(3).startsWith(`${environment.STATE_DIR}/`));
  if (dirty.length) warnings.push(`the workspace has ${dirty.length} uncommitted path(s); worktrees start from ${o.base} and do NOT include them`);

  if (o.dryRun) {
    return { exit: 0, out: { dryRun: true, batchId, base, concurrency, worktreeRoot: wtRoot, waves: v.waves, slices: v.slices.map((s) => ({ id: s.id, brief: s.brief, backend: s.backend || null, route: s.route || null, dependsOn: s.dependsOn, checks: s.checks })), warnings } };
  }

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(wtRoot, { recursive: true });
  const fpBefore = fingerprint(workspace);
  const byId = new Map(v.slices.map((s) => [s.id, s]));
  const state = new Map(v.slices.map((s) => [s.id, { phase: 'pending', result: null, worktree: null, patch: null, note: null }]));
  const manifest = { batchId, workspace, base, worktreeRoot: wtRoot, slices: [] };
  const log = (msg) => { if (!o.json) process.stderr.write(`[batch] ${msg}\n`); };

  const copyState = (wt) => {
    const src = path.join(workspace, environment.STATE_DIR);
    const dst = path.join(wt, environment.STATE_DIR);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of ['config.json', 'verification.json']) {
      if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    if (fs.existsSync(path.join(src, 'adapters'))) fs.cpSync(path.join(src, 'adapters'), path.join(dst, 'adapters'), { recursive: true });
  };

  async function runSlice(slice) {
    const st = state.get(slice.id);
    const deps = ancestors(slice.id, byId);
    const blockedDep = deps.find((d) => state.get(d).phase !== 'done' || !state.get(d).result || state.get(d).result.blocked);
    if (blockedDep) {
      st.phase = 'skipped';
      st.note = `dependency "${blockedDep}" did not finish clean`;
      log(`${slice.id}: skipped (${st.note})`);
      return;
    }
    st.phase = 'running';
    try {
      const sliceBase = baseWithDependencies(workspace, base, deps.map((d) => state.get(d).patch), slice.id);
      const wt = path.join(wtRoot, slice.id);
      must(git(workspace, ['worktree', 'add', '--detach', wt, sliceBase]), `worktree add for ${slice.id}`);
      st.worktree = wt;
      manifest.slices.push({ id: slice.id, worktree: wt });
      fs.writeFileSync(path.join(runDir, 'batch.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      copyState(wt);
      for (const l of v.link) {
        const target = path.join(workspace, l);
        if (fs.existsSync(target) && !fs.existsSync(path.join(wt, l))) {
          fs.mkdirSync(path.dirname(path.join(wt, l)), { recursive: true });
          fs.symlinkSync(target, path.join(wt, l));
        }
      }
      for (const s of v.setup) {
        const r = spawnSync(s.argv[0], s.argv.slice(1), { cwd: wt, encoding: 'utf8', timeout: 30 * 60e3 });
        if (r.status !== 0) throw new Error(`setup "${s.command}" failed in ${slice.id}: ${(r.stderr || r.stdout || String(r.error || '')).trim().split('\n').slice(-5).join(' / ')}`);
      }
      const args = [
        slice.route ? '--route' : '--backend', slice.route || slice.backend,
        '--brief', slice.brief, '--workspace', wt, '--state-root', workspace,
        '--out-dir', path.join(runDir, slice.id), '--json',
      ];
      if (slice.model) args.push('--model', slice.model);
      if (slice.effort) args.push('--effort', slice.effort);
      if (slice.timeoutSeconds) args.push('--timeout', String(slice.timeoutSeconds));
      for (const c of slice.checks) args.push('--check', c);
      if (slice.fixAttempts) args.push('--fix-attempts', String(slice.fixAttempts));
      log(`${slice.id}: dispatching (${slice.route ? `route ${slice.route}` : slice.backend})`);
      const r = await runRelay(args);
      if (!r.json) throw new Error(`relay produced no result for ${slice.id}: ${r.stderr.trim().split('\n').slice(-3).join(' / ')}`);
      st.result = r.json;
      if (r.json.execution) {
        const patchPath = path.join(runDir, `${slice.id}.patch`);
        fs.writeFileSync(patchPath, slicePatch(wt, v.link));
        st.patch = patchPath;
      }
      st.phase = 'done';
      log(`${slice.id}: ${r.json.status}${r.json.blocked ? ' (blocked)' : ''}`);
    } catch (err) {
      st.phase = 'failed';
      st.note = err.message;
      log(`${slice.id}: failed — ${err.message}`);
    }
  }

  // A pool that starts a slice the moment its dependencies have settled.
  await new Promise((resolve) => {
    let active = 0;
    const settled = (id) => ['done', 'skipped', 'failed'].includes(state.get(id).phase);
    const pump = () => {
      const pending = v.slices.filter((s) => state.get(s.id).phase === 'pending');
      if (pending.length === 0 && active === 0) { resolve(); return; }
      for (const s of pending) {
        if (active >= concurrency) break;
        if (!ancestors(s.id, byId).every(settled)) continue;
        active += 1;
        state.get(s.id).phase = 'starting';
        runSlice(s).finally(() => { active -= 1; pump(); });
      }
    };
    pump();
  });

  if (fingerprint(workspace) !== fpBefore) {
    warnings.push('the main workspace or its .delegate-fleet/ state changed while the batch ran. Workers write only in their worktrees, so find out who did before landing anything');
  }

  const slices = v.slices.map((s) => {
    const st = state.get(s.id);
    const base = { ...summarize(s, st.result), ...(st.result ? {} : { status: st.phase, reason: st.note }) };
    // The relay ran but batch bookkeeping (the patch) failed: never report that slice as landable.
    if (st.result && st.phase === 'failed') Object.assign(base, { blocked: true, reason: st.note });
    return { ...base, worktree: st.worktree, patch: st.patch, dependsOn: s.dependsOn };
  });
  const clean = slices.filter((s) => s.status === 'completed' && s.blocked === false);
  const landOrder = v.waves.flat().filter((id) => clean.some((c) => c.id === id));
  const spend = slices.reduce((sum, s) => sum + (typeof s.costUsd === 'number' ? s.costUsd : 0), 0);
  const out = {
    batchId, base, worktreeRoot: wtRoot, runDir,
    totals: { slices: slices.length, clean: clean.length, blocked: slices.length - clean.length, workerCostUsd: Math.round(spend * 1e4) / 1e4 },
    slices, landOrder, warnings,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), `${JSON.stringify(out, null, 2)}\n`);
  return { exit: clean.length === slices.length && !warnings.some((w) => /changed while the batch ran/.test(w)) ? 0 : 1, out };
}

function render(out) {
  const lines = [];
  const t = out.totals;
  lines.push(`[batch] ${out.batchId}: ${t.slices} slice(s) · ${t.clean} clean · ${t.blocked} need a decision · worker spend $${t.workerCostUsd}`);
  for (const s of out.slices) {
    const state = s.status === 'completed' && s.blocked === false ? 'clean' : s.status === 'completed' ? 'BLOCKED' : s.status;
    const bits = [
      s.backend ? `${s.backend}${s.tier ? ` [${s.tier}]` : ''}` : '—',
      state,
      s.changed ? `+${s.changed.created} ~${s.changed.modified} -${s.changed.deleted}` : '',
      s.checks && s.checks.total ? `checks ${s.checks.passed}/${s.checks.total}` : '',
      s.attempts > 1 ? `attempts ${s.attempts}` : '',
      s.findings && s.findings.length ? s.findings.join(' ') : '',
      s.reason && state !== 'clean' ? `— ${s.reason}` : '',
    ].filter(Boolean);
    lines.push(`  ${s.id.padEnd(14)} ${bits.join('  ')}`);
    if (s.summary) lines.push(`  ${''.padEnd(14)} worker says: ${s.summary}`);
  }
  for (const w of out.warnings) lines.push(`[batch] warning: ${w}`);
  if (out.landOrder.length) {
    lines.push('[batch] review each clean slice (git -C <worktree> diff), then land in this order:');
    for (const id of out.landOrder) lines.push(`  git apply ${path.relative(process.cwd(), out.slices.find((s) => s.id === id).patch)}`);
  }
  lines.push(`[batch] worktrees: ${out.worktreeRoot}   remove with: node batch.js --cleanup ${out.batchId}`);
  return lines.join('\n');
}

/** Remove only the worktrees a batch recorded in its own manifest. */
function cleanup(o) {
  const manifestPath = path.join(o.workspace, environment.STATE_DIR, 'runs', `batch-${o.cleanup}`, 'batch.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { exit: 2, out: { error: `no batch manifest at ${manifestPath}` } }; }
  const removed = [];
  const failed = [];
  for (const s of manifest.slices) {
    const r = git(o.workspace, ['worktree', 'remove', '--force', s.worktree]);
    if (r.status === 0 || !fs.existsSync(s.worktree)) removed.push(s.id); else failed.push({ id: s.id, error: (r.stderr || '').trim() });
  }
  git(o.workspace, ['worktree', 'prune']);
  try { fs.rmSync(manifest.worktreeRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  return { exit: failed.length ? 1 : 0, out: { batchId: o.cleanup, removed, failed, kept: 'patches and results under .delegate-fleet/runs/ are kept' } };
}

async function main() {
  const { o, errors } = parseArgs(process.argv.slice(2));
  if (o.help || process.argv.length <= 2) { console.log(HELP); return 0; }
  if (o.version) { console.log(VERSION); return 0; }
  if (errors.length) { console.error(errors.join('\n')); return 2; }
  let res;
  if (o.cleanup) res = cleanup(o);
  else if (!o.plan) { console.error('batch: a plan file is required'); return 2; }
  else {
    try { res = await runBatch(o); } catch (err) { res = { exit: 2, out: { error: err.message } }; }
  }
  if (o.json || res.out.error || res.out.dryRun || o.cleanup) console.log(JSON.stringify(res.out, null, 2));
  else console.log(render(res.out));
  return res.exit;
}

if (require.main === module) main().then((code) => process.exit(code));
module.exports = { VERSION, validatePlan, ancestors };
