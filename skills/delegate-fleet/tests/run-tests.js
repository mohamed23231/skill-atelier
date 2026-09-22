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
  const allowed = new Set(['id', 'title', 'cli', 'cliPath', 'supported', 'availability', 'declaredCapabilities', 'capabilities', 'localVerification', 'staleVerification', 'defaults', 'docs', 'staticEvidence']);
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
    capabilities: { ...ALL_CAPS, modelSelection: 'documented', edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported' },
    build(req) { return { args: [req.prompt] }; },
    probe() { return {}; },
  };
  assert.throws(() => registry.assertShape(bad), /does not express it from model/);
});

test('an adapter with a non-string id or cli is rejected at load time', () => {
  const base = { capabilities: { edit: 'documented', readOnly: 'unsupported', resumeById: 'unsupported', modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported' }, build: (req) => ({ args: [req.prompt] }), probe: () => ({}) };
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
