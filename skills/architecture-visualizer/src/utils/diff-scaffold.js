'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LABEL_CHARS = 22;
const TECH_CHARS = 28;

const CHANGE_TO_DELTA = {
  A: 'ADDED',
  '?': 'ADDED',
  M: 'CHANGED',
  D: 'REMOVED',
  R: 'MOVED',
  C: 'ADDED',
  T: 'CHANGED',
  U: 'CHANGED',
};

const DEFAULT_IGNORE = ['node_modules/', '.git/', 'dist/', 'build/', 'yarn.lock', 'package-lock.json', 'pnpm-lock.yaml'];

const ASSET_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ttf', '.otf', '.lottie']);
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function runGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('git is not installed or not on PATH.');
    const stderr = String(err.stderr || '');
    if (/not a git repository/i.test(stderr)) throw new Error(`Not a git repository: ${cwd}`);
    if (/unknown revision|bad revision|ambiguous argument/i.test(stderr)) {
      throw new Error(`Unknown git ref in: git ${args.join(' ')}`);
    }
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || err.message}`);
  }
}

function realPath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

function resolveGitRoot(cwd) {
  return runGit(cwd, ['rev-parse', '--show-toplevel']).trim();
}

function collectChanges(repoRoot, base) {
  const changes = new Map();
  const put = (code, file) => {
    if (!file) return;
    const existing = changes.get(file);
    if (!existing || existing === 'M') changes.set(file, code);
  };

  if (base) {
    const fields = runGit(repoRoot, ['diff', '--name-status', '--find-renames', '-z', base]).split('\0');
    for (let i = 0; i < fields.length; i++) {
      const code = fields[i];
      if (!code) continue;
      if (code[0] === 'R' || code[0] === 'C') {
        put(code[0], fields[i + 2]);
        i += 2;
      } else {
        put(code[0], fields[i + 1]);
        i += 1;
      }
    }
    return changes;
  }

  runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\0')
    .filter(Boolean)
    .forEach((entry) => {
      const code = entry.slice(0, 2).trim()[0] || 'M';
      put(code === '?' ? '?' : code, entry.slice(3));
    });
  return changes;
}

function slug(value) {
  return (
    value
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'node'
  );
}

function truncate(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function boundaryFor(filePath) {
  const segments = filePath.split('/');
  if (segments[0] === 'features' && segments[1]) return { id: `feature_${slug(segments[1])}`, label: `features/${segments[1]}`, type: 'container' };
  if (segments[0] === 'marketplaces' && segments[1]) return { id: `mp_${slug(segments[1])}`, label: `marketplaces/${segments[1]}`, type: 'container' };
  if (segments[0] === 'src' && segments[1]) return { id: `src_${slug(segments[1])}`, label: `src/${segments[1]}`, type: 'container' };
  if (segments.length === 1) return { id: 'repo_root', label: 'Repository root', type: 'system' };
  return { id: slug(segments[0]), label: segments[0], type: 'container' };
}

function nodeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const lower = filePath.toLowerCase();
  if (ASSET_EXTENSIONS.has(ext)) return 'storage';
  if (lower.includes('/locale/') || lower.includes('/translations/') || ext === '.json') return 'storage';
  if (lower.includes('/migrations/') || lower.includes('/schema/')) return 'database';
  if (lower.includes('/sagas/') || lower.includes('/reducers/') || lower.includes('/actions/')) return 'worker';
  if (lower.includes('/services/') || lower.includes('/api/')) return 'service';
  if (ext === '.tsx' || ext === '.jsx') return 'frontend';
  return 'service';
}

function technologyFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx' || ext === '.jsx') return 'React component';
  if (ext === '.ts' || ext === '.js') return 'TypeScript module';
  if (ext === '.json') return 'JSON data';
  if (ASSET_EXTENSIONS.has(ext)) return 'Static asset';
  return ext.replace('.', '') || 'file';
}

function labelFor(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  const parent = path.basename(path.dirname(filePath));
  const generic = new Set(['styles', 'index', 'types', 'constants']);
  const readable = generic.has(base) && parent ? `${parent} ${base}` : base;
  return truncate(readable.replace(/[_-]+/g, ' '), LABEL_CHARS);
}

/**
 * Strip comments and ordinary string literals so that a path mentioned in
 * prose ("ported from './Ghost'") cannot be mistaken for a dependency.
 */
function stripNonCode(source) {
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? n : end;
      continue;
    }

    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      out += ' ';
      i = end === -1 ? n : end + 2;
      continue;
    }

    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j++;
      }
      out += source.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function importSpecifiers(source) {
  const code = stripNonCode(source);
  const specs = [];
  const patterns = [
    /(?:^|[\n;{}])\s*(?:import|export)\b[^'"\n]*?from\s+['"]([^'"]+)['"]/gm,
    /(?:^|[\n;{}])\s*import\s+['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  patterns.forEach((pattern) => {
    let match;
    while ((match = pattern.exec(code)) !== null) specs.push(match[1]);
  });
  return specs;
}

function stripExtension(filePath) {
  const base = path.basename(filePath);
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) return filePath;
  return filePath.replace(/\.[^./]+$/, '');
}

function tailKey(filePath) {
  const withoutExt = stripExtension(filePath);
  const segments = withoutExt.split('/');
  return segments.slice(-2).join('/').toLowerCase();
}

function buildEdges(nodes, repoRoot) {
  const byTail = new Map();
  nodes.forEach((node) => {
    const key = tailKey(node.details.files[0]);
    if (!byTail.has(key)) byTail.set(key, []);
    byTail.get(key).push(node.id);
  });

  const edges = [];
  const seen = new Set();
  const ambiguous = new Set();

  nodes.forEach((node) => {
    const file = node.details.files[0];
    if (!CODE_EXTENSIONS.has(path.extname(file).toLowerCase())) return;
    const absolute = path.join(repoRoot, file);
    if (!fs.existsSync(absolute)) return;

    let source;
    try {
      source = fs.readFileSync(absolute, 'utf8');
    } catch {
      return;
    }

    importSpecifiers(source).forEach((spec) => {
      const resolved = spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)) : spec;
      const key = tailKey(resolved);
      const candidates = byTail.get(key);
      if (!candidates) return;
      if (candidates.length > 1) {
        ambiguous.add(key);
        return;
      }
      const targetId = candidates[0];
      if (targetId === node.id) return;
      const edgeKey = `${node.id}->${targetId}`;
      if (seen.has(edgeKey)) return;
      seen.add(edgeKey);
      edges.push({
        id: `e${edges.length + 1}`,
        source: node.id,
        target: targetId,
        label: 'imports',
        communication: 'sync',
        pathType: 'request',
        animated: false,
      });
    });
  });

  return { edges, ambiguous: [...ambiguous].sort() };
}

function scaffoldFromDiff(options = {}) {
  const requestedRoot = realPath(path.resolve(options.repoRoot || process.cwd()));
  const gitRoot = realPath(resolveGitRoot(requestedRoot));
  const scope = path.relative(gitRoot, requestedRoot).split(path.sep).filter(Boolean).join('/');
  const changes = collectChanges(gitRoot, options.base);
  const repoRoot = gitRoot;
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore || [])];

  const files = [...changes.keys()]
    .filter((file) => !scope || file === scope || file.startsWith(`${scope}/`))
    .filter((file) => !ignore.some((prefix) => file.startsWith(prefix)))
    .sort();

  if (files.length === 0) {
    throw new Error(options.base ? `No changed files between ${options.base} and the working tree.` : 'No uncommitted changes found. Pass --base <ref> to scaffold a committed range.');
  }

  const boundaries = new Map();
  const usedIds = new Set();
  const nodes = [];
  const evidence = [];

  files.forEach((file) => {
    const boundary = boundaryFor(file);
    if (!boundaries.has(boundary.id)) {
      boundaries.set(boundary.id, { ...boundary, order: boundaries.size + 1 });
    }

    const baseId = slug(stripExtension(file).split('/').slice(-2).join('_'));
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
    usedIds.add(id);

    const code = changes.get(file);
    const exists = fs.existsSync(path.join(repoRoot, file));

    const node = {
      id,
      label: labelFor(file),
      type: nodeTypeFor(file),
      boundary: boundary.id,
      technology: truncate(technologyFor(file), TECH_CHARS),
      status: exists ? 'VERIFIED' : 'INFERRED',
      delta: CHANGE_TO_DELTA[code] || 'CHANGED',
      description: `${file} (git status ${code})`,
      details: {
        responsibilities: [`Review the ${CHANGE_TO_DELTA[code] || 'CHANGED'} portion of this file`],
        files: [file],
      },
    };

    if (exists) {
      const evidenceId = `ev_file_${id}`;
      node.evidenceIds = [evidenceId];
      evidence.push({
        id: evidenceId,
        type: 'file',
        locator: { path: file },
        verification: 'verified',
        origin: 'scaffold',
      });
    }

    nodes.push(node);
  });

  const { edges, ambiguous } = buildEdges(nodes, repoRoot);

  const assumptions = ['Edges are derived from static import statements only; runtime relationships are not inferred.'];
  if (ambiguous.length > 0) {
    assumptions.push(`No edge was drawn for ${ambiguous.length} ambiguous import path(s) that match more than one changed file: ${ambiguous.join(', ')}.`);
  }

  const spec = {
    schemaVersion: 2,
    meta: {
      title: options.title || 'Working tree change architecture',
      description: options.base
        ? `Scaffolded from git diff ${options.base}..working tree. Prune and re-label before sharing.`
        : 'Scaffolded from uncommitted changes. Prune and re-label before sharing.',
      status: 'CURRENT',
      author: 'arch-viz scaffold',
      date: new Date().toISOString().split('T')[0],
      assumptions,
      decisions: [],
    },
    boundaries: [...boundaries.values()],
    nodes,
    edges,
    evidence,
  };

  const connected = new Set();
  edges.forEach((edge) => {
    connected.add(edge.source);
    connected.add(edge.target);
  });

  return {
    spec,
    stats: {
      fileCount: files.length,
      boundaryCount: boundaries.size,
      edgeCount: edges.length,
      isolatedCount: nodes.filter((node) => !connected.has(node.id)).length,
    },
  };
}

module.exports = { scaffoldFromDiff };
