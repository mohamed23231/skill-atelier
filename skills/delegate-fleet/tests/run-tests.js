#!/usr/bin/env node
'use strict';

/**
 * delegate-fleet contract tests.
 *
 * These test BEHAVIOUR, not helpers: a stub worker really writes files, really
 * commits, really hangs, really spawns a grandchild, and the relay's reported
 * facts are checked against what actually happened on disk.
 *
 * Every configuration option has a test proving it reaches the backend
 * invocation, because "parsed and silently ignored" was the defining bug of
 * the previous implementation.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const H = require('./harness.js');
const execLib = require('../scripts/lib/exec.js');
const capabilities = require('../scripts/lib/capabilities.js');
const brief = require('../scripts/lib/brief.js');
const repoLib = require('../scripts/lib/repo.js');
const contract = require('../scripts/lib/contract.js');
const options = require('../scripts/lib/options.js');
const registry = require('../scripts/adapters/index.js');
const environment = require('../scripts/lib/environment.js');
const report = require('../scripts/lib/report.js');
const checksLib = require('../scripts/lib/checks.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ALL_CAPS = { edit: 'verified', readOnly: 'verified', resumeById: 'verified', modelSelection: 'verified', effort: 'verified', structuredOutput: 'verified', turnLimit: 'verified', budgetLimit: 'verified' };

/* ------------------------------------------------------------------ *
 * Options: nothing decorative, nothing silently dropped
 * ------------------------------------------------------------------ */

test('timeout rejects NaN, Infinity, negative, zero, float and empty', () => {
  for (const bad of ['abc', 'NaN', 'Infinity', '-1', '-5', '0', '1.5', '1e3', '']) {
    assert.ok(options.parseTimeout(bad).error, `"${bad}" must be rejected`);
  }
  assert.strictEqual(options.parseTimeout('600').value, 600);
});

test('timeout rejects values beyond the maximum', () => {
  assert.ok(options.parseTimeout(String(options.MAX_TIMEOUT_SECONDS + 1)).error);
  assert.strictEqual(options.parseTimeout(String(options.MAX_TIMEOUT_SECONDS)).value, options.MAX_TIMEOUT_SECONDS);
});

test('max-turns rejects NaN, Infinity, negative, zero, float, empty, and over MAX_TURNS', () => {
  for (const bad of ['abc', 'NaN', 'Infinity', '-1', '-5', '0', '1.5', '1e3', '', String(options.MAX_TURNS + 1)]) {
    assert.ok(options.parseMaxTurns(bad).error, `"${bad}" must be rejected`);
  }
  assert.strictEqual(options.parseMaxTurns('10').value, 10);
  assert.strictEqual(options.parseMaxTurns(String(options.MAX_TURNS)).value, options.MAX_TURNS);
});

test('max-budget-usd rejects NaN, Infinity, negative, zero, empty, and over MAX_BUDGET_USD, but accepts decimals', () => {
  for (const bad of ['abc', 'NaN', 'Infinity', '-1', '-5', '0', '', String(options.MAX_BUDGET_USD + 1)]) {
    assert.ok(options.parseMaxBudgetUsd(bad).error, `"${bad}" must be rejected`);
  }
  assert.strictEqual(options.parseMaxBudgetUsd('10').value, 10);
  assert.strictEqual(options.parseMaxBudgetUsd('10.50').value, 10.5);
  assert.strictEqual(options.parseMaxBudgetUsd('.75').value, 0.75);
  assert.strictEqual(options.parseMaxBudgetUsd(String(options.MAX_BUDGET_USD)).value, options.MAX_BUDGET_USD);
});

test('malformed --max-turns and --max-budget-usd are rejected before dispatch', () => {
  const repo = H.tmpRepo();
  H.useStub(repo, 'claude');
  const b = H.writeBrief(repo);
  for (const bad of ['0', '-1', 'abc', '']) {
    const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--max-budget-usd', bad, '--json'], { cwd: repo });
    assert.strictEqual(res.json.status, 'invalid_request', `bad budget "${bad}" must be invalid_request`);
    assert.strictEqual(res.status, 2);
  }
  H.useStub(repo, 'grok');
  for (const bad of ['0', '-1', 'abc', '']) {
    const res = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--max-turns', bad, '--json'], { cwd: repo });
    assert.strictEqual(res.json.status, 'invalid_request', `bad turns "${bad}" must be invalid_request`);
    assert.strictEqual(res.status, 2);
  }
});

test('unknown options and stray positionals are rejected, never ignored', () => {
  assert.ok(options.parseArgs(['--nope']).errors.length > 0);
  assert.ok(options.parseArgs(['surprise']).errors.length > 0);
  assert.ok(options.parseArgs(['--backend']).errors.length > 0, 'a flag with no value is an error');
});

test('every parsed option is consumed by the request', () => {
  const { opts, errors } = options.parseArgs(['--backend', 'codex', '--brief', 'b.md', '--model', 'm', '--effort', 'high', '--session', 's1', '--timeout', '30', '--read-only']);
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(opts.backend, 'codex');
  assert.strictEqual(opts.model, 'm');
  assert.strictEqual(opts.effort, 'high');
  assert.strictEqual(opts.session, 's1');
  assert.strictEqual(opts.timeoutSeconds, 30);
  assert.strictEqual(opts.mode, 'read-only');
});

/* ------------------------------------------------------------------ *
 * Capability model: supported vs available vs verified
 * ------------------------------------------------------------------ */

test('every adapter declares a legal capability for every capability name', () => {
  for (const a of registry.BUILT_IN) {
    for (const name of capabilities.CAPABILITY_NAMES) {
      assert.ok(capabilities.EVIDENCE_STATES.includes(a.capabilities[name]), `${a.id}.${name}`);
    }
  }
});

test('local evidence can promote a documented claim and demote a wrong one', () => {
  const declared = { ...ALL_CAPS, readOnly: 'documented', effort: 'documented' };
  const merged = capabilities.applyLocalEvidence(declared, { readOnly: 'verified', effort: 'unsupported' });
  assert.strictEqual(merged.readOnly, 'verified');
  assert.strictEqual(merged.effort, 'unsupported');
});

test('a backend absent from this machine is unavailable but still supported', () => {
  const repo = H.tmpRepo();
  const res = H.runFleet(['discover', '--workspace', repo, '--json'], { cwd: repo });
  const byId = Object.fromEntries(res.json.backends.map((b) => [b.id, b]));
  const absent = res.json.backends.find((b) => b.availability === 'unavailable');
  assert.ok(absent, 'expected at least one backend to be missing in the test environment');
  assert.strictEqual(absent.supported, true, 'an absent backend must remain supported');
  assert.ok(Object.keys(byId).length >= 20, 'the whole framework registry is reported regardless of what is installed');
});

test('select only offers workers that are available and capable', () => {
  const repo = H.tmpRepo();
  H.useStub(repo, 'claude');
  const res = H.runFleet(['select', '--need', 'edit,readOnly', '--workspace', repo, '--json'], { cwd: repo });
  assert.ok(Array.isArray(res.json.matches));
  const warpOffered = res.json.matches.includes('warp');
  assert.ok(!warpOffered, 'warp has no read-only mode and must never be offered for one');
});

test('select rejects a capability the framework does not define', () => {
  const repo = H.tmpRepo();
  const res = H.runFleet(['select', '--need', 'telepathy', '--workspace', repo], { cwd: repo });
  assert.strictEqual(res.status, 2);
});

/* ------------------------------------------------------------------ *
 * Brief
 * ------------------------------------------------------------------ */

test('a vague brief is refused before anything is dispatched', () => {
  const repo = H.tmpRepo();
  H.useStub(repo);
  const b = H.writeBrief(repo, '# Objective\nfix it\n');
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.status, 2, res.stdout + res.stderr);
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.ok(!fs.existsSync(path.join(repo, '.delegate-fleet', 'runs')), 'nothing may be dispatched');
});

test('the brief scope drives reconciliation and is extracted from backticks only', () => {
  const lint = brief.lint(H.GOOD_BRIEF);
  assert.deepStrictEqual(lint.scope, ['src/a.js']);
  assert.strictEqual(lint.ok, true);
});

test('the non-negotiable constraints are injected, not trusted to the author', () => {
  const prompt = brief.buildPrompt({ briefText: H.GOOD_BRIEF, mode: 'edit', scope: ['src/a.js'] });
  assert.match(prompt, /Do NOT commit, push, stash, revert, or reset/i);
  assert.match(prompt, /already modified before you started/i);
  assert.ok(!/Do NOT commit/i.test(H.GOOD_BRIEF), 'the brief itself never said it; the relay added it');
});

/* ------------------------------------------------------------------ *
 * Repository facts
 * ------------------------------------------------------------------ */

test('porcelain -z parsing handles renames without eating the next record', () => {
  const entries = repoLib.parsePorcelainZ('R  new.js\0old.js\0 M other.js\0?? fresh.js\0');
  assert.strictEqual(entries.length, 3);
  assert.strictEqual(entries[0].renamedFrom, 'old.js');
  assert.strictEqual(entries[1].path, 'other.js');
  assert.strictEqual(entries[2].path, 'fresh.js');
});

test('scope reconciliation matches exact paths and directory prefixes only', () => {
  const r = repoLib.reconcileScope(['src/a.js', 'src/deep/b.js', 'other.js', 'src-extra/c.js'], ['src/a.js', 'src/deep']);
  assert.deepStrictEqual(r.inScope, ['src/a.js', 'src/deep/b.js']);
  assert.deepStrictEqual(r.outOfScope, ['other.js', 'src-extra/c.js']);
});

/* ------------------------------------------------------------------ *
 * Failure taxonomy
 * ------------------------------------------------------------------ */

test('timeout outranks whatever exit code the dying child emitted', () => {
  const s = contract.deriveStatus({ execResult: { outcome: 'timeout', exitCode: 0, stdout: '', stderr: '' }, mode: 'edit', diff: null, denyPatterns: [] });
  assert.strictEqual(s.status, 'timeout');
});

test('a refusal printed with exit 0 is implementer_failure, not success', () => {
  const s = contract.deriveStatus({ execResult: { outcome: 'exited', exitCode: 0, signal: null, stdout: 'not logged in', stderr: '' }, mode: 'edit', diff: null, denyPatterns: [/not logged in/i] });
  assert.strictEqual(s.status, 'implementer_failure');
});

test('exit 0 on an edit run that changed nothing is noop', () => {
  const diff = { created: [], modified: [], deleted: [], renamed: [] };
  const s = contract.deriveStatus({ execResult: { outcome: 'exited', exitCode: 0, signal: null, stdout: '', stderr: '' }, mode: 'edit', diff, denyPatterns: [] });
  assert.strictEqual(s.status, 'noop');
});

test('findings are derived even when the process failed', () => {
  const diff = { created: ['x'], modified: [], deleted: [], renamed: [], preExistingModified: [], vanished: [], headChanged: false, stashChanged: false };
  const f = contract.deriveFindings({ mode: 'edit', diff, scopeReport: { outOfScope: ['x'], inScope: [], declared: ['y'] } });
  assert.strictEqual(f[0].type, 'scope_violation');
});

/* ------------------------------------------------------------------ *
 * End to end: the worker really runs
 * ------------------------------------------------------------------ */

test('e2e: a clean in-scope implementation completes and is not blocked', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'export const a = 1;\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(res.json.status, 'completed', JSON.stringify(res.json.findings));
  assert.strictEqual(res.json.blocked, false);
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js']);
  assert.strictEqual(res.status, 0);
});

test('e2e: exit 0 with no change is reported as noop and blocks', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'noop');
  assert.strictEqual(res.json.blocked, true);
  assert.strictEqual(res.status, 1);
});

test('e2e: a non-zero exit is process_failure and the partial changes are still reported', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_EXIT: '3' } });
  assert.strictEqual(res.json.status, 'process_failure');
  assert.strictEqual(res.json.execution.exitCode, 3);
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js'], 'partial work must still be visible');
});

test('e2e: out-of-scope edits are reported as a scope_violation', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n', 'src/untouched.js': 'y\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js,src/untouched.js' } });
  const f = res.json.findings.find((x) => x.type === 'scope_violation');
  assert.ok(f, 'expected a scope_violation');
  assert.deepStrictEqual(f.paths, ['src/untouched.js']);
  assert.strictEqual(res.json.blocked, true);
  // The relay reports; it must not fix.
  assert.ok(fs.readFileSync(path.join(repo, 'src/untouched.js'), 'utf8').includes('stub worker'), 'the relay must never revert a violation');
});

test('e2e: an out-of-scope file creation and deletion are both caught', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n', 'doomed.js': 'z\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_CREATE: 'surprise.js', STUB_DELETE: 'doomed.js' } });
  assert.ok(res.json.repository.changed.created.includes('surprise.js'));
  assert.ok(res.json.repository.changed.deleted.includes('doomed.js'));
  const f = res.json.findings.find((x) => x.type === 'scope_violation');
  assert.ok(f.paths.includes('surprise.js') && f.paths.includes('doomed.js'));
});

test('e2e: a rename is detected at both ends', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_RENAME: 'src/a.js:src/renamed.js' } });
  const paths = JSON.stringify(res.json.repository);
  assert.ok(paths.includes('renamed.js'), 'the new name must appear in the repository facts');
});

