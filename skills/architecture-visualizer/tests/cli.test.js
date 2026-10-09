const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'arch-viz.js');
const EXAMPLE = path.join(__dirname, '..', 'examples', '1-crud-business-feature', 'architecture.json');

function run(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

const cases = [
  ['help exits 0 and lists every command', () => {
    const { code, stdout } = run(['help']);
    assert.strictEqual(code, 0);
    ['build', 'validate', 'mermaid', 'inspect', 'init'].forEach(cmd => assert.ok(stdout.includes(`arch-viz ${cmd}`)));
  }],

  ['an unknown command exits non-zero', () => {
    assert.notStrictEqual(run(['frobnicate']).code, 0);
  }],

  ['an unknown option exits non-zero', () => {
    assert.notStrictEqual(run(['validate', EXAMPLE, '--nope']).code, 0);
  }],

  ['a missing option value exits non-zero', () => {
    assert.notStrictEqual(run(['build', EXAMPLE, '-o']).code, 0);
  }],

  ['a missing spec file exits non-zero', () => {
    assert.notStrictEqual(run(['validate', 'no-such-spec.json']).code, 0);
  }],

  ['validate prints the 14-point gate', () => {
    const { code, stdout } = run(['validate', EXAMPLE]);
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes('14-Point Quality Gate'));
    assert.ok(stdout.includes('14. Implementation traceability'));
  }],

  ['validate --strict fails a spec that only has warnings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-cli-'));
    const specPath = path.join(dir, 'warn.json');
    fs.writeFileSync(specPath, JSON.stringify({
      meta: { title: 'Warny', description: 'd', grounding: 'illustrative' },
      boundaries: [{ id: 'b', label: 'B', order: 1 }],
      nodes: [
        { id: 'n1', label: 'N1', boundary: 'b', type: 'service', description: 'x' },
        { id: 'n2', label: 'N2', boundary: 'b', type: 'service', description: 'x' }
      ],
      edges: [{ id: 'e', source: 'n1', target: 'n2' }]
    }));
    assert.strictEqual(run(['validate', specPath]).code, 0);
    assert.notStrictEqual(run(['validate', specPath, '--strict']).code, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['init scaffolds a spec that passes its own gate and refuses to overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-cli-'));
    const target = path.join(dir, 'arch.json');
    assert.strictEqual(run(['init', target]).code, 0);
    assert.ok(fs.existsSync(target));
    assert.strictEqual(run(['validate', target, '--strict']).code, 0, 'the starter spec must be gate-clean');
    assert.notStrictEqual(run(['init', target]).code, 0, 'init must not clobber an existing file');
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['build writes html and markdown', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-cli-'));
    const html = path.join(dir, 'index.html');
    const md = path.join(dir, 'architecture.md');
    assert.strictEqual(run(['build', EXAMPLE, '-o', html, '--md', md, '--no-open']).code, 0);
    assert.ok(fs.statSync(html).size > 50000);
    assert.ok(fs.statSync(md).size > 1000);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['mermaid prints the requested view', () => {
    const { code, stdout } = run(['mermaid', EXAMPLE, '--view', 'er']);
    assert.strictEqual(code, 0);
    assert.ok(stdout.startsWith('erDiagram'));
  }],

  ['inspect reports repository signatures', () => {
    const { code, stdout } = run(['inspect', path.join(__dirname, '..')]);
    assert.strictEqual(code, 0);
    assert.ok(stdout.includes('frameworks'));
  }],

  ['validate --json honours --strict in its exit code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-cli-'));
    const spec = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
    spec.nodes.push({ id: 'orphan_node', label: 'Orphan', type: 'service', boundary: spec.boundaries[0].id, status: 'INFERRED', delta: 'UNCHANGED' });
    const target = path.join(dir, 'warn.json');
    fs.writeFileSync(target, JSON.stringify(spec));

    const plain = run(['validate', target, '--json', '--repo-root', '.']);
    const strict = run(['validate', target, '--json', '--strict', '--repo-root', '.']);
    assert.strictEqual(plain.code, 0, 'warnings alone must not fail a non-strict run');
    assert.strictEqual(strict.code, 1, '--json must not bypass --strict');
    assert.ok(JSON.parse(strict.stdout).failed === true);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['init creates missing parent directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-cli-'));
    const target = path.join(dir, 'nested', 'deeper', 'spec.json');
    assert.strictEqual(run(['init', target]).code, 0);
    assert.ok(fs.existsSync(target));
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['scaffold runs through the CLI and refuses to overwrite', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-cli-'));
    const git = args => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'base']);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'App.ts'), 'export default 1;\n');

    const target = path.join(dir, 'draft.json');
    const first = run(['scaffold', '-o', target, '--repo-root', dir]);
    assert.strictEqual(first.code, 0, first.stdout);
    assert.ok(fs.existsSync(target));
    assert.notStrictEqual(run(['scaffold', '-o', target, '--repo-root', dir]).code, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['scaffold outside a git repository fails with a readable message', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-nogit-'));
    const { code, stdout } = run(['scaffold', '-o', path.join(dir, 'd.json'), '--repo-root', dir]);
    assert.notStrictEqual(code, 0);
    assert.ok(/not a git repository/i.test(stdout), stdout);
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['build --direction TB works end to end', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-cli-'));
    const html = path.join(dir, 'tb.html');
    assert.strictEqual(run(['build', EXAMPLE, '-o', html, '--direction', 'TB', '--no-open']).code, 0);
    assert.ok(fs.readFileSync(html, 'utf8').includes('"direction":"TB"'));
    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['validate --fresh exits 0 before a cited file changes and 1 with the stale line after', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-fresh-cli-'));
    const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const sha7 = sha.slice(0, 7);

    const spec = {
      meta: { title: 'Fresh CLI', description: 'd', groundedAt: sha },
      boundaries: [{ id: 'b', label: 'B' }],
      nodes: [{ id: 'n', label: 'N', boundary: 'b', status: 'VERIFIED' }],
      edges: [],
      evidence: [{ id: 'ev_readme', type: 'file', locator: { path: 'README.md' }, verification: 'verified' }],
    };
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    const freshBefore = run(['validate', specPath, '--fresh', '--repo-root', dir]);
    assert.strictEqual(freshBefore.code, 0);
    assert.ok(freshBefore.stdout.includes(`Fresh against ${sha7}.`));

    fs.appendFileSync(path.join(dir, 'README.md'), 'changed\n');

    const freshAfter = run(['validate', specPath, '--fresh', '--repo-root', dir]);
    assert.strictEqual(freshAfter.code, 1);
    assert.ok(freshAfter.stdout.includes(`stale: ev_readme README.md changed since ${sha7}`));

    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['validate --stamp updates the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-stamp-cli-'));
    const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    const sha7 = sha.slice(0, 7);

    const spec = {
      meta: { title: 'Stamp CLI', description: 'd' },
      boundaries: [{ id: 'b', label: 'B' }],
      nodes: [{ id: 'n', label: 'N', boundary: 'b', status: 'VERIFIED' }],
      edges: [],
      evidence: [{ id: 'ev_readme', type: 'file', locator: { path: 'README.md' }, verification: 'verified' }],
    };
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    const stamped = run(['validate', specPath, '--stamp', '--repo-root', dir]);
    assert.strictEqual(stamped.code, 0);
    assert.ok(stamped.stdout.includes(`Stamped groundedAt ${sha7}.`));

    const updated = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    assert.strictEqual(updated.meta.groundedAt, sha);

    fs.rmSync(dir, { recursive: true, force: true });
  }],

  ['build embeds verification:stale for the changed record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-build-stale-'));
    const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
    git(['init', '-q']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'initial']);
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();

    const spec = {
      meta: { title: 'Build Stale CLI', description: 'd', groundedAt: sha },
      boundaries: [{ id: 'b', label: 'B' }],
      nodes: [{ id: 'n', label: 'N', boundary: 'b', status: 'VERIFIED' }],
      edges: [],
      evidence: [{ id: 'ev_readme', type: 'file', locator: { path: 'README.md' }, verification: 'verified' }],
    };
    const specPath = path.join(dir, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

    fs.appendFileSync(path.join(dir, 'README.md'), 'changed\n');

    const htmlPath = path.join(dir, 'out.html');
    const buildRes = run(['build', specPath, '-o', htmlPath, '--repo-root', dir, '--no-open']);
    assert.strictEqual(buildRes.code, 0);

    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.includes('"verification":"stale"'));

    fs.rmSync(dir, { recursive: true, force: true });
  }]
];

module.exports = { name: 'CLI', cases };
