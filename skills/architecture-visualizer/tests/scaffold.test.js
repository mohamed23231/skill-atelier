const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { scaffoldFromDiff } = require('../src/utils/diff-scaffold.js');
const { validateArchitecture } = require('../src/index.js');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'ignore'] });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-viz-scaffold-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

function writeFile(dir, relative, contents) {
  const target = path.join(dir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

const cases = [
  [
    'throws a helpful error when the working tree is clean',
    () => {
      const dir = makeRepo();
      assert.throws(() => scaffoldFromDiff({ repoRoot: dir }), /No uncommitted changes/);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'groups changed files into feature boundaries',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'features/billing/components/Card/Card.tsx', "import styles from './styles';\n");
      writeFile(dir, 'features/billing/components/Card/styles.ts', 'export default {};\n');
      writeFile(dir, 'src/utils/Helper.ts', 'export const helper = 1;\n');

      const { spec, stats } = scaffoldFromDiff({ repoRoot: dir });
      assert.strictEqual(stats.fileCount, 3);
      const boundaryIds = spec.boundaries.map((b) => b.id).sort();
      assert.deepStrictEqual(boundaryIds, ['feature_billing', 'src_utils']);
      assert.ok(spec.nodes.every((n) => n.details.files.length === 1));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'derives edges from relative import statements',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'features/billing/components/Card/Card.tsx', "import styles from './styles';\n");
      writeFile(dir, 'features/billing/components/Card/styles.ts', 'export default {};\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.strictEqual(spec.edges.length, 1);
      assert.match(spec.edges[0].source, /card/);
      assert.match(spec.edges[0].target, /styles/);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'matches alias imports by their trailing path segments',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'apps/storefront/components/ShipmentCard/ShipmentCard.tsx', "import Card from '@billing/components/Card/Card';\n");
      writeFile(dir, 'features/billing/components/Card/Card.tsx', 'export default null;\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.strictEqual(spec.edges.length, 1);
      assert.match(spec.edges[0].target, /card/);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'marks deleted files INFERRED and REMOVED so grounding stays honest',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'features/billing/Old.ts', 'export default 1;\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'add old']);
      fs.rmSync(path.join(dir, 'features/billing/Old.ts'));

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      const node = spec.nodes.find((n) => n.id.includes('old'));
      assert.strictEqual(node.delta, 'REMOVED');
      assert.strictEqual(node.status, 'INFERRED');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'ignores node_modules by default and honours extra prefixes',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'node_modules/pkg/index.js', 'module.exports = 1;\n');
      writeFile(dir, 'docs/notes.md', 'notes\n');
      writeFile(dir, 'src/app/App.ts', 'export default 1;\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir, ignore: ['docs/'] });
      const files = spec.nodes.map((n) => n.details.files[0]);
      assert.deepStrictEqual(files, ['src/app/App.ts']);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'keeps a readable id for dotfiles',
    () => {
      const dir = makeRepo();
      writeFile(dir, '.gitignore', 'dist\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.strictEqual(spec.nodes[0].id, 'gitignore');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'scaffolds against a committed ref with --base semantics',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'src/app/App.ts', 'export default 1;\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'feature']);

      const { spec, stats } = scaffoldFromDiff({ repoRoot: dir, base: 'HEAD~1' });
      assert.strictEqual(stats.fileCount, 1);
      assert.strictEqual(spec.nodes[0].delta, 'ADDED');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'produces a spec that passes validation without errors',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'features/billing/components/Card/Card.tsx', "import styles from './styles';\n");
      writeFile(dir, 'features/billing/components/Card/styles.ts', 'export default {};\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      const result = validateArchitecture(spec, { repoRoot: dir });
      assert.deepStrictEqual(result.errors, []);
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.gate.length, 14);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'labels stay inside the quality-gate character budget',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'features/billing/components/AnExtremelyLongComponentName/AnExtremelyLongComponentName.tsx', 'export default null;\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.ok(spec.nodes[0].label.length <= 22, spec.nodes[0].label);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'scopes to a subdirectory without mis-badging paths (monorepo --repo-root)',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'packages/app/src/Card.tsx', "import s from './styles';\n");
      writeFile(dir, 'packages/app/src/styles.ts', 'export default {};\n');
      writeFile(dir, 'packages/other/Ignored.ts', 'export default 1;\n');

      const scopedRoot = path.join(dir, 'packages/app');
      const { spec } = scaffoldFromDiff({ repoRoot: scopedRoot });
      const files = spec.nodes.map((n) => n.details.files[0]).sort();
      assert.deepStrictEqual(files, ['src/Card.tsx', 'src/styles.ts']);
      assert.ok(
        spec.nodes.every((n) => n.status === 'VERIFIED'),
        'paths must resolve against the requested root'
      );
      assert.strictEqual(spec.edges.length, 1);
      const result = validateArchitecture(spec, { repoRoot: scopedRoot });
      assert.ok(result.model.evidence.every((e) => e.verification === 'verified'), 'validate with the same --repo-root must resolve every scaffolded path');
      assert.strictEqual(result.gate.find((g) => g.id === 13).status, 'PASS');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'does not invent edges from imports inside comments or strings',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'src/app/Notes.ts', ["// ported from './Ghost'", 'const note = "copied from \'Card/Card\'";', 'export default note;'].join('\n'));
      writeFile(dir, 'src/app/Ghost.ts', 'export default 1;\n');
      writeFile(dir, 'src/app/Card.ts', 'export default 1;\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.deepStrictEqual(spec.edges, [], 'comments and string literals are not imports');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'refuses to guess when two changed files share a trailing path',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'features/billing/components/Card/Card.tsx', 'export default null;\n');
      writeFile(dir, 'apps/storefront/components/Card/Card.tsx', 'export default null;\n');
      writeFile(dir, 'src/app/Consumer.ts', "import Card from '@storefront/components/Card/Card';\n");

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.deepStrictEqual(spec.edges, [], 'an ambiguous tail must not resolve to an arbitrary file');
      assert.ok(spec.meta.assumptions.some((a) => /ambiguous/i.test(a)));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'keeps unique ids without compounding suffixes',
    () => {
      const dir = makeRepo();
      ['a', 'b', 'c'].forEach((tree) => writeFile(dir, `src/${tree}/Card/Card.tsx`, 'export default null;\n'));

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.deepStrictEqual(spec.nodes.map((n) => n.id).sort(), ['card_card', 'card_card_2', 'card_card_3']);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'attaches repository file evidence without guessing symbols or lines',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'src/app/App.ts', 'export default 1;\n');

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      assert.ok(Array.isArray(spec.evidence));
      assert.strictEqual(spec.evidence.length, 1);
      assert.strictEqual(spec.evidence[0].type, 'file');
      assert.strictEqual(spec.evidence[0].locator.path, 'src/app/App.ts');
      assert.strictEqual(spec.evidence[0].verification, 'verified');
      assert.ok(!Object.prototype.hasOwnProperty.call(spec.evidence[0].locator, 'symbol'));
      assert.ok(!Object.prototype.hasOwnProperty.call(spec.evidence[0].locator, 'startLine'));
      assert.deepStrictEqual(spec.nodes[0].evidenceIds, [spec.evidence[0].id]);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],

  [
    'does not mark deleted files as verified evidence',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'features/billing/Old.ts', 'export default 1;\n');
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-qm', 'add old']);
      fs.rmSync(path.join(dir, 'features/billing/Old.ts'));

      const { spec } = scaffoldFromDiff({ repoRoot: dir });
      const verifiedPaths = (spec.evidence || []).filter((entry) => entry.verification === 'verified').map((entry) => entry.locator && entry.locator.path);
      assert.ok(!verifiedPaths.includes('features/billing/Old.ts'));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],
  [
    'does not mark a changed symlink that leads out of the scaffold root as VERIFIED',
    () => {
      const dir = makeRepo();
      writeFile(dir, 'packages/app/src/Card.ts', 'export default 1;\n');
      writeFile(dir, 'packages/shared/util.ts', 'export default 2;\n');
      fs.symlinkSync(path.join(dir, 'packages/shared/util.ts'), path.join(dir, 'packages/app/src/util.ts'));
      const scopedRoot = path.join(dir, 'packages/app');
      const { spec } = scaffoldFromDiff({ repoRoot: scopedRoot });
      const link = spec.nodes.find((n) => n.details.files[0] === 'src/util.ts');
      assert.strictEqual(link.status, 'INFERRED');
      assert.ok(!link.evidenceIds);
      const result = validateArchitecture(spec, { repoRoot: scopedRoot });
      assert.ok(result.findings.some((f) => f.policyId === 'evidence.outside_repo' && f.nodeIds.includes(link.id)), 'the outbound file is still reported, not verified');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  ],
];

module.exports = { name: 'Diff Scaffold', cases };