/* ------------------------------------------------------------------ *
 * Dirty working tree safety — the first-class requirement
 * ------------------------------------------------------------------ */

test('e2e: pre-existing dirty files the worker never touched are not attributed to it', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n', 'mine.js': 'original\n' }, dirty: { 'mine.js': 'MY UNCOMMITTED WORK\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.ok(res.json.repository.preExisting.includes('mine.js'), 'the baseline must record it');
  assert.ok(!res.json.repository.changed.modified.includes('mine.js'), 'it must NOT be reported as a worker change');
  assert.strictEqual(res.json.findings.length, 0);
  assert.strictEqual(res.json.blocked, false);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'mine.js'), 'utf8'), 'MY UNCOMMITTED WORK\n', 'untouched on disk');
});

test('e2e: a worker editing a file that was ALREADY dirty is caught (the status-code blind spot)', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' }, dirty: { 'src/a.js': 'MY UNCOMMITTED WORK\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  // Status stayed " M" throughout; only a content hash can see this.
  assert.ok(res.json.repository.changed.modified.includes('src/a.js'), 'the further edit must be visible');
  const f = res.json.findings.find((x) => x.type === 'unexpected_repository_change');
  assert.ok(f, 'editing pre-existing uncommitted work is a finding');
  assert.ok(f.paths.includes('src/a.js'));
  assert.strictEqual(res.json.blocked, true);
});

test('e2e: mixed pre-existing and worker changes are attributed separately', () => {
  const repo = H.tmpRepo({
    files: { 'src/a.js': 'x\n', 'mine.js': 'o\n' },
    dirty: { 'mine.js': 'MINE\n', 'untracked-mine.txt': 'MINE TOO\n' },
  });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js']);
  assert.ok(res.json.repository.preExisting.includes('mine.js'));
  assert.ok(res.json.repository.preExisting.includes('untracked-mine.txt'));
  assert.strictEqual(res.json.blocked, false);
});

test('e2e: a worker that commits is caught by HEAD movement, and nothing is undone', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_COMMIT: '1' } });
  const f = res.json.findings.find((x) => x.type === 'worker_commit');
  assert.ok(f, 'a worker commit must be a finding');
  assert.strictEqual(res.json.repository.head.changed, true);
  assert.strictEqual(res.json.acceptance.accepted, null, 'the relay never accepts');
  const after = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  assert.notStrictEqual(before, after);
  assert.ok(res.json.blocked, true);
});

test('e2e: a worker that stashes is caught', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' }, dirty: { 'src/a.js': 'dirty\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_STASH: '1' } });
  assert.ok(res.json.findings.some((x) => x.type === 'worker_stash' || x.type === 'unexpected_repository_change'));
});

/* ------------------------------------------------------------------ *
 * Read-only honesty
 * ------------------------------------------------------------------ */

test('read-only is refused on a backend whose read-only is not verified here', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'crush'); // crush declares readOnly: unknown
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'crush', '--brief', b, '--workspace', repo, '--read-only', '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /readOnly/);
  assert.strictEqual(res.status, 2);
});

test('read-only on a backend that genuinely lacks it is refused outright', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'warp'); // warp: readOnly unsupported
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'warp', '--brief', b, '--workspace', repo, '--read-only', '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /does not support readOnly/);
});

test('--allow-unverified downgrades the read-only refusal to a warning', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'grok'); // grok declares readOnly: documented, but this help does not name its profile
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--read-only', '--allow-unverified', '--json'], {
    cwd: repo, env: { STUB_HELP_TEXT: '--sandbox <PROFILE>\n' },
  });
  assert.notStrictEqual(res.json.status, 'invalid_request');
  assert.ok(res.json.warnings.some((w) => /not verified/.test(w)));
});

test('e2e: a read-only run that writes anyway is reported as a read_only_violation', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--read-only', '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  const f = res.json.findings.find((x) => x.type === 'read_only_violation');
  assert.ok(f, 'a read-only run that changed the tree must say so');
  assert.strictEqual(res.json.blocked, true);
});

/* ------------------------------------------------------------------ *
 * Sessions: honest or rejected
 * ------------------------------------------------------------------ */

test('--session is rejected on a backend that cannot resume by id', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'gemini');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'gemini', '--brief', b, '--workspace', repo, '--session', 'abc', '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /resumeById/);
});

test('--session reaches the backend invocation where it IS supported', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'codex');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'codex', '--brief', b, '--workspace', repo, '--session', 'sess-123', '--dry-run'], { cwd: repo });
  assert.deepStrictEqual(res.json.args.slice(0, 3), ['exec', 'resume', 'sess-123']);
});

/* ------------------------------------------------------------------ *
 * Configuration reaches the invocation — the v1 class of bug
 * ------------------------------------------------------------------ */

test('config cli override actually changes the executed binary', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo });
  assert.strictEqual(res.json.cliPath, H.STUB, 'the configured cli must be the one spawned');
});

test('config model default reaches the backend argv', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude', { model: 'configured-model' });
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo });
  assert.ok(res.json.args.includes('configured-model'), 'a configured model must appear in argv');
});

test('an explicit --model beats the configured default', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude', { model: 'configured-model' });
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--model', 'explicit', '--dry-run'], { cwd: repo });
  assert.ok(res.json.args.includes('explicit'));
  assert.ok(!res.json.args.includes('configured-model'));
});

test('config effort and timeout defaults are applied', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude', { effort: 'high', timeoutSeconds: 42 });
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo });
  assert.ok(res.json.args.includes('high'));
  assert.strictEqual(res.json.effective.timeoutSeconds, 42);
});

test('config maxTurns and maxBudgetUsd defaults reach the backend invocation and explicit flags override them', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'grok', { maxTurns: 50 });
  H.useStub(repo, 'claude', { maxBudgetUsd: 12.5 });
  const b = H.writeBrief(repo);

  const resGrok = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo });
  assert.ok(resGrok.json.args.includes('--max-turns') && resGrok.json.args.includes('50'));
  assert.strictEqual(resGrok.json.effective.maxTurns, 50);

  const resGrokExplicit = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--max-turns', '99', '--dry-run'], { cwd: repo });
  assert.ok(resGrokExplicit.json.args.includes('99'));
  assert.ok(!resGrokExplicit.json.args.includes('50'));
  assert.strictEqual(resGrokExplicit.json.effective.maxTurns, 99);

  const resClaude = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo });
  assert.ok(resClaude.json.args.includes('--max-budget-usd') && resClaude.json.args.includes('12.5'));
  assert.strictEqual(resClaude.json.effective.maxBudgetUsd, 12.5);

  const resClaudeExplicit = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--max-budget-usd', '3.14', '--dry-run'], { cwd: repo });
  assert.ok(resClaudeExplicit.json.args.includes('3.14'));
  assert.ok(!resClaudeExplicit.json.args.includes('12.5'));
  assert.strictEqual(resClaudeExplicit.json.effective.maxBudgetUsd, 3.14);
});

test('--max-turns reaches the invocation on grok and is rejected on a backend that lacks it', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'grok');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--max-turns', '15', '--dry-run'], { cwd: repo });
  assert.ok(res.json.args.includes('--max-turns') && res.json.args.includes('15'));
  assert.strictEqual(res.json.effective.maxTurns, 15);

  H.useStub(repo, 'claude');
  const resClaude = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--max-turns', '15', '--json'], { cwd: repo });
  assert.strictEqual(resClaude.json.status, 'invalid_request');
  assert.match(resClaude.json.reason, /turnLimit/);
  assert.strictEqual(resClaude.status, 2);

  H.useStub(repo, 'codex');
  const resCodex = H.runRelay(['--backend', 'codex', '--brief', b, '--workspace', repo, '--max-turns', '15', '--json'], { cwd: repo });
  assert.strictEqual(resCodex.json.status, 'invalid_request');
  assert.match(resCodex.json.reason, /turnLimit/);
  assert.strictEqual(resCodex.status, 2);
});

test('--max-budget-usd reaches the invocation on claude and is rejected on a backend that lacks it', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--max-budget-usd', '25.5', '--dry-run'], { cwd: repo });
  assert.ok(res.json.args.includes('--max-budget-usd') && res.json.args.includes('25.5'));
  assert.strictEqual(res.json.effective.maxBudgetUsd, 25.5);

  H.useStub(repo, 'grok');
  const resGrok = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--max-budget-usd', '25.5', '--json'], { cwd: repo });
  assert.strictEqual(resGrok.json.status, 'invalid_request');
  assert.match(resGrok.json.reason, /budgetLimit/);
  assert.strictEqual(resGrok.status, 2);

  H.useStub(repo, 'codex');
  const resCodex = H.runRelay(['--backend', 'codex', '--brief', b, '--workspace', repo, '--max-budget-usd', '25.5', '--json'], { cwd: repo });
  assert.strictEqual(resCodex.json.status, 'invalid_request');
  assert.match(resCodex.json.reason, /budgetLimit/);
  assert.strictEqual(resCodex.status, 2);
});

test('a config field with no consumer is rejected rather than silently ignored', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  const dir = path.join(repo, '.delegate-fleet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ workers: { claude: { cli: H.STUB, priority: 'high' } } }));
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /unknown option/);
});

test('--effort is rejected on a backend with no effort control', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'cursor');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'cursor', '--brief', b, '--workspace', repo, '--effort', 'high', '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /effort/);
});

/* ------------------------------------------------------------------ *
 * Availability and bad requests
 * ------------------------------------------------------------------ */

test('an unavailable backend reports backend_unavailable, not unsupported', () => {
  const repo = H.tmpRepo();
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'kimi', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { PATH: '/nonexistent' } });
  assert.strictEqual(res.json.status, 'backend_unavailable');
  assert.match(res.json.reason, /supported by this framework/);
  assert.strictEqual(res.status, 2);
});

test('an unknown backend is an invalid request', () => {
  const repo = H.tmpRepo();
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'nope', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.strictEqual(res.status, 2);
});

/* ------------------------------------------------------------------ *
 * Bounded execution
 * ------------------------------------------------------------------ */

test('e2e: the watchdog fires and reports timeout', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const started = Date.now();
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--timeout', '2', '--json'], { cwd: repo, env: { STUB_SLEEP: '60000' } });
  assert.strictEqual(res.json.status, 'timeout');
  assert.ok(Date.now() - started < 40000, 'the relay must not hang past its own watchdog');
});

test('e2e: the watchdog kills the whole process tree, leaving no orphan', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const pidFile = path.join(repo, 'child.pid');
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--timeout', '2', '--json'], {
    cwd: repo, env: { STUB_SLEEP: '60000', STUB_SPAWN_CHILD: '60000', STUB_CHILD_PIDFILE: pidFile },
  });
  assert.strictEqual(res.json.status, 'timeout');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  // Give the SIGKILL escalation a moment, then confirm the grandchild is gone.
  const deadline = Date.now() + 15000;
  let alive = true;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { alive = false; break; }
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']);
  }
  assert.strictEqual(alive, false, `grandchild ${pid} survived the watchdog — the process group was not killed`);
});

test('e2e: a brief containing shell metacharacters is passed literally, never interpreted', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const canary = path.join(repo, 'INJECTED');
  const evil = H.GOOD_BRIEF.replace('## Non-goals', `## Non-goals\n- \`; touch ${canary}; echo \` and $(touch ${canary}) and \`+"\`"+\`\n`);
  const b = H.writeBrief(repo, evil);
  const argvFile = path.join(repo, 'argv.json');
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_ECHO_ARGV: argvFile, STUB_MODIFY: 'src/a.js' } });
  assert.ok(!fs.existsSync(canary), 'no shell may ever interpret brief content');
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')).argv;
  assert.ok(argv.some((a) => a.includes('touch')), 'the text still reached the worker verbatim');
  assert.ok(res.json);
});

test('opencode is told the workspace explicitly — process cwd is not enough', () => {
  // Observed 2026-09-21 with opencode 1.18.31: without --dir it resolves
  // relative paths against its own last-used project, not the spawn cwd, and
  // happily reads and writes a repository the relay is not observing.
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'opencode'); H.markVerified(repo, 'opencode', ALL_CAPS);
  const b = H.writeBrief(repo);
  const argvFile = path.join(repo, 'argv.json');
  H.runRelay(['--backend', 'opencode', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_ECHO_ARGV: argvFile, STUB_MODIFY: 'src/a.js' } });
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')).argv;
  const idx = argv.indexOf('--dir');
  assert.ok(idx >= 0, 'opencode must be given --dir or it may work in the wrong repository');
  assert.strictEqual(fs.realpathSync(argv[idx + 1]), fs.realpathSync(repo));
});

/* ------------------------------------------------------------------ *
 * Prompt delivery
 * ------------------------------------------------------------------ */

test('a stdin-delivered brief actually reaches the worker on stdin', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'cline'); H.markVerified(repo, 'cline', ALL_CAPS);
  const b = H.writeBrief(repo);
  const sink = path.join(repo, 'stdin.txt');
  H.runRelay(['--backend', 'cline', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_ECHO_STDIN: sink, STUB_MODIFY: 'src/a.js' } });
  const got = fs.readFileSync(sink, 'utf8');
  assert.match(got, /BEGIN TASK BRIEF/);
  assert.match(got, /NON-NEGOTIABLE CONSTRAINTS/);
});

