'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { currentCommit, changedFilesSince, applyFreshness, isCommit } = require('../src/utils/freshness.js');
const { validateArchitecture } = require('../src/engine/validator.js');

let gitAvailable = true;
try {
  execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
} catch {
  gitAvailable = false;
}

if (!gitAvailable) {
  console.log('git is not installed; skipping freshness test suite.');
  module.exports = {
    name: 'Freshness',
    cases: [
      ['git skipped', () => {}],
    ],
  };
  return;
}

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-fresh-test-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello world\n', 'utf8');
  git(['add', 'file.txt']);
  git(['commit', '-qm', 'initial commit']);
  const headSha = git(['rev-parse', 'HEAD']).trim();
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return { dir, git, headSha, cleanup };
}

const cases = [
  ['stamping writes the sha', () => {
    const { dir, headSha, cleanup } = makeTempRepo();
    try {
      const sha = currentCommit(dir);
      assert.strictEqual(sha, headSha);
      assert.match(sha, /^[0-9a-f]{40}$/);

      const spec = {
        meta: { title: 'Test Spec', description: 'Testing stamping', status: 'CURRENT' },
        boundaries: [{ id: 'b1', label: 'Boundary' }],
        nodes: [{ id: 'n1', label: 'Node', boundary: 'b1', status: 'VERIFIED' }],
        edges: [],
        evidence: [{ id: 'ev1', type: 'file', locator: { path: 'file.txt' }, verification: 'verified' }],
      };

      spec.meta.groundedAt = sha;
      assert.strictEqual(spec.meta.groundedAt, headSha);
      assert.strictEqual(isCommit(dir, spec.meta.groundedAt), true);
    } finally {
      cleanup();
    }
  }],

  ['an unchanged file stays fresh', () => {
    const { dir, headSha, cleanup } = makeTempRepo();
    try {
      const spec = {
        meta: { title: 'Test Spec', description: 'Testing freshness', status: 'CURRENT', groundedAt: headSha },
        boundaries: [{ id: 'b1', label: 'Boundary' }],
        nodes: [{ id: 'n1', label: 'Node', boundary: 'b1', status: 'VERIFIED' }],
        edges: [],
        evidence: [{ id: 'ev1', type: 'file', locator: { path: 'file.txt' }, verification: 'verified' }],
      };

      const res = applyFreshness(spec, dir);
      assert.deepStrictEqual(res.stale, []);
      assert.strictEqual(res.groundedAt, headSha);
      assert.strictEqual(res.head, headSha);
      assert.strictEqual(spec.evidence[0].verification, 'verified');
      assert.strictEqual(spec.evidence[0].staleSince, undefined);
    } finally {
      cleanup();
    }
  }],

  ['a repo root inside a larger git repository matches locators relative to that root', () => {
    const { dir, cleanup } = makeTempRepo();
    try {
      const sub = path.join(dir, 'services', 'orders');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, 'api.js'), 'module.exports = 1;\n', 'utf8');
      execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'sub'], { cwd: dir, stdio: 'ignore' });
      const sha = currentCommit(dir);
      fs.appendFileSync(path.join(sub, 'api.js'), 'module.exports = 2;\n', 'utf8');
      const spec = {
        meta: { grounding: 'repository', groundedAt: sha },
        evidence: [{ id: 'ev_api', type: 'file', locator: { path: 'api.js' }, verification: 'verified' }],
      };
      const res = applyFreshness(spec, sub);
      assert.deepStrictEqual(res.stale, ['ev_api'], 'a locator relative to a subfolder root must go stale when its file changes');
    } finally {
      cleanup();
    }
  }],

  ['a modified file and an untracked file become stale with staleSince', () => {
    const { dir, headSha, cleanup } = makeTempRepo();
    try {
      // Modify committed file
      fs.appendFileSync(path.join(dir, 'file.txt'), 'appended line\n', 'utf8');
      // Create untracked file
      fs.writeFileSync(path.join(dir, 'untracked.txt'), 'untracked content\n', 'utf8');

      const spec = {
        meta: { title: 'Test Spec', description: 'Testing stale files', status: 'CURRENT', groundedAt: headSha },
        boundaries: [{ id: 'b1', label: 'Boundary' }],
        nodes: [{ id: 'n1', label: 'Node', boundary: 'b1', status: 'VERIFIED' }],
        edges: [],
        evidence: [
          { id: 'ev1', type: 'file', locator: { path: 'file.txt' }, verification: 'verified' },
          { id: 'ev2', type: 'file', locator: { path: 'untracked.txt' }, verification: 'verified' },
        ],
      };

      const res = applyFreshness(spec, dir);
      assert.strictEqual(res.stale.length, 2);
      assert.ok(res.stale.includes('ev1'));
      assert.ok(res.stale.includes('ev2'));
      assert.strictEqual(spec.evidence[0].verification, 'stale');
      assert.strictEqual(spec.evidence[0].staleSince, headSha);
      assert.strictEqual(spec.evidence[1].verification, 'stale');
      assert.strictEqual(spec.evidence[1].staleSince, headSha);
    } finally {
      cleanup();
    }
  }],

  ['a file not cited does not matter', () => {
    const { dir, headSha, cleanup } = makeTempRepo();
    try {
      // Create and modify another file not cited in evidence
      fs.writeFileSync(path.join(dir, 'other.txt'), 'uncited file\n', 'utf8');

      const spec = {
        meta: { title: 'Test Spec', description: 'Testing uncited file', status: 'CURRENT', groundedAt: headSha },
        boundaries: [{ id: 'b1', label: 'Boundary' }],
        nodes: [{ id: 'n1', label: 'Node', boundary: 'b1', status: 'VERIFIED' }],
        edges: [],
        evidence: [{ id: 'ev1', type: 'file', locator: { path: 'file.txt' }, verification: 'verified' }],
      };

      const res = applyFreshness(spec, dir);
      assert.deepStrictEqual(res.stale, []);
      assert.strictEqual(spec.evidence[0].verification, 'verified');
    } finally {
      cleanup();
    }
  }],

  ['an unknown groundedAt gives the validation error', () => {
    const { dir, cleanup } = makeTempRepo();
    try {
      const unknownSha = '0123456789abcdef0123456789abcdef01234567';
      const spec = {
        meta: { title: 'Test Spec', description: 'Testing unknown sha', status: 'CURRENT', groundedAt: unknownSha },
        boundaries: [{ id: 'b1', label: 'Boundary' }],
        nodes: [{ id: 'n1', label: 'Node', boundary: 'b1', status: 'VERIFIED' }],
        edges: [],
        evidence: [{ id: 'ev1', type: 'file', locator: { path: 'file.txt' }, verification: 'verified' }],
      };

      const expectedError = `meta.groundedAt ${unknownSha} is not a commit in this repository.`;

      const freshRes = applyFreshness(spec, dir);
      assert.strictEqual(freshRes.error, expectedError);

      const valRes = validateArchitecture(spec, { repoRoot: dir });
      assert.strictEqual(valRes.valid, false);
      assert.ok(valRes.errors.includes(expectedError));
    } finally {
      cleanup();
    }
  }],

  ['illustrative specs are untouched', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-nogit-'));
    try {
      const spec = {
        meta: { title: 'Illustrative Spec', description: 'Testing illustrative', grounding: 'illustrative', groundedAt: 'deadbeef' },
        boundaries: [{ id: 'b1', label: 'Boundary' }],
        nodes: [{ id: 'n1', label: 'Node', boundary: 'b1', status: 'VERIFIED' }],
        edges: [],
        evidence: [{ id: 'ev1', type: 'file', locator: { path: 'nonexistent.txt' }, verification: 'verified' }],
      };

      const res = applyFreshness(spec, nonGitDir);
      assert.deepStrictEqual(res.stale, []);
      assert.strictEqual(spec.evidence[0].verification, 'verified');
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  }],

  ['a directory that is not a git repository gives a clear error', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-nogit-'));
    try {
      assert.throws(() => {
        currentCommit(nonGitDir);
      }, /not a git repository/i);

      const spec = {
        meta: { title: 'Test Spec', description: 'Testing non-git error', groundedAt: '1234567' },
        boundaries: [{ id: 'b1', label: 'Boundary' }],
        nodes: [{ id: 'n1', label: 'Node', boundary: 'b1', status: 'VERIFIED' }],
        edges: [],
        evidence: [{ id: 'ev1', type: 'file', locator: { path: 'file.txt' }, verification: 'verified' }],
      };

      assert.throws(() => {
        applyFreshness(spec, nonGitDir);
      }, /not a git repository/i);
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  }],
];

module.exports = { name: 'Freshness', cases };
