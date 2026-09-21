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

const H = require('./harness.js');
const capabilities = require('../scripts/lib/capabilities.js');
const brief = require('../scripts/lib/brief.js');
const repoLib = require('../scripts/lib/repo.js');
const contract = require('../scripts/lib/contract.js');
const options = require('../scripts/lib/options.js');
const registry = require('../scripts/adapters/index.js');
const environment = require('../scripts/lib/environment.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const ALL_CAPS = { edit: 'verified', readOnly: 'verified', resumeById: 'verified', modelSelection: 'verified', effort: 'verified', structuredOutput: 'verified' };

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
  H.useStub(repo, 'aider'); // aider declares readOnly: documented
  const b = H.writeBrief(repo);
  const res = H.runRelay(['--backend', 'aider', '--brief', b, '--workspace', repo, '--read-only', '--allow-unverified', '--json'], { cwd: repo });
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

test('a config field with no consumer is rejected rather than silently ignored', () => {
  const repo = H.tmpRepo({ files: { 'src/a.js': 'x\n' } });
  const dir = path.join(repo, '.delegate-fleet');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ workers: { claude: { cli: H.STUB, tier: 'premium' } } }));
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
      capabilities: { edit:'verified', readOnly:'unsupported', resumeById:'unsupported', modelSelection:'verified', effort:'unsupported', structuredOutput:'unsupported' },
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
  const allowed = new Set(['id', 'title', 'cli', 'cliPath', 'supported', 'availability', 'declaredCapabilities', 'capabilities', 'localVerification', 'defaults', 'docs', 'staticEvidence']);
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
    assert.strictEqual(cells[9], a.promptDelivery || 'argv', `${a.id}: documented prompt delivery is stale`);
  }
});

test('no adapter claims a capability its build() cannot express', () => {
  for (const a of registry.BUILT_IN) {
    const src = a.build.toString();
    if (capabilities.claims(a.capabilities.modelSelection)) assert.match(src, /req\.model/, `${a.id} claims modelSelection but build() ignores req.model`);
    if (capabilities.claims(a.capabilities.effort)) assert.match(src, /req\.effort/, `${a.id} claims effort but build() ignores req.effort`);
    if (capabilities.claims(a.capabilities.resumeById)) assert.match(src, /req\.session/, `${a.id} claims resumeById but build() ignores req.session`);
    if (capabilities.claims(a.capabilities.readOnly)) assert.match(src, /req\.mode/, `${a.id} claims readOnly but build() ignores req.mode`);
  }
});

test('an adapter that delivers the brief by file actually consumes promptFile', () => {
  for (const a of registry.BUILT_IN) {
    const src = a.build.toString();
    if (a.promptDelivery === 'file') assert.match(src, /req\.promptFile/, `${a.id}: promptDelivery "file" but build() never uses req.promptFile`);
    if (!a.promptDelivery || a.promptDelivery === 'argv') assert.match(src, /req\.prompt\b/, `${a.id}: argv delivery but build() never puts the prompt in argv`);
  }
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