test('a file-delivered brief is written, passed by path, and cleaned up afterwards', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'grok'); H.markVerified(repo, 'grok', ALL_CAPS);
  const b = H.writeBrief(repo);
  const argvFile = path.join(repo, 'argv.json');
  H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_ECHO_ARGV: argvFile, STUB_MODIFY: 'src/a.js' } });
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8')).argv;
  const idx = argv.indexOf('--prompt-file');
  assert.ok(idx >= 0, 'grok must receive the brief as a file');
  assert.ok(!fs.existsSync(argv[idx + 1]), 'the temp brief must be removed after the run');
});

/* ------------------------------------------------------------------ *
 * Artifacts and hygiene
 * ------------------------------------------------------------------ */

test('e2e: artifacts are written and result.json matches the printed JSON', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: 'hello from the worker' } });
  const onDisk = H.readResult(repo);
  assert.deepStrictEqual(onDisk, res.json, 'the file and stdout must agree');
  assert.match(fs.readFileSync(path.join(onDisk.artifacts.dir, 'stdout.log'), 'utf8'), /hello from the worker/);
  assert.ok(fs.existsSync(path.join(onDisk.artifacts.dir, 'command.json')));
});

test("e2e: the relay's own artifacts are never counted as worker changes", () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } }); // no .gitignore at all
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  const all = JSON.stringify(res.json.repository.changed);
  assert.ok(!all.includes('.delegate-fleet'), 'relay artifacts must be excluded from repository facts');
  assert.strictEqual(res.json.blocked, false);
});

test('e2e: repeated invocations each produce their own run directory', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  for (const f of ['one.js', 'two.js']) {
    H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_CREATE: f } });
  }
  const runs = fs.readdirSync(path.join(repo, '.delegate-fleet', 'runs'));
  assert.strictEqual(runs.length, 2, 'runs must not overwrite each other');
});

test('e2e: concurrent runs in separate workspaces do not interfere', async () => {
  const repos = [0, 1].map(() => {
    const r = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
    H.useStub(r); H.markVerified(r, 'claude', ALL_CAPS); H.writeBrief(r);
    return r;
  });
  const results = await Promise.all(repos.map((r, i) => new Promise((resolve) => {
    const { spawn } = require('node:child_process');
    const p = spawn(process.execPath, [H.RELAY, '--backend', 'claude', '--brief', path.join(r, 'brief.md'), '--workspace', r, '--json'], {
      cwd: r, env: { ...process.env, STUB_CREATE: `file-${i}.js`, STUB_SLEEP: '300' },
    });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', () => resolve(JSON.parse(out)));
  })));
  for (const [i, r] of results.entries()) {
    assert.ok(r.repository.changed.created.includes(`file-${i}.js`), 'each run sees only its own workspace');
  }
});

test('streaming callbacks fire during execution and a throwing callback does not break the run', async () => {
  const stdoutChunks = [];
  const stderrChunks = [];
  const res = await execLib.run({
    command: process.execPath,
    args: ['-e', 'process.stdout.write("out-chunk-1\\n"); process.stderr.write("err-chunk-1\\n");'],
    cwd: os.tmpdir(),
    timeoutSeconds: 5,
    onStdout: (c) => {
      stdoutChunks.push(c.toString());
      throw new Error('deliberate onStdout throw');
    },
    onStderr: (c) => {
      stderrChunks.push(c.toString());
      throw new Error('deliberate onStderr throw');
    },
  });
  assert.strictEqual(res.outcome, 'exited');
  assert.strictEqual(res.exitCode, 0);
  assert.ok(stdoutChunks.some((c) => c.includes('out-chunk-1')));
  assert.ok(stderrChunks.some((c) => c.includes('err-chunk-1')));
  assert.ok(res.stdout.includes('out-chunk-1'));
  assert.ok(res.stderr.includes('err-chunk-1'));
});

test('--stream tees worker output to relay stderr while stdout remains pure JSON', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude');
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--stream', '--json'], {
    cwd: repo,
    env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: 'live progress token' },
  });
  assert.ok(res.json);
  assert.strictEqual(res.json.status, 'completed');
  assert.ok(res.stderr.includes('live progress token'), 'relay stderr must contain streamed worker output');
});

test('the live log lands outside the workspace: zero repository changes in a repo without .gitignore', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } }); // No .gitignore
  H.useStub(repo, 'claude');
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo,
    env: { STUB_PRINT: 'active worker logging' },
  });
  assert.strictEqual(res.json.repository.changed.created.length, 0);
  assert.strictEqual(res.json.repository.changed.modified.length, 0);
  assert.strictEqual(res.json.repository.changed.deleted.length, 0);
  assert.strictEqual(res.json.repository.changed.renamed.length, 0);
  assert.strictEqual(res.json.status, 'noop');
  assert.ok(fs.existsSync(res.json.artifacts.stdout));
  assert.match(fs.readFileSync(res.json.artifacts.stdout, 'utf8'), /active worker logging/);
});

test('non-json mode prints banner line before dispatch', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude');
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--timeout', '42'], {
    cwd: repo,
    env: { STUB_MODIFY: 'src/a.js' },
  });
  assert.match(res.stdout, /\[relay\] dispatching claude .*mode edit · timeout 42s · live log: .*stdout\.log/);
});

/* ------------------------------------------------------------------ *
 * Third-party adapters
 * ------------------------------------------------------------------ */

test('a project-supplied adapter is loaded, validated, and usable', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  const dir = path.join(repo, '.delegate-fleet', 'adapters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mycli.js'), `
    module.exports = {
      id: 'mycli', cli: ${JSON.stringify(H.STUB)}, title: 'My CLI', docs: '',
      capabilities: { edit:'verified', readOnly:'unsupported', resumeById:'unsupported', modelSelection:'verified', effort:'unsupported', structuredOutput:'unsupported', turnLimit:'unsupported', budgetLimit:'unsupported' },
      build(req){ const a=['--go']; if(req.model) a.push('--model', req.model); a.push(req.prompt); return { args:a }; },
      probe(){ return {}; },
    };`);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'mycli', '--brief', b, '--workspace', repo, '--model', 'm1', '--dry-run'], { cwd: repo });
  assert.ok(res.json.args.includes('--go') && res.json.args.includes('m1'), 'a third-party adapter drives dispatch like any built-in');
});

test('a malformed project adapter is rejected with a clear error, not loaded', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  const dir = path.join(repo, '.delegate-fleet', 'adapters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.js'), "module.exports = { id:'bad', cli:'bad', capabilities:{}, build(){}, probe(){} };");
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /capability/);
});

/* ------------------------------------------------------------------ *
 * Discovery and doctor
 * ------------------------------------------------------------------ */

test('doctor records evidence and never removes an absent backend', () => {
  const repo = H.tmpRepo();
  const res = H.runFleet(['doctor', '--backend', 'kimi', '--workspace', repo, '--json'], { cwd: repo, env: { PATH: '/nonexistent' } });
  assert.strictEqual(res.json.rows[0].availability, 'unavailable');
  const view = H.runFleet(['discover', '--workspace', repo, '--json'], { cwd: repo, env: { PATH: '/nonexistent' } });
  assert.ok(view.json.backends.some((b) => b.id === 'kimi' && b.supported === true));
});

test('the relay never verifies or accepts on the orchestrator behalf', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(res.json.verification.performedByRelay, false);
  assert.strictEqual(res.json.verification.requiredFromOrchestrator, true);
  assert.strictEqual(res.json.acceptance.accepted, null);
  assert.strictEqual(res.json.acceptance.decidedBy, 'orchestrator');
});


/* ------------------------------------------------------------------ *
 * Regressions found in adversarial review
 * ------------------------------------------------------------------ */

test('--out-dir is honoured (every option must reach something)', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const out = path.join(repo, 'custom-artifacts');
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--out-dir', out, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(res.json.artifacts.dir, out);
  assert.ok(fs.existsSync(path.join(out, 'result.json')));
});

test('discover output carries no stray internal fields', () => {
  const repo = H.tmpRepo();
  const res = H.runFleet(['discover', '--workspace', repo, '--json'], { cwd: repo });
  const allowed = new Set(['id', 'title', 'cli', 'cliPath', 'supported', 'availability', 'declaredCapabilities', 'capabilities', 'localVerification', 'staleVerification', 'defaults', 'docs', 'staticEvidence', 'tier']);
  for (const b of res.json.backends) {
    for (const k of Object.keys(b)) assert.ok(allowed.has(k), `unexpected field "${k}" in discover output`);
  }
});

test('two concurrent runs of the same brief in one workspace get separate run dirs', async () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const { spawn } = require('node:child_process');
  await Promise.all([0, 1].map((i) => new Promise((resolve) => {
    const p = spawn(process.execPath, [H.RELAY, '--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
      cwd: repo, env: { ...process.env, STUB_CREATE: `c-${i}.js`, STUB_SLEEP: '400' },
    });
    p.stdout.resume(); p.stderr.resume();
    p.on('close', resolve);
  })));
  const runs = fs.readdirSync(path.join(repo, '.delegate-fleet', 'runs'));
  assert.strictEqual(runs.length, 2, 'concurrent runs must not share an artifact directory');
});

test('the backends reference table matches the adapters exactly', () => {
  const doc = fs.readFileSync(path.join(H.SKILL, 'references', 'backends.md'), 'utf8');
  const mark = { verified: 'verified', documented: 'documented', unsupported: '—', unknown: 'unknown' };
  for (const a of registry.BUILT_IN) {
    const row = doc.split('\n').find((l) => l.startsWith(`| \`${a.id}\` |`));
    assert.ok(row, `backends.md has no row for "${a.id}"`);
    const cells = row.split('|').map((c) => c.trim());
    assert.strictEqual(cells[2], `\`${a.cli}\``, `${a.id}: documented CLI name is stale`);
    capabilities.CAPABILITY_NAMES.forEach((name, i) => {
      assert.strictEqual(cells[3 + i], mark[a.capabilities[name]], `${a.id}.${name}: docs disagree with the adapter`);
    });
    assert.strictEqual(cells[3 + capabilities.CAPABILITY_NAMES.length], a.promptDelivery || 'argv', `${a.id}: documented prompt delivery is stale`);
  }
});

test('no adapter claims a capability its build() cannot express', () => {
  for (const a of registry.BUILT_IN) {
    const src = a.build.toString();
    if (capabilities.claims(a.capabilities.modelSelection)) assert.match(src, /req\.model/, `${a.id} claims modelSelection but build() ignores req.model`);
    if (capabilities.claims(a.capabilities.effort)) assert.match(src, /req\.effort/, `${a.id} claims effort but build() ignores req.effort`);
    if (capabilities.claims(a.capabilities.resumeById)) assert.match(src, /req\.session/, `${a.id} claims resumeById but build() ignores req.session`);
    if (capabilities.claims(a.capabilities.readOnly)) assert.match(src, /req\.mode/, `${a.id} claims readOnly but build() ignores req.mode`);
    if (capabilities.claims(a.capabilities.turnLimit)) assert.match(src, /req\.maxTurns/, `${a.id} claims turnLimit but build() ignores req.maxTurns`);
    if (capabilities.claims(a.capabilities.budgetLimit)) assert.match(src, /req\.maxBudgetUsd/, `${a.id} claims budgetLimit but build() ignores req.maxBudgetUsd`);
  }
});

test('an adapter that delivers the brief by file actually consumes promptFile', () => {
  for (const a of registry.BUILT_IN) {
    const src = a.build.toString();
    if (a.promptDelivery === 'file') assert.match(src, /req\.promptFile/, `${a.id}: promptDelivery "file" but build() never uses req.promptFile`);
    if (!a.promptDelivery || a.promptDelivery === 'argv') assert.match(src, /req\.prompt\b/, `${a.id}: argv delivery but build() never puts the prompt in argv`);
  }
});

/* ------------------------------------------------------------------ *
 * Regressions from the PR review of 2026-09-21
 * ------------------------------------------------------------------ */

test('"verified" never comes from an adapter\'s own declaration', () => {
  // An adapter file records what its author proved on THEIR machine. Treating
  // that as local proof would let a declaration walk straight past the
  // safety gate this framework is built around.
  for (const a of registry.BUILT_IN) {
    const merged = capabilities.applyLocalEvidence(a.capabilities, null);
    for (const name of capabilities.CAPABILITY_NAMES) {
      assert.notStrictEqual(
        merged[name], capabilities.EVIDENCE.verified,
        `${a.id}.${name} reads as locally verified with no doctor record`
      );
    }
  }
});

test('local evidence still promotes and still demotes', () => {
  const declared = { ...ALL_CAPS, readOnly: 'documented' };
  const promoted = capabilities.applyLocalEvidence(declared, { readOnly: 'verified' });
  assert.strictEqual(promoted.readOnly, 'verified');
  const demoted = capabilities.applyLocalEvidence(declared, { readOnly: 'unsupported' });
  assert.strictEqual(demoted.readOnly, 'unsupported');
});

test('e2e: a fresh successful probe authorizes read-only without a saved record', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'cursor'); // cursor declares readOnly: verified, and no doctor ran
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'cursor', '--read-only', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.request.mode, 'read-only');
});

