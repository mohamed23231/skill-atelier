'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

function runGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('git is not installed or not on PATH.');
    const stderr = String(err.stderr || '');
    if (/not a git repository/i.test(stderr)) throw new Error(`Not a git repository: ${cwd}`);
    if (/unknown revision|bad revision|ambiguous argument|bad object/i.test(stderr)) {
      throw new Error(`Unknown git ref in: git ${args.join(' ')}`);
    }
    throw new Error(`git ${args.join(' ')} failed: ${stderr.trim() || err.message}`);
  }
}

function isCommit(cwd, sha) {
  if (!sha || typeof sha !== 'string' || sha.trim() === '') return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sha.trim()}^{commit}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function currentCommit(root) {
  return runGit(root, ['rev-parse', 'HEAD']).trim();
}

function normalizePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return '';
  return filePath.split(/[\\/]/).filter(Boolean).join('/');
}

function changedFilesSince(root, sha, cited = []) {
  // --relative: locators are relative to the repo root, which may be a subfolder of the git toplevel.
  const diffOut = runGit(root, ['diff', '--name-only', '--no-renames', '-z', '--relative', sha]);
  // Untracked files count as changed. Ignored files are listed only when the spec cites them: listing
  // every ignored file would walk node_modules and build output in a large repository.
  const ignoredCited = cited.length ? runGit(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ...cited]) : '';
  const untrackedOut = runGit(root, ['ls-files', '-z', '--others', '--exclude-standard']);
  const files = new Set();
  // NUL delimiters preserve Git paths literally, including whitespace, newlines and non-ASCII text.
  for (const output of [diffOut, untrackedOut, ignoredCited]) {
    output.split('\0').forEach((file) => {
      if (file) {
        files.add(file);
        files.add(normalizePath(file));
      }
    });
  }
  return files;
}

function getLocatorPath(record) {
  if (!record || !record.locator) return null;
  if (typeof record.locator === 'string') return record.locator;
  if (typeof record.locator === 'object') {
    if (record.type === 'api') {
      return record.locator.file || record.locator.document || null;
    }
    return record.locator.path || record.locator.document || record.locator.file || null;
  }
  return null;
}

function applyFreshness(spec, root) {
  if (!spec || typeof spec !== 'object') {
    return { stale: [], groundedAt: null, head: null };
  }
  if (spec.meta?.grounding === 'illustrative') {
    return { stale: [], groundedAt: spec.meta?.groundedAt || null, head: null };
  }
  const groundedAt = spec.meta?.groundedAt;
  if (!groundedAt) {
    return { stale: [], groundedAt: null, head: null };
  }

  const head = currentCommit(root);

  if (!isCommit(root, groundedAt)) {
    const errorMsg = `meta.groundedAt ${groundedAt} is not a commit in this repository.`;
    return {
      stale: [],
      groundedAt,
      head,
      error: errorMsg,
      errors: [errorMsg],
    };
  }

  // Load lazily: the validator also uses isCommit from this module. Reuse its
  // canonical lifting so legacy IDs and locator deduplication stay identical.
  if ((spec.nodes || []).some(node => node.details?.files?.length)) {
    require('../engine/validator.js').liftLegacyEvidence(spec);
  }
  const cited = [...new Set((spec.evidence || []).map(getLocatorPath).filter(Boolean)
    .map(locPath => normalizePath(path.relative(path.resolve(root), path.resolve(root, locPath))))
    .filter(rel => rel && !rel.startsWith('..')))];
  const changed = changedFilesSince(root, groundedAt, cited);
  const stale = [];

  if (Array.isArray(spec.evidence)) {
    spec.evidence.forEach((record) => {
      const locPath = getLocatorPath(record);
      if (!locPath || record.type === 'assertion' || ['asserted', 'unresolved'].includes(record.verification)) return;
      const normalized = normalizePath(path.relative(path.resolve(root), path.resolve(root, locPath)));
      if (changed.has(normalized)) {
        if (record.verification !== 'stale') {
          record.verification = 'stale';
          record.staleSince = groundedAt;
        }
        if (record.id) stale.push(record.id);
      }
    });
  }

  return { stale, groundedAt, head };
}

module.exports = {
  currentCommit,
  changedFilesSince,
  applyFreshness,
  getLocatorPath,
  isCommit,
};