test('e2e: --allow-unverified is the explicit way past that refusal', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'grok');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'grok', '--read-only', '--allow-unverified', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_HELP_TEXT: '--sandbox <PROFILE>\n' },
  });
  assert.strictEqual(res.json.status, 'completed');
  assert.ok(res.json.warnings.some((w) => /--allow-unverified/.test(w)), 'the risk must be stated in the result');
});

test('no probe can promote a capability its build() cannot express', () => {
  // Help text says which flags EXIST, not which ones this adapter passes.
  const help = [
    '--read-only --plan --plan-only --sandbox read-only --model --variant --effort',
    '--session --resume --conversation --agent plan --auto --auto-approve --yolo',
    '--permission-mode acceptEdits auto --approval-mode yolo --format json',
    '--output-format --allow-all-tools --deny-tool --mode plan --always-approve --prompt --dir',
    '--max-turns --max-budget-usd',
  ].join('\n');
  for (const a of registry.BUILT_IN) {
    const raw = a.probe(help) || {};
    const expressible = capabilities.expressibleCapabilities(a);
    for (const name of capabilities.CAPABILITY_NAMES) {
      if (expressible.has(name)) continue;
      assert.ok(
        !capabilities.claims(raw[name]),
        `${a.id}: probe claims ${name} but build() never reads it`
      );
    }
  }
});

test('no adapter passes read-only off as merely omitting its write flag', () => {
  // Relying on a CLI's default permissions is a hope, not an enforcement.
  const help = '--read-only --plan --sandbox read-only --agent plan --auto-approve --permission-mode plan --approval-mode plan --mode plan --deny-tool';
  for (const a of registry.BUILT_IN) {
    const raw = a.probe(help) || {};
    if (!capabilities.claims(raw.readOnly)) continue;
    assert.ok(
      capabilities.enforcesReadOnly(a),
      `${a.id}: read-only argv adds nothing the edit argv does not already have`
    );
  }
});

test('an adapter claiming a capability its build() ignores is rejected at load time', () => {
  const bad = {
    id: 'decorative', cli: 'decorative',
    capabilities: { ...ALL_CAPS, modelSelection: 'documented', edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported', turnLimit: 'unsupported', budgetLimit: 'unsupported' },
    build(req) { return { args: [req.prompt] }; },
    probe() { return {}; },
  };
  assert.throws(() => registry.assertShape(bad), /does not express it from model/);
});

test('an adapter claiming turnLimit or budgetLimit without build() expressing it is rejected at load time', () => {
  const badTurn = {
    id: 'fake-turn', cli: 'fake',
    capabilities: {
      edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported',
      modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported',
      turnLimit: 'documented', budgetLimit: 'unsupported',
    },
    build(req) { return { args: [req.prompt] }; },
    probe() { return {}; },
  };
  assert.throws(() => registry.assertShape(badTurn), /does not express it from maxTurns/);

  const badBudget = {
    id: 'fake-budget', cli: 'fake',
    capabilities: {
      edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported',
      modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported',
      turnLimit: 'unsupported', budgetLimit: 'documented',
    },
    build(req) { return { args: [req.prompt] }; },
    probe() { return {}; },
  };
  assert.throws(() => registry.assertShape(badBudget), /does not express it from maxBudgetUsd/);
});

test('an adapter with a non-string id or cli is rejected at load time', () => {
  const base = { capabilities: { edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported', modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported', turnLimit: 'unsupported', budgetLimit: 'unsupported' }, build: (req) => ({ args: [req.prompt] }), probe: () => ({}) };
  assert.throws(() => registry.assertShape({ ...base, id: 7, cli: 'x' }), /id as a non-empty string/);
  assert.throws(() => registry.assertShape({ ...base, id: 'x', cli: 7 }), /cli as a non-empty string/);
});

test('e2e: a worker writing into .delegate-fleet/ is reported, not filtered away', () => {
  // The next run would load that file with require(). It must never be hidden.
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_CREATE: '.delegate-fleet/adapters/evil.js' },
  });
  const violation = res.json.findings.find((f) => f.type === 'scope_violation');
  assert.ok(violation, 'a planted adapter is a scope violation');
  assert.ok(violation.paths.some((p) => p.includes('adapters/evil.js')), violation.paths.join(','));
  assert.strictEqual(res.json.blocked, true);
});

test('e2e: a configured model is capability-checked, not waved through', () => {
  // v1 applied config defaults after validation, so config could smuggle a
  // flag the backend cannot honour into the invocation.
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'zcode', { model: 'glm-4.6' }); // zcode cannot select a model
  H.markVerified(repo, 'zcode', { ...ALL_CAPS, modelSelection: 'unsupported' });
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'zcode', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /modelSelection/);
});

test('a first commit in a repository with no HEAD is still a worker commit', () => {
  const before = { ok: true, entries: new Map(), head: null, stash: null };
  const after = { ok: true, entries: new Map(), head: 'abc1234', stash: null };
  assert.strictEqual(repoLib.diffSnapshots(before, after).headChanged, true);
});

test('a same-size rewrite is detected however large the file is', () => {
  const dir = H.tmpRepo();
  const file = path.join(dir, 'big.bin');
  fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x41));
  const first = repoLib.hashFile(file);
  fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024, 0x42)); // same size
  assert.notStrictEqual(repoLib.hashFile(file), first, 'a size-and-mtime shortcut would miss this');
});

test('a scope of "." is the repository root and contains everything', () => {
  const r = repoLib.reconcileScope(['src/a.js', 'deep/nested/b.ts'], ['.']);
  assert.deepStrictEqual(r.outOfScope, []);
  assert.strictEqual(r.inScope.length, 2);
});

test('a deny marker never masks a non-zero exit', () => {
  const out = contract.deriveStatus({
    execResult: { outcome: 'exit', exitCode: 3, signal: null, stdout: 'permission denied', stderr: '' },
    mode: 'edit', diff: null, denyPatterns: [/permission denied/i],
  });
  assert.strictEqual(out.status, 'process_failure');
  assert.match(out.reason, /exited 3/);
});

test('a deny marker still classifies a cooperative exit 0', () => {
  const out = contract.deriveStatus({
    execResult: { outcome: 'exit', exitCode: 0, signal: null, stdout: 'permission denied', stderr: '' },
    mode: 'read-only', diff: null, denyPatterns: [/permission denied/i],
  });
  assert.strictEqual(out.status, 'implementer_failure');
});

test('a read-only violation names both ends of a rename', () => {
  const diff = {
    created: [], modified: [], deleted: [], renamed: [{ from: 'old.js', to: 'new.js' }],
    preExistingModified: [], vanished: [], headChanged: false, stashChanged: false,
  };
  const findings = contract.deriveFindings({ mode: 'read-only', diff, scopeReport: { outOfScope: [] } });
  const violation = findings.find((f) => f.type === 'read_only_violation');
  assert.deepStrictEqual(violation.paths, ['new.js', 'old.js']);
});

test('a run whose repository could not be observed is blocked', () => {
  const res = contract.buildResult({
    status: contract.STATUS.COMPLETED, findings: [],
    repository: { observed: false, reason: 'git unavailable' },
  });
  assert.strictEqual(res.blocked, true, 'an unchecked run is not a clean run');
});

test('a nested "### Scope" cannot shadow the real "## Scope"', () => {
  const md = `# Objective\n\n### Scope\n- \`decoy.js\`\n\n## Scope\n- \`src/real.js\`\n\n## Acceptance criteria\n1. a\n2. b\n`;
  assert.deepStrictEqual(brief.extractScope(md), ['src/real.js']);
});

test('an empty "## Acceptance criteria" section is rejected', () => {
  const md = H.GOOD_BRIEF.replace(/## Acceptance criteria\n1\. The component is renamed\n2\. Every import of it resolves\n/, '## Acceptance criteria\n\n');
  const lint = brief.lint(md);
  assert.strictEqual(lint.ok, false);
  assert.ok(lint.errors.some((e) => /Acceptance criteria" is empty/.test(e)), lint.errors.join('; '));
});

test('a malformed config.json is an error, never a silent fall-back', () => {
  const repo = H.tmpRepo();
  fs.mkdirSync(path.join(repo, '.delegate-fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.delegate-fleet', 'config.json'), '{ "workers": { ');
  const cfg = environment.loadConfig(repo);
  assert.ok(cfg.errors.some((e) => /could not be read as JSON/.test(e)), cfg.errors.join('; '));
});

test('a config whose "workers" is not an object is rejected', () => {
  for (const bad of ['[]', 'null', '3', '"x"']) {
    const repo = H.tmpRepo();
    fs.mkdirSync(path.join(repo, '.delegate-fleet'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.delegate-fleet', 'config.json'), `{ "workers": ${bad} }`);
    const cfg = environment.loadConfig(repo);
    assert.ok(cfg.errors.length > 0, `workers: ${bad} was accepted`);
  }
});

test('verification recorded for a different executable is discarded', () => {
  const adapter = registry.getAdapter('claude');
  const verification = { backends: { claude: { at: 'then', capabilities: ALL_CAPS, cliPath: '/nowhere/old-claude' } } };
  const view = environment.inspect(adapter, {
    config: { workers: { claude: { cli: H.STUB } } }, verification, env: process.env,
  });
  assert.strictEqual(view.localVerification, null, 'evidence is about a binary, not an id');
  assert.ok(view.staleVerification, 'and the reader must be told why it was dropped');
  assert.strictEqual(view.capabilities.readOnly, 'documented');
});

test('doctor drops stale evidence when re-verification fails', () => {
  const repo = H.tmpRepo();
  H.markVerified(repo, 'aider', ALL_CAPS);
  H.useStub(repo, 'aider', { cli: path.join(repo, 'guaranteed-missing-aider') });
  H.runFleet(['doctor', '--backend', 'aider', '--workspace', repo], { cwd: repo });
  const saved = JSON.parse(fs.readFileSync(path.join(repo, '.delegate-fleet', 'verification.json'), 'utf8'));
  assert.ok(!saved.backends.aider, 'evidence from an older CLI must not authorise a later run');
});

test('a fleet option with no value is an error, not a silent widening', () => {
  const repo = H.tmpRepo();
  const res = H.runFleet(['doctor', '--backend', '--workspace', repo], { cwd: repo });
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /--backend requires a value/);
});

test('captured output is capped in bytes and never splits a character', () => {
  const sink = require('../scripts/lib/exec.js').makeSink(64);
  const text = 'é'.repeat(100); // two bytes per character
  const buf = Buffer.from(text, 'utf8');
  for (let i = 0; i < buf.length; i++) sink.push(buf.subarray(i, i + 1)); // worst case: one byte at a time
  assert.ok(sink.truncated);
  assert.ok(!sink.value.includes('�'), 'no character may be corrupted at a chunk boundary');
  assert.strictEqual(sink.value.split('\n')[0], 'é'.repeat(32), 'the cap counts bytes, not code units');
});

test('a structuredOutput claim must appear in the built invocation', () => {
  // The capability has no per-run switch, so nothing else would catch an
  // adapter that claims it and then emits a human-readable stream.
  for (const a of registry.BUILT_IN) {
    if (!capabilities.claims(a.capabilities.structuredOutput)) continue;
    assert.ok(
      capabilities.deliversStructuredOutput(a),
      `${a.id}: claims structuredOutput but build() asks for no machine-readable format`
    );
  }
});

test('an adapter claiming structured output it never requests is rejected at load time', () => {
  const bad = {
    id: 'chatty', cli: 'chatty',
    capabilities: {
      edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported',
      modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'documented',
      turnLimit: 'unsupported', budgetLimit: 'unsupported',
    },
    build(req) { return { args: ['--output', 'streaming', req.prompt] }; },
    probe() { return {}; },
  };
  assert.throws(() => registry.assertShape(bad), /does not express it/);
});

test('an adapter claiming read-only it does not enforce is rejected at load time', () => {
  const bad = {
    id: 'hopeful', cli: 'hopeful',
    capabilities: {
      edit: 'documented', readOnly: 'documented', resumeById: 'unsupported',
      modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported',
      turnLimit: 'unsupported', budgetLimit: 'unsupported',
    },
    // Omits --yes in read-only mode and trusts the CLI's default. That is a
    // hope, not an enforcement.
    build(req) { const a = []; if (req.mode !== 'read-only') a.push('--yes'); a.push(req.prompt); return { args: a }; },
    probe() { return {}; },
  };
  assert.throws(() => registry.assertShape(bad), /does not express it|no recognized restriction/);
});

test('a verification record that does not identify its executable is unusable', () => {
  const adapter = registry.getAdapter('claude');
  const verification = { backends: { claude: { at: 'then', capabilities: ALL_CAPS } } }; // no cli identity
  const view = environment.inspect(adapter, {
    config: { workers: { claude: { cli: H.STUB } } }, verification, env: process.env,
  });
  assert.strictEqual(view.localVerification, null);
  assert.strictEqual(view.capabilities.readOnly, 'documented');
});

test('a verification record is discarded when the binary at that path is replaced', () => {
  const repo = H.tmpRepo();
  const fake = path.join(repo, 'fake-cli');
  fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const adapter = registry.getAdapter('claude');
  const config = { workers: { claude: { cli: fake } } };
  H.markVerified(repo, 'claude', ALL_CAPS, fake);
  const verification = JSON.parse(fs.readFileSync(path.join(repo, '.delegate-fleet', 'verification.json'), 'utf8'));

  const fresh = environment.inspect(adapter, { config, verification, env: process.env });
  assert.strictEqual(fresh.capabilities.readOnly, 'verified', 'the record must apply to the binary it came from');

  // An upgrade replaces the file in place: same path, different bytes.
  fs.writeFileSync(fake, '#!/bin/sh\necho upgraded\nexit 0\n', { mode: 0o755 });
  const after = environment.inspect(adapter, { config, verification, env: process.env });
  assert.strictEqual(after.localVerification, null, 'evidence about the old binary must not survive');
  assert.ok(after.staleVerification);
  assert.strictEqual(after.capabilities.readOnly, 'documented');
});

test('a nested repository whose state cannot be read poisons the snapshot', () => {
  // A stable hash built from a failed probe would read as "unchanged" on both
  // sides of a run and hide the edit this module exists to catch.
  const repo = H.tmpRepo({ files: { 'a.js': 'x\n' } });
  const nested = path.join(repo, 'vendor');
  fs.mkdirSync(nested, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: nested, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(nested, 'dep.js'), 'y\n');
  git('add', '-A'); git('commit', '-qm', 'dep');
  assert.strictEqual(repoLib.hashFile(nested).startsWith('dir:'), true, 'a healthy nested repo hashes by its own state');

  fs.writeFileSync(path.join(nested, '.git', 'index'), 'GARBAGE'); // rev-parse works, status does not
  assert.strictEqual(repoLib.hashFile(nested), repoLib.UNREADABLE);
  const snap = repoLib.snapshot(repo);
  assert.strictEqual(snap.ok, false, 'the snapshot must refuse rather than report a clean tree');
  assert.match(snap.reason, /could not establish the state/);
});

test('a config file that cannot be read is an error, not an absent file', () => {
  const repo = H.tmpRepo();
  // A directory where the file should be: readFileSync fails with EISDIR.
  fs.mkdirSync(path.join(repo, '.delegate-fleet', 'config.json'), { recursive: true });
  const cfg = environment.loadConfig(repo);
  assert.ok(cfg.errors.length > 0, 'a read failure must not become "use the defaults"');
  assert.match(cfg.errors[0], /could not be read/);
});

test('a forged verification file cannot authorize read-only dispatch', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude');
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--read-only', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_HELP_TEXT: '--permission-mode acceptEdits\n' },
  });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /readOnly/);
});

test('a forged verification file cannot enter verified-only selection', () => {
  const repo = H.tmpRepo();
  H.useStub(repo, 'claude');
  H.markVerified(repo, 'claude', ALL_CAPS);
  const res = H.runFleet(['select', '--need', 'readOnly', '--verified', '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_HELP_TEXT: '--permission-mode acceptEdits\n' },
  });
  assert.ok(!res.json.matches.includes('claude'));
});

test('opencode read-only requires a successful agent-list probe naming plan', () => {
  const adapter = registry.getAdapter('opencode');
  const config = { workers: { opencode: { cli: H.STUB } } };
  const present = environment.verify(adapter, { config, env: { ...process.env, STUB_AGENT_LIST: 'plan\nbuild\n' } });
  const missing = environment.verify(adapter, { config, env: { ...process.env, STUB_AGENT_LIST: 'build\n' } });
  assert.strictEqual(present.capabilities.readOnly, 'verified');
  assert.strictEqual(missing.capabilities.readOnly, 'unknown');
});

test('grok does not borrow read-only or JSON values from another option', () => {
  const adapter = registry.getAdapter('grok');
  const misleading = '--sandbox <PROFILE>\n--other read-only\n--output-format <FORMAT>\n--other json\n';
  const states = adapter.probe(misleading);
  assert.strictEqual(states.readOnly, 'unknown');
  assert.strictEqual(states.structuredOutput, 'unknown');
  const direct = adapter.probe('--sandbox read-only\n--output-format json\n');
  assert.strictEqual(direct.readOnly, 'verified');
  assert.strictEqual(direct.structuredOutput, 'verified');
});

test('capability checks work when build destructures its request', () => {
  const adapter = {
    build({ prompt, mode, model }) {
      return { args: ['--prompt', prompt, '--sandbox', mode === 'read-only' ? 'read-only' : 'workspace', '--model', model || 'default'] };
    },
  };
  const expressible = capabilities.expressibleCapabilities(adapter);
  assert.ok(expressible.has('modelSelection'));
  assert.ok(expressible.has('readOnly'));
});

test('an unrelated extra read-only argument is not an enforcement contract', () => {
  const adapter = { build({ mode }) { return { args: mode === 'read-only' ? ['--verbose'] : [] }; } };
  assert.strictEqual(capabilities.enforcesReadOnly(adapter), false);
});

test('an edit claim without a task-bearing invocation is rejected', () => {
  const adapter = {
    id: 'empty-edit', cli: 'empty-edit',
    capabilities: {
      edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported',
      modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported',
      turnLimit: 'unsupported', budgetLimit: 'unsupported',
    },
    build() { return { args: ['--verbose'] }; },
    probe() { return { edit: 'verified' }; },
  };
  assert.throws(() => registry.assertShape(adapter), /claims edit.*does not express it/);
});

test('a planted ignored adapter remains visible to the scope check', () => {
  const repo = H.tmpRepo({ files: { '.gitignore': '.delegate-fleet/\n', 'src/a.js': 'x\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_CREATE: '.delegate-fleet/adapters/evil.js' },
  });
  assert.ok(res.json.findings.some((f) => f.type === 'scope_violation' && f.paths.includes('.delegate-fleet/adapters/evil.js')));
});

test('a nested repository with an unborn HEAD is a valid snapshot', () => {
  const repo = H.tmpRepo({ files: { 'a.js': 'x\n' } });
  const nested = path.join(repo, 'vendor');
  fs.mkdirSync(nested);
  spawnSync('git', ['init', '-q'], { cwd: nested });
  fs.writeFileSync(path.join(nested, 'uncommitted.js'), 'y\n');
  const hash = repoLib.hashFile(nested);
  assert.ok(hash.startsWith('dir:'), hash);
});

test('a malformed helpArgs array is rejected while loading an adapter', () => {
  const base = registry.getAdapter('aider');
  assert.throws(() => registry.assertShape({ ...base, helpArgs: 'run --help' }), /helpArgs must be an array/);
});

test('JSON discovery includes project adapter errors', () => {
  const repo = H.tmpRepo();
  const dir = path.join(repo, '.delegate-fleet', 'adapters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.js'), 'module.exports = {}\n');
  const res = H.runFleet(['discover', '--workspace', repo, '--json'], { cwd: repo });
  assert.ok(res.json.adapterErrors.some((e) => e.includes('broken.js')));
});

/* ------------------------------------------------------------------ *
 * Regression suite: framework state protection, operational limits, and adapter resilience
 * ------------------------------------------------------------------ */

test('e2e: worker writing .delegate-fleet/config.json in an ignored repository is still reported and blocked', () => {
  const repo = H.tmpRepo({ files: { '.gitignore': '.delegate-fleet/\n', 'src/a.js': 'x\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_CREATE: '.delegate-fleet/config.json' },
  });
  const modified = res.json.repository.changed.created.concat(res.json.repository.changed.modified);
  assert.ok(modified.includes('.delegate-fleet/config.json'), 'config.json creation must be reported even when gitignored');
  assert.ok(res.json.findings.some((f) => f.type === 'framework_state_modified' && f.paths.includes('.delegate-fleet/config.json')));
  assert.strictEqual(res.json.blocked, true);
});

test('e2e: planting an adapter under .delegate-fleet/adapters/ with broad scope reports framework_state_modified and blocks', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const broadBrief = H.GOOD_BRIEF.replace('`src/a.js`', '`.`');
  const b = H.writeBrief(repo, broadBrief);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_CREATE: '.delegate-fleet/adapters/evil.js' },
  });
  const f = res.json.findings.find((x) => x.type === 'framework_state_modified');
  assert.ok(f, 'expected framework_state_modified finding despite broad scope');
  assert.ok(f.paths.includes('.delegate-fleet/adapters/evil.js'));
  assert.strictEqual(res.json.blocked, true);
});

test('e2e: relay run artifacts under .delegate-fleet/runs/ are not attributed to the worker', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const runBDir = path.join(repo, '.delegate-fleet', 'runs', '2026-run-b');
  fs.mkdirSync(runBDir, { recursive: true });
  fs.writeFileSync(path.join(runBDir, 'stdout.log'), 'run b log\n');
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_MODIFY: 'src/a.js' },
  });
  const allChanged = repoLib.changedPaths(res.json.repository.changed);
  assert.ok(!allChanged.some((p) => p.startsWith('.delegate-fleet/runs')), 'run artifacts must never be attributed to worker');
  assert.strictEqual(res.json.blocked, false);
});

test('malformed verification.json raises relay warning and falls back safely', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo);
  const vf = path.join(repo, '.delegate-fleet', 'verification.json');
  fs.mkdirSync(path.dirname(vf), { recursive: true });
  fs.writeFileSync(vf, '{ invalid json');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo, env: { STUB_MODIFY: 'src/a.js' },
  });
  assert.ok(res.json.warnings.some((w) => /verification\.json.*could not be read.*nothing is verified/i.test(w)),
    `expected verification warning in ${JSON.stringify(res.json.warnings)}`);
});

test('deny pattern match with observed changes keeps status completed and warns', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo,
    env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: 'Error: permission denied when touching /etc/shadow' },
  });
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.blocked, false);
  assert.ok(res.json.warnings.some((w) => /matched deny pattern.*repository changes were observed/i.test(w)));
});

test('e2e: in-scope worker file create, delete, and rename succeeds without findings', () => {
  const repo = H.tmpRepo({ files: { 'src/old.js': 'old\n', 'src/delete-me.js': 'del\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const scopeBrief = H.GOOD_BRIEF.replace('`src/a.js`', '`src/`');
  const b = H.writeBrief(repo, scopeBrief);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo,
    env: {
      STUB_CREATE: 'src/created.js',
      STUB_DELETE: 'src/delete-me.js',
      STUB_RENAME: 'src/old.js:src/new.js',
    },
  });
  assert.ok(res.json.repository.changed.created.includes('src/created.js'));
  assert.ok(res.json.repository.changed.deleted.includes('src/delete-me.js'));
  assert.ok(res.json.repository.changed.renamed.some((r) => r.from === 'src/old.js' && r.to === 'src/new.js'));
  assert.strictEqual(res.json.findings.length, 0);
  assert.strictEqual(res.json.blocked, false);
});

test('e2e: worker timeout reports timeout status with partial edits visible', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'orig\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--timeout', '1', '--json'], {
    cwd: repo,
    env: { STUB_MODIFY: 'src/a.js', STUB_SLEEP: '3000' },
  });
  assert.strictEqual(res.json.status, 'timeout');
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js']);
  assert.strictEqual(res.json.blocked, true);
});

test('missing CLI reports backend_unavailable and dispatches nothing', () => {
  const repo = H.tmpRepo();
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'copilot', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo,
    env: { PATH: '' },
  });
  assert.strictEqual(res.json.status, 'backend_unavailable');
  assert.strictEqual(res.status, 2);
  assert.ok(!fs.existsSync(path.join(repo, '.delegate-fleet', 'runs')));
});

test('stale verification discards evidence, raises warning, and refuses read-only', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'grok');
  const dir = path.join(repo, '.delegate-fleet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({
    backends: {
      grok: {
        at: new Date().toISOString(), platform: process.platform, version: 'old',
        cliPath: H.STUB, cli: { path: H.STUB, size: 999999, mtimeMs: 123456 },
        capabilities: ALL_CAPS,
      },
    },
  }));
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--read-only', '--json'], {
    cwd: repo,
    env: { STUB_HELP_TEXT: '--sandbox <PROFILE>\n' },
  });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.ok(res.json.warnings.some((w) => /local verification for "grok".*discarded/i.test(w)));
});

test('e2e: malformed non-JSON worker output does not crash relay or corrupt result', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
    cwd: repo,
    env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: '<<<not json>>>\n{unclosed' },
  });
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.blocked, false);
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js']);
});

test('recorded unsupported readOnly beats allow-unverified when probe is inconclusive', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude');
  H.markVerified(repo, 'claude', { ...ALL_CAPS, readOnly: 'unsupported' });
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--read-only', '--allow-unverified', '--json'], {
    cwd: repo,
    env: { STUB_HELP_TEXT: '--other\n' },
  });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /readOnly/);
});

test('e2e: a FIFO planted under .delegate-fleet fails the snapshot closed', () => {
  if (process.platform === 'win32') return;
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo);
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const fifoPath = path.join(repo, '.delegate-fleet', 'adapters', 'fifo.pipe');
  fs.mkdirSync(path.dirname(fifoPath), { recursive: true });
  spawnSync('mkfifo', [fifoPath]);
  try {
    const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], {
      cwd: repo,
      env: { STUB_MODIFY: 'src/a.js' },
    });
    assert.strictEqual(res.json.repository.observed, false);
    assert.strictEqual(res.json.blocked, true);
  } finally {
    try { fs.unlinkSync(fifoPath); } catch {}
  }
});

test('symlinked directory under .delegate-fleet is not traversed', () => {
  const repo = H.tmpRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'df-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  const symlinkTarget = path.join(repo, '.delegate-fleet', 'adapters', 'linked-dir');
  fs.mkdirSync(path.dirname(symlinkTarget), { recursive: true });
  try {
    fs.symlinkSync(outside, symlinkTarget, 'dir');
  } catch {
    return;
  }
  const entries = repoLib.localFrameworkStateEntries(repo);
  assert.ok(entries.includes('.delegate-fleet/adapters/linked-dir'));
  assert.ok(!entries.some((e) => e.includes('secret.txt')));
  fs.rmSync(outside, { recursive: true, force: true });
});

test('assertShape rejects empty helpArgs and empty inner evidenceArgs', () => {
  const base = registry.getAdapter('aider');
  assert.throws(() => registry.assertShape({ ...base, helpArgs: [] }), /helpArgs must be a non-empty array of strings/);
  assert.throws(() => registry.assertShape({ ...base, evidenceArgs: [[]] }), /evidenceArgs must be arrays of non-empty arrays of strings/);
});

test('adapter probe throwing does not crash doctor or select', () => {
  const repo = H.tmpRepo();
  H.useStub(repo);
  const dir = path.join(repo, '.delegate-fleet', 'adapters');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'exploding.js'), `
    module.exports = {
      id: 'exploding', cli: '${H.STUB}',
      capabilities: { edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported', modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported', turnLimit: 'unsupported', budgetLimit: 'unsupported' },
      build(req) { return { args: ['--print', req.prompt] }; },
      probe() { throw new Error('boom'); },
    };
  `);
  const docRes = H.runFleet(['doctor', '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(docRes.status, 0);
  const expRow = docRes.json.rows.find((r) => r.id === 'exploding');
  assert.ok(expRow);
  assert.strictEqual(expRow.capabilities, null);

  const selRes = H.runFleet(['select', '--need', 'edit', '--verified', '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(selRes.status, 0);
  assert.ok(!selRes.json.matches.includes('exploding'));
});

test('doctor and select refuse with exit 2 on broken config or adapter errors', () => {
  const repo = H.tmpRepo();
  const dir = path.join(repo, '.delegate-fleet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{ "workers": "not-an-object" }');
  const docRes = H.runFleet(['doctor', '--workspace', repo], { cwd: repo });
  assert.strictEqual(docRes.status, 2);
  const selRes = H.runFleet(['select', '--need', 'edit', '--workspace', repo], { cwd: repo });
  assert.strictEqual(selRes.status, 2);
});

test('brief that is a directory returns invalid_request', () => {
  const repo = H.tmpRepo();
  H.useStub(repo);
  const briefDir = path.join(repo, 'brief-dir');
  fs.mkdirSync(briefDir);
  const res = H.runRelay(['--backend', 'claude', '--brief', briefDir, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.ok(res.json.reason.includes('could not read brief'));
});

test('promptDelivery file cleans up temp directory during dry-run', () => {
  const repo = H.tmpRepo();
  H.useStub(repo, 'grok');
  H.markVerified(repo, 'grok', ALL_CAPS);
  const b = H.writeBrief(repo);
  const tmpBefore = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('delegate-fleet-'));
  const res = H.runRelay(['--backend', 'grok', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo });
  assert.strictEqual(res.status, 0);
  const tmpAfter = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('delegate-fleet-'));
  assert.deepStrictEqual(tmpBefore, tmpAfter, 'temp directories must be cleaned up after dry-run');
});

test('non-empty extra evidenceArgs prevents discarding evidence', () => {
  const adapter = registry.getAdapter('opencode');
  const config = { workers: { opencode: { cli: H.STUB } } };
  const res = environment.verify(adapter, { config, env: { ...process.env, STUB_HELP_TEXT: ' ', STUB_AGENT_LIST: 'plan\nbuild\n' } });
  assert.ok(res.capabilities);
  assert.strictEqual(res.capabilities.readOnly, 'unsupported');
  assert.strictEqual(res.reason, null);
});

test('backend.capabilitiesVerifiedLocally is true in the result when the relay\'s own fresh probe verified read-only with no saved doctor record', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude');
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--read-only', '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.backend.capabilitiesVerifiedLocally, true);
});

test('stub worker probe honours STUB_EXIT', () => {
  const res = spawnSync(process.execPath, [H.STUB, '--help'], { env: { ...process.env, STUB_EXIT: '42' } });
  assert.strictEqual(res.status, 42);
  const resList = spawnSync(process.execPath, [H.STUB, 'agent', 'list'], { env: { ...process.env, STUB_EXIT: '43' } });
  assert.strictEqual(resList.status, 43);
});

test('doctor records capabilities from an evidenceArgs probe even when --help and --version print nothing', () => {
  const repo = H.tmpRepo();
  const stubScript = path.join(repo, 'silent-cli.js');
  fs.writeFileSync(stubScript, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('--help')) {
  process.exit(0);
}
if (args[0] === 'agent' && args[1] === 'list') {
  process.stdout.write('plan\\nbuild\\n');
  process.exit(0);
}
process.exit(0);
`);
  fs.chmodSync(stubScript, 0o755);

  const adapter = {
    id: 'silent-worker',
    cli: stubScript,
    capabilities: {
      edit: 'documented',
      readOnly: 'documented',
      resumeById: 'unsupported',
      modelSelection: 'unsupported',
      effort: 'unsupported',
      structuredOutput: 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    },
    helpArgs: ['--help'],
    evidenceArgs: [['agent', 'list']],
    build(req) {
      const args = ['run', req.prompt];
      if (req.mode === 'read-only') args.push('--plan');
      return { args };
    },
    probe(help, evidence = {}) {
      const hasPlan = (evidence.extra || []).some((e) => /plan/.test(e));
      return {
        readOnly: hasPlan ? 'verified' : 'unsupported',
      };
    },
  };

  const res = environment.verify(adapter);
  assert.strictEqual(res.availability, 'available');
  assert.ok(res.capabilities, 'capabilities must be recorded despite empty help and version');
  assert.strictEqual(res.capabilities.readOnly, 'verified');
  assert.strictEqual(res.reason, null);
});

/* ------------------------------------------------------------------ *
 * Worker report: the orchestrator reads a summary, not the raw log
 * ------------------------------------------------------------------ */

test('report: a single result object yields summary, session and cumulative usage', () => {
  const out = JSON.stringify({
    type: 'result', result: 'Renamed Settings.\nChanged: src/a.js', session_id: 'sess-1',
    usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 5000 }, total_cost_usd: 0.0123,
  });
  const w = report.extract(out);
  assert.strictEqual(w.source, 'structured');
  assert.strictEqual(w.selfReported, true);
  assert.match(w.summary, /Changed: src\/a\.js/);
  assert.strictEqual(w.sessionId, 'sess-1');
  assert.deepStrictEqual(w.usage, { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 5000, costUsd: 0.0123 });
});

test('report: a JSON-lines event stream sums per-turn usage and keeps the last message', () => {
  const lines = [
    { type: 'thread.started', thread_id: 't-9' },
    { type: 'item.completed', item: { type: 'reasoning', text: 'thinking…' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first pass' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done: edited src/a.js' } },
    { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 } },
  ].map((o) => JSON.stringify(o)).join('\n');
  const w = report.extract(`some banner\n${lines}\n`);
  assert.strictEqual(w.summary, 'done: edited src/a.js');
  assert.strictEqual(w.sessionId, 't-9');
  assert.deepStrictEqual(w.usage, { inputTokens: 150, outputTokens: 15, cacheReadTokens: 40, costUsd: null });
});

test('report: step events with nested token parts and per-model stats are both understood', () => {
  const steps = [
    { type: 'text', part: { type: 'text', text: 'all set' } },
    { type: 'step_finish', part: { tokens: { input: 10, output: 2, cache: { read: 7 } }, cost: 0.001 } },
    { type: 'step_finish', part: { tokens: { input: 5, output: 1, cache: { read: 0 } }, cost: 0.002 } },
  ].map((o) => JSON.stringify(o)).join('\n');
  const a = report.extract(steps);
  assert.strictEqual(a.summary, 'all set');
  assert.deepStrictEqual(a.usage, { inputTokens: 15, outputTokens: 3, cacheReadTokens: 7, costUsd: 0.003 });
  const b = report.extract(JSON.stringify({ response: 'ok', stats: { models: { m: { tokens: { prompt: 9, candidates: 4, cached: 1 } } } } }));
  assert.deepStrictEqual(b.usage, { inputTokens: 9, outputTokens: 4, cacheReadTokens: 1, costUsd: null });
});

test('report: plain text falls back to a capped tail, and nothing becomes none', () => {
  const long = `${'x'.repeat(5000)}\nCHANGED src/a.js`;
  const w = report.extract(long);
  assert.strictEqual(w.source, 'text-tail');
  assert.ok(w.summaryTruncated);
  assert.ok(w.summary.length <= report.SUMMARY_CAP_CHARS + 1);
  assert.match(w.summary, /CHANGED src\/a\.js$/, 'the tail, where workers list their changes, is kept');
  assert.strictEqual(report.extract('').source, 'none');
  assert.strictEqual(report.extract(null).usage, null);
});

test('report: an adapter parseReport overrides the generic parser, and a throwing one degrades to none', () => {
  const w = report.extract('RAW', { parseReport: (s) => ({ summary: `parsed ${s}`, sessionId: 'x', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: null, costUsd: null } }) });
  assert.strictEqual(w.source, 'adapter');
  assert.strictEqual(w.summary, 'parsed RAW');
  assert.strictEqual(report.extract('RAW', { parseReport: () => { throw new Error('boom'); } }).source, 'none');
});

test('an adapter whose parseReport is not a function is refused at load time', () => {
  const base = registry.getAdapter('claude');
  assert.throws(() => registry.assertShape({ ...base, parseReport: 'nope' }), /parseReport must be a function/);
});

test('e2e: the worker report lands in result.json and never changes blocked', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const print = JSON.stringify({ type: 'result', result: 'I renamed it. Changed: src/a.js', session_id: 'abc', usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.5 });
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: print } });
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.blocked, false);
  assert.strictEqual(res.json.worker.summary, 'I renamed it. Changed: src/a.js');
  assert.strictEqual(res.json.worker.sessionId, 'abc');
  assert.strictEqual(res.json.worker.usage.costUsd, 0.5);
  const noop = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_PRINT: print } });
  assert.strictEqual(noop.json.status, 'noop', 'a worker claiming success does not override an unchanged tree');
  assert.strictEqual(noop.json.blocked, true);
});

/* ------------------------------------------------------------------ *
 * Checks: gates run by the relay, only the tail reaches the orchestrator
 * ------------------------------------------------------------------ */

const NODE = JSON.stringify(process.execPath);

test('check tokenizer honours quotes and refuses shell operators', () => {
  assert.deepStrictEqual(checksLib.tokenize(`pnpm test -- "src/a b.js" 'x y'`).argv, ['pnpm', 'test', '--', 'src/a b.js', 'x y']);
  assert.deepStrictEqual(checksLib.tokenize('a\\ b c').argv, ['a b', 'c']);
  for (const bad of ['pnpm test && pnpm lint', 'pnpm test | tee x', 'pnpm test > out', 'a ; b', '', '"unterminated']) {
    assert.ok(checksLib.tokenize(bad).error, `"${bad}" must be rejected`);
  }
  assert.deepStrictEqual(checksLib.tokenize('echo "a && b"').argv, ['echo', 'a && b'], 'a quoted operator is just text');
});

test('--check is refused with --read-only, and --check-timeout alone is refused', () => {
  assert.ok(options.parseArgs(['--read-only', '--check', 'pnpm test']).errors.some((e) => /read-only/.test(e)));
  assert.ok(options.parseArgs(['--check-timeout', '30']).errors.some((e) => /without any --check/.test(e)));
  assert.ok(options.parseArgs(['--check', 'a && b']).errors.length > 0);
});

test('e2e: passing checks are recorded with a tail and a full log, and do not block', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', `${NODE} -e "console.log('tests ok')"`], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.json.blocked, false);
  const [c] = res.json.verification.checks;
  assert.strictEqual(c.passed, true);
  assert.strictEqual(c.exitCode, 0);
  assert.match(c.tail, /tests ok/);
  assert.ok(fs.existsSync(c.log), 'the full output is an artifact');
  assert.strictEqual(res.json.verification.performedByRelay, true);
  assert.strictEqual(res.json.verification.requiredFromOrchestrator, true, 'passing gates never replace reading the diff');
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js'], 'check artifacts never leak into the worker diff');
});

test('e2e: a failing check blocks a completed run, and every check still runs', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', `${NODE} -e "console.error('2 failing'); process.exit(3)"`,
    '--check', `${NODE} -e "console.log('lint ok')"`], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(res.status, 1);
  assert.strictEqual(res.json.status, 'completed', 'the process succeeded; the gate is a separate fact');
  assert.strictEqual(res.json.blocked, true);
  const [fail, pass] = res.json.verification.checks;
  assert.strictEqual(fail.passed, false);
  assert.strictEqual(fail.exitCode, 3);
  assert.match(fail.tail, /2 failing/);
  assert.strictEqual(pass.passed, true);
});

test('text output shows why a check failed, and not the output of a passing one', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo,
    // Built at run time so the text can only come from the output, never from the echoed command.
    '--check', `${NODE} -e "console.error('TS23' + '04 cannot find Foo'); process.exit(2)"`,
    '--check', `${NODE} -e "console.log('noise from ' + 'a green gate')"`], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.match(res.stdout, /check FAIL[\s\S]*TS2304 cannot find Foo/);
  assert.doesNotMatch(res.stdout, /noise from a green gate/);
});

test('e2e: checks are skipped on a run that did not complete', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const marker = path.join(repo, 'ran.txt');
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', `${NODE} -e "require('fs').writeFileSync(${JSON.stringify(marker).replace(/"/g, "'")}, '1')"`], { cwd: repo });
  assert.strictEqual(res.json.status, 'noop');
  assert.strictEqual(res.json.verification.checks[0].outcome, 'skipped');
  assert.ok(!fs.existsSync(marker), 'a skipped check never ran');
  assert.ok(res.json.warnings.some((w) => /skipped/.test(w)));
});

test('e2e: a check that rewrites files is reported, never undone', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n', 'src/fmt.js': 'y\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', `${NODE} -e "require('fs').appendFileSync('src/fmt.js', 'formatted')"`], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.ok(res.json.warnings.some((w) => /checks themselves changed 1 path/.test(w) && /src\/fmt\.js/.test(w)));
  assert.match(fs.readFileSync(path.join(repo, 'src/fmt.js'), 'utf8'), /formatted/);
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js'], 'the worker is not blamed for the check');
});

test('--dry-run lists the checks it would run', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--dry-run', '--check', 'pnpm test -- src/a.js'], { cwd: repo });
  const plan = JSON.parse(res.stdout);
  assert.deepStrictEqual(plan.checks, [{ command: 'pnpm test -- src/a.js', argv: ['pnpm', 'test', '--', 'src/a.js'] }]);
});

/* ------------------------------------------------------------------ *
 * Cost tiers: capability filters, tier only orders
 * ------------------------------------------------------------------ */

test('an invalid tier is a config error', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude', { tier: 'free' });
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  assert.match(res.json.reason, /tier: expected one of cheap, standard, premium/);
});

test('select orders capable workers cheapest first, untiered last, and --max-tier filters', () => {
  const repo = H.tmpRepo();
  H.useStub(repo, 'claude', { tier: 'premium' });
  H.useStub(repo, 'codex', { tier: 'cheap' });
  H.useStub(repo, 'cursor', { tier: 'standard' });
  H.useStub(repo, 'opencode');
  const res = H.runFleet(['select', '--need', 'edit', '--workspace', repo, '--json'], { cwd: repo });
  const ids = res.json.matches.filter((id) => ['claude', 'codex', 'cursor', 'opencode'].includes(id));
  assert.deepStrictEqual(ids, ['codex', 'cursor', 'claude', 'opencode']);
  assert.strictEqual(res.json.workers.find((w) => w.id === 'codex').tier, 'cheap');
  const capped = H.runFleet(['select', '--need', 'edit', '--max-tier', 'standard', '--workspace', repo, '--json'], { cwd: repo });
  assert.deepStrictEqual(capped.json.matches, ['codex', 'cursor'], 'pricier and untiered workers are dropped under a ceiling');
  const bad = H.runFleet(['select', '--need', 'edit', '--max-tier', 'gold', '--workspace', repo], { cwd: repo });
  assert.strictEqual(bad.status, 2);
});

test('a tier never admits a worker that lacks the capability', () => {
  const repo = H.tmpRepo();
  H.useStub(repo, 'warp', { tier: 'cheap' });
  const res = H.runFleet(['select', '--need', 'edit,readOnly', '--workspace', repo, '--json'], { cwd: repo });
  assert.ok(!res.json.matches.includes('warp'));
});

test('the configured tier is recorded on the result', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude', { tier: 'cheap' }); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(res.json.backend.tier, 'cheap');
});

/* ------------------------------------------------------------------ *
 * Fix loop: failing checks go back to the SAME worker, bounded
 * ------------------------------------------------------------------ */

const NEEDS_FIXED = `${NODE} -e "const t=require('fs').readFileSync('src/a.js','utf8'); if(!t.includes('fixed')){console.error('FAIL: a.js is not fi'+'xed yet'); process.exit(1)}"`;

test('fix loop: a failing check is fed back to the same worker, which repairs it', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const echo = path.join(os.tmpdir(), `df-fix-echo-${process.pid}-${Date.now()}.txt`);
  const usage = JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 100, output_tokens: 10 }, total_cost_usd: 0.01 });
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', NEEDS_FIXED, '--fix-attempts', '2'], {
    cwd: repo,
    env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: usage, STUB_FIX_APPEND: 'src/a.js:fixed', STUB_FIX_ECHO: echo, STUB_FIX_PRINT: usage },
  });
  assert.strictEqual(res.status, 0, res.stdout);
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.blocked, false);
  assert.strictEqual(res.json.attempts.length, 2);
  assert.deepStrictEqual(res.json.attempts[0].checksFailed, [NEEDS_FIXED]);
  assert.deepStrictEqual(res.json.attempts[1].checksFailed, []);
  assert.strictEqual(res.json.verification.checks[0].passed, true);
  assert.strictEqual(res.json.execution.attempts, 2);
  assert.strictEqual(res.json.worker.usage.inputTokens, 200, 'usage is summed across attempts');
  assert.strictEqual(res.json.worker.usage.costUsd, 0.02);
  const prompt = fs.readFileSync(echo, 'utf8');
  assert.match(prompt, /FAIL: a\.js is not fixed yet/, 'the failing tail travels to the worker');
  assert.match(prompt, /yours to edit again: src\/a\.js/);
  assert.match(prompt, /--- BEGIN TASK BRIEF ---/, 'the original contract is repeated');
  assert.ok(fs.existsSync(path.join(res.json.artifacts.dir, 'attempt-2', 'stdout.log')));
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js']);
  assert.deepStrictEqual(res.json.findings, [], 'the worker re-editing its own file is not a pre-existing change');
  fs.rmSync(echo, { force: true });
});

test('fix loop: stops at the attempt limit and stays blocked', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', NEEDS_FIXED, '--fix-attempts', '2'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_FIX_APPEND: 'src/a.js:still-broken' } });
  assert.strictEqual(res.status, 1);
  assert.strictEqual(res.json.attempts.length, 3, 'one run plus exactly two fix attempts');
  assert.strictEqual(res.json.blocked, true);
  assert.strictEqual(res.json.verification.checks[0].passed, false);
});

test('fix loop: a fix attempt that changes nothing ends the loop without losing the work', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', NEEDS_FIXED, '--fix-attempts', '3'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(res.json.attempts.length, 2);
  assert.strictEqual(res.json.attempts[1].status, 'noop');
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.blocked, true, 'the checks still fail');
  assert.deepStrictEqual(res.json.repository.changed.modified, ['src/a.js']);
  assert.ok(res.json.warnings.some((w) => /changed nothing/.test(w)));
});

test('fix loop: never retries past a finding', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n', 'src/other.js': 'y\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', NEEDS_FIXED, '--fix-attempts', '2'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js,src/other.js', STUB_FIX_APPEND: 'src/a.js:fixed' } });
  assert.strictEqual(res.json.attempts.length, 1, 'a scope violation needs a human, not another attempt');
  assert.ok(res.json.findings.some((f) => f.type === 'scope_violation'));
});

test('fix loop: a violation made by a fix attempt is reported, and ends the loop', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json',
    '--check', NEEDS_FIXED, '--fix-attempts', '3'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_FIX_CREATE: 'surprise.js' } });
  assert.strictEqual(res.json.attempts.length, 2);
  const v = res.json.findings.find((f) => f.type === 'scope_violation');
  assert.ok(v && v.paths.includes('surprise.js'));
  assert.strictEqual(res.json.blocked, true);
});

test('--fix-attempts is validated, and a configured default only applies with checks', () => {
  assert.ok(options.parseArgs(['--fix-attempts', '1']).errors.some((e) => /needs at least one --check/.test(e)));
  assert.ok(options.parseArgs(['--fix-attempts', '4', '--check', 'x']).errors.some((e) => /0 to 3/.test(e)));
  assert.ok(options.parseArgs(['--fix-attempts', 'two', '--check', 'x']).errors.length > 0);
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude', { fixAttempts: 2 }); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const dry = JSON.parse(H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--dry-run', '--check', 'x'], { cwd: repo }).stdout);
  assert.strictEqual(dry.effective.fixAttempts, 2);
  const none = JSON.parse(H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo }).stdout);
  assert.strictEqual(none.effective.fixAttempts, 0);
  H.useStub(repo, 'claude', { fixAttempts: 9 });
  const bad = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.match(bad.json.reason, /fixAttempts: expected an integer from 0 to 3/);
});

/* ------------------------------------------------------------------ *
 * Routes: the model classifies, code owns the flags
 * ------------------------------------------------------------------ */

function writeConfig(repo, cfg) {
  const dir = path.join(repo, '.delegate-fleet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

test('route: the first installed, capable candidate runs with the route flags', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  writeConfig(repo, {
    workers: { aider: { cli: '/nonexistent/aider' }, claude: { cli: H.STUB, tier: 'cheap' } },
    routes: { mechanical: [{ backend: 'aider' }, { backend: 'claude', model: 'route-model', effort: 'low' }] },
  });
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const echo = path.join(repo, '.delegate-fleet', 'argv.json');
  const res = H.runRelay(['--route', 'mechanical', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_ECHO_ARGV: echo } });
  assert.strictEqual(res.json.status, 'completed');
  assert.strictEqual(res.json.backend.id, 'claude');
  assert.strictEqual(res.json.route.name, 'mechanical');
  assert.strictEqual(res.json.route.candidate, 1);
  assert.strictEqual(res.json.route.skipped[0].backend, 'aider');
  const argv = JSON.parse(fs.readFileSync(echo, 'utf8')).argv;
  assert.ok(argv.includes('route-model') && argv.includes('low'), 'the route owns the flags');
  assert.ok(res.json.warnings.some((w) => /fell through to claude/.test(w)));
});

test('route: explicit flags still beat the route', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  writeConfig(repo, { workers: { claude: { cli: H.STUB } }, routes: { mechanical: { backend: 'claude', model: 'route-model' } } });
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const dry = JSON.parse(H.runRelay(['--route', 'mechanical', '--model', 'mine', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo }).stdout);
  assert.strictEqual(dry.effective.model, 'mine');
  assert.strictEqual(dry.route.chosen, 'claude');
});

test('route: a candidate that lacks a needed capability is skipped, never forced', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  writeConfig(repo, { workers: { cursor: { cli: H.STUB }, claude: { cli: H.STUB } }, routes: { think: [{ backend: 'cursor', effort: 'high' }, { backend: 'claude', effort: 'high' }] } });
  H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const dry = JSON.parse(H.runRelay(['--route', 'think', '--brief', b, '--workspace', repo, '--dry-run'], { cwd: repo }).stdout);
  assert.strictEqual(dry.backend, 'claude');
  assert.match(dry.route.skipped[0].reason, /effort/);
});

test('route: unknown, unroutable and fully-uninstalled routes are refused before dispatch', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  writeConfig(repo, { workers: { aider: { cli: '/nonexistent/aider' }, claude: { cli: H.STUB } }, routes: { gone: { backend: 'aider' }, mechanical: { backend: 'claude' } } });
  const b = H.writeBrief(repo);
  const unknown = H.runRelay(['--route', 'nope', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(unknown.status, 2);
  assert.match(unknown.json.reason, /configured routes: gone, mechanical/);
  const gone = H.runRelay(['--route', 'gone', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(gone.json.status, 'backend_unavailable');
  assert.ok(options.parseArgs(['--route', 'a', '--backend', 'b']).errors.some((e) => /not both/.test(e)));
});

test('route and limits config is validated field by field', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  writeConfig(repo, {
    workers: { claude: { cli: H.STUB } },
    routes: { 'Bad Name': { backend: 'claude' }, ok: [{ model: 'x' }, { backend: 'claude', colour: 'red' }] },
    limits: { runsPer24h: { gold: 1, premium: -1 }, perHour: {} },
    extra: true,
  });
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(res.json.status, 'invalid_request');
  for (const re of [/route name must be lowercase/, /routes\.ok\[0\]\.backend: required/, /routes\.ok\[1\]\.colour: unknown option/,
    /limits\.runsPer24h\.gold/, /limits\.runsPer24h\.premium: expected a non-negative integer/, /limits\.perHour: unknown option/, /unknown top-level key "extra"/]) {
    assert.match(res.json.reason, re);
  }
});

/* ------------------------------------------------------------------ *
 * Quota and budget: steer away from workers that cannot take the job
 * ------------------------------------------------------------------ */

test('quota: a worker whose output says it is out of quota is marked, and routes skip it', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  writeConfig(repo, { workers: { claude: { cli: H.STUB }, codex: { cli: H.STUB } }, routes: { mechanical: [{ backend: 'claude' }, { backend: 'codex' }] } });
  H.markVerified(repo, 'claude', ALL_CAPS); H.markVerified(repo, 'codex', ALL_CAPS);
  const b = H.writeBrief(repo);
  const first = H.runRelay(['--route', 'mechanical', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_EXIT: '1', STUB_PRINT: 'Error: usage limit reached for this plan' } });
  assert.strictEqual(first.json.status, 'process_failure', 'quota never rewrites the status');
  assert.strictEqual(first.json.worker.quotaExhausted, true);
  const quota = JSON.parse(fs.readFileSync(path.join(repo, '.delegate-fleet', 'quota.json'), 'utf8'));
  assert.ok(Date.parse(quota.backends.claude.until) > Date.now());
  const second = H.runRelay(['--route', 'mechanical', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(second.json.backend.id, 'codex');
  assert.match(second.json.route.skipped[0].reason, /out of quota until/);
});

test('quota: the same words in a successful run mark nothing', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: 'handled the rate limit exceeded branch' } });
  assert.ok(!fs.existsSync(path.join(repo, '.delegate-fleet', 'quota.json')));
});

test('limits: a tier over its 24h budget is skipped by routes and refused when named', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  writeConfig(repo, {
    workers: { claude: { cli: H.STUB, tier: 'premium' }, codex: { cli: H.STUB, tier: 'cheap' } },
    routes: { hard: [{ backend: 'claude' }, { backend: 'codex' }] },
    limits: { runsPer24h: { premium: 1 } },
  });
  H.markVerified(repo, 'claude', ALL_CAPS); H.markVerified(repo, 'codex', ALL_CAPS);
  const b = H.writeBrief(repo);
  const one = H.runRelay(['--route', 'hard', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(one.json.backend.id, 'claude');
  const two = H.runRelay(['--route', 'hard', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  assert.strictEqual(two.json.backend.id, 'codex');
  assert.match(two.json.route.skipped[0].reason, /premium tier used 1 of 1/);
  const named = H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(named.json.status, 'invalid_request');
  assert.match(named.json.reason, /premium tier has used 1 of its 1 runs/);
});

test('ledger: --until accepts relative, clock and ISO forms', () => {
  const ledger = require('../scripts/lib/ledger.js');
  const now = Date.parse('2026-01-01T10:00:00');
  assert.strictEqual(ledger.parseUntil('+90m', now), now + 90 * 60e3);
  assert.strictEqual(ledger.parseUntil('+2h', now), now + 2 * 3600e3);
  assert.strictEqual(ledger.parseUntil('12:30', now), Date.parse('2026-01-01T12:30:00'));
  assert.strictEqual(ledger.parseUntil('09:00', now), Date.parse('2026-01-02T09:00:00'), 'a passed clock time means tomorrow');
  assert.strictEqual(ledger.parseUntil('2026-02-01T00:00:00Z', now), Date.parse('2026-02-01T00:00:00Z'));
  assert.strictEqual(ledger.parseUntil('soon', now), null);
  assert.strictEqual(ledger.parseUntil('25:00', now), null);
});

/* ------------------------------------------------------------------ *
 * Batch: parallel slices in worktrees, one summary
 * ------------------------------------------------------------------ */

const BATCH = path.join(H.SKILL, 'scripts', 'batch.js');
const batchLib = require('../scripts/batch.js');
const DIR_BRIEF = H.GOOD_BRIEF.replace('- `src/a.js` — rename the component and update its export', '- `src/` — the slice may edit anything under src');

function runBatch(args, { cwd, env = {} } = {}) {
  const res = spawnSync(process.execPath, [BATCH, ...args], { cwd, encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* text mode */ }
  return { ...res, json };
}

function batchRepo() {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n', 'src/b.js': 'y\n', '.gitignore': '.delegate-fleet/\n' } });
  H.useStub(repo, 'claude', { tier: 'cheap' });
  H.markVerified(repo, 'claude', ALL_CAPS);
  const briefs = path.join(repo, '.delegate-fleet', 'briefs');
  fs.mkdirSync(briefs, { recursive: true });
  fs.writeFileSync(path.join(briefs, 'dir.md'), DIR_BRIEF);
  fs.writeFileSync(path.join(briefs, 'a-only.md'), H.GOOD_BRIEF);
  return repo;
}

function writePlan(repo, plan) {
  const p = path.join(repo, '.delegate-fleet', 'plan.json');
  fs.writeFileSync(p, JSON.stringify(plan));
  return p;
}

const worktreeCount = (repo) => spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;

test('batch plan validation: every key consumed, graph acyclic, briefs present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-plan-'));
  fs.writeFileSync(path.join(dir, 'b.md'), 'x');
  const bad = batchLib.validatePlan({
    extra: 1, concurrency: 99,
    slices: [
      { id: 'a', brief: 'b.md', backend: 'claude', dependsOn: ['c'] },
      { id: 'c', brief: 'b.md', route: 'x', backend: 'claude', dependsOn: ['a'] },
      { id: 'a', brief: 'missing.md', colour: 'red' },
      { id: 'Bad Id', brief: 'b.md', backend: 'claude', fixAttempts: 1 },
    ],
  }, dir);
  for (const re of [/unknown plan key "extra"/, /concurrency/, /exactly one of "backend" or "route"/, /duplicate "a"/, /brief: not found/, /colour: unknown key/, /lowercase/, /fixAttempts: needs checks/]) {
    assert.ok(bad.errors.some((e) => re.test(e)), `expected ${re}`);
  }
  const cyc = batchLib.validatePlan({ slices: [{ id: 'a', brief: 'b.md', backend: 'x', dependsOn: ['b'] }, { id: 'b', brief: 'b.md', backend: 'x', dependsOn: ['a'] }] }, dir);
  assert.ok(cyc.errors.some((e) => /cycle/.test(e)));
  const ok = batchLib.validatePlan({ slices: [{ id: 'c', brief: 'b.md', backend: 'x', dependsOn: ['a', 'b'] }, { id: 'a', brief: 'b.md', backend: 'x' }, { id: 'b', brief: 'b.md', backend: 'x', dependsOn: ['a'] }] }, dir);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.waves, [['a'], ['b'], ['c']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('e2e batch: parallel slices in worktrees, dependents build on their dependencies, main untouched', () => {
  const repo = batchRepo();
  const plan = writePlan(repo, { slices: [
    { id: 'one', brief: 'briefs/dir.md', backend: 'claude', checks: [`${NODE} -e "process.exit(0)"`] },
    { id: 'two', brief: 'briefs/dir.md', backend: 'claude', dependsOn: ['one'] },
    { id: 'solo', brief: 'briefs/dir.md', backend: 'claude' },
  ] });
  const res = runBatch([plan, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.01 }) } });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  const out = res.json;
  assert.strictEqual(out.totals.clean, 3);
  assert.strictEqual(out.totals.workerCostUsd, 0.03);
  assert.deepStrictEqual(out.landOrder.indexOf('one') < out.landOrder.indexOf('two'), true, 'a dependency lands first');
  assert.strictEqual(spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim(), '', 'nothing touched the main checkout');
  assert.strictEqual(worktreeCount(repo), 4);
  // Landing both patches in order reproduces the dependent's final state.
  const two = out.slices.find((x) => x.id === 'two');
  for (const id of ['one', 'two']) {
    const r = spawnSync('git', ['apply', out.slices.find((x) => x.id === id).patch], { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  assert.strictEqual(fs.readFileSync(path.join(repo, 'src/a.js'), 'utf8'), fs.readFileSync(path.join(two.worktree, 'src/a.js'), 'utf8'));
  assert.ok(!fs.readFileSync(out.slices[0].patch, 'utf8').includes('.delegate-fleet'), 'framework state is never part of a patch');
  // Every run is in the main ledger, so report sees the batch.
  const rep = H.runFleet(['report', '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(rep.json.total.runs, 3);
  const clean = runBatch(['--cleanup', out.batchId, '--workspace', repo], { cwd: repo });
  assert.strictEqual(clean.status, 0, clean.stdout);
  assert.strictEqual(worktreeCount(repo), 1, 'cleanup removes exactly the batch worktrees');
  assert.ok(fs.existsSync(out.slices[0].patch), 'patches survive cleanup');
});

test('e2e batch: a blocked dependency skips its dependents and the batch exits 1', () => {
  const repo = batchRepo();
  const plan = writePlan(repo, { slices: [
    { id: 'narrow', brief: 'briefs/a-only.md', backend: 'claude' },
    { id: 'after', brief: 'briefs/dir.md', backend: 'claude', dependsOn: ['narrow'] },
  ] });
  const res = runBatch([plan, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js,src/b.js' } });
  assert.strictEqual(res.status, 1);
  const narrow = res.json.slices.find((x) => x.id === 'narrow');
  assert.strictEqual(narrow.blocked, true);
  assert.ok(narrow.findings.some((f) => f.startsWith('scope_violation')));
  const after = res.json.slices.find((x) => x.id === 'after');
  assert.strictEqual(after.status, 'skipped');
  assert.match(after.reason, /dependency "narrow" did not finish clean/);
  assert.deepStrictEqual(res.json.landOrder, []);
  runBatch(['--cleanup', res.json.batchId, '--workspace', repo], { cwd: repo });
});

test('e2e batch: a write into the main checkout during the batch is reported', () => {
  const repo = batchRepo();
  const plan = writePlan(repo, { slices: [{ id: 'one', brief: 'briefs/dir.md', backend: 'claude' }] });
  const res = runBatch([plan, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_CREATE: path.join(repo, 'intruder.js') } });
  assert.strictEqual(res.status, 1);
  assert.ok(res.json.warnings.some((w) => /main workspace .* changed while the batch ran/.test(w)));
  runBatch(['--cleanup', res.json.batchId, '--workspace', repo], { cwd: repo });
});

test('batch warns that uncommitted work is not carried into worktrees, and dry-run spends nothing', () => {
  const repo = batchRepo();
  fs.writeFileSync(path.join(repo, 'src/a.js'), 'dirty\n');
  const plan = writePlan(repo, { slices: [{ id: 'one', brief: 'briefs/dir.md', backend: 'claude' }] });
  const res = runBatch([plan, '--workspace', repo, '--dry-run'], { cwd: repo });
  assert.strictEqual(res.status, 0);
  assert.ok(res.json.warnings.some((w) => /do NOT include them/.test(w)));
  assert.deepStrictEqual(res.json.waves, [['one']]);
  assert.strictEqual(worktreeCount(repo), 1, 'a dry run creates no worktree');
});

test('fleet quota: mark, list, and clear by hand; bad times are refused', () => {
  const repo = H.tmpRepo();
  const mark = H.runFleet(['quota', '--mark', 'codex', '--until', '+2h', '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(mark.status, 0);
  const list = H.runFleet(['quota', '--workspace', repo, '--json'], { cwd: repo });
  assert.ok(list.json.exhausted.codex);
  assert.strictEqual(H.runFleet(['quota', '--mark', 'codex', '--until', 'soon', '--workspace', repo], { cwd: repo }).status, 2);
  assert.strictEqual(H.runFleet(['quota', '--mark', 'codex', '--workspace', repo], { cwd: repo }).status, 2);
  const clear = H.runFleet(['quota', '--clear', 'codex', '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(clear.json.wasMarked, true);
  assert.deepStrictEqual(H.runFleet(['quota', '--workspace', repo, '--json'], { cwd: repo }).json.exhausted, {});
});

test('fleet report: sums self-reported usage by tier and worker, and counts the unreported', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  H.useStub(repo, 'claude', { tier: 'cheap' }); H.markVerified(repo, 'claude', ALL_CAPS);
  const b = H.writeBrief(repo);
  const print = JSON.stringify({ type: 'result', result: 'ok', usage: { input_tokens: 1000, output_tokens: 100 }, total_cost_usd: 0.25 });
  H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: print } });
  H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js', STUB_PRINT: print } });
  H.runRelay(['--backend', 'claude', '--brief', b, '--workspace', repo, '--json'], { cwd: repo, env: { STUB_MODIFY: 'src/a.js' } });
  const rep = H.runFleet(['report', '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(rep.json.total.runs, 3);
  assert.strictEqual(rep.json.total.inputTokens, 2000);
  assert.strictEqual(rep.json.total.costUsd, 0.5);
  assert.strictEqual(rep.json.total.unreported, 1, 'no usage is unknown, never zero');
  assert.strictEqual(rep.json.byTier.cheap.runs, 3);
  const text = H.runFleet(['report', '--workspace', repo], { cwd: repo });
  assert.match(text.stdout, /BY TIER[\s\S]*cheap[\s\S]*TOTAL/);
  const future = H.runFleet(['report', '--since', '2999-01-01', '--workspace', repo, '--json'], { cwd: repo });
  assert.strictEqual(future.json.total.runs, 0);
  assert.strictEqual(H.runFleet(['report', '--since', 'yesterday', '--workspace', repo], { cwd: repo }).status, 2);
});

/* ---------------------------------- runner ---------------------------------- */

(async () => {
  console.log('\n====================================================');
  console.log('   delegate-fleet contract tests');
  console.log('====================================================\n');
  let passed = 0;
  const failures = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed += 1;
    } catch (err) {
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err && err.message ? err.message.split('\n')[0] : err}`);
      failures.push({ name, err });
    }
  }
  H.cleanup();
  console.log('\n----------------------------------------------------');
  console.log(`Results: ${passed} passed, ${failures.length} failed (${tests.length} tests).`);
  console.log('----------------------------------------------------');
  if (failures.length) {
    for (const f of failures) console.log(`\n--- ${f.name}\n${f.err && f.err.stack ? f.err.stack : f.err}`);
    process.exit(1);
  }
})();
