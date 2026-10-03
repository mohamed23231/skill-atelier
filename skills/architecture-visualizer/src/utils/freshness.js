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

function changedFilesSince(root, sha) {
  // --relative: locators are relative to the repo root, which may be a subfolder of the git toplevel.
  const diffOut = runGit(root, ['diff', '--name-only', '--relative', sha]);
  const untrackedOut = runGit(root, ['ls-files', '--others', '--exclude-standard']);
  const files = new Set();
  diffOut.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (trimmed) {
      files.add(trimmed);
      files.add(normalizePath(trimmed));
    }
  });
  untrackedOut.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (trimmed) {
      files.add(trimmed);
      files.add(normalizePath(trimmed));
    }
  });
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

  const changed = changedFilesSince(root, groundedAt);
  const stale = [];

  if (Array.isArray(spec.evidence)) {
    spec.evidence.forEach((record) => {
      const locPath = getLocatorPath(record);
      if (!locPath) return;
      const normalized = normalizePath(locPath);
      if (changed.has(locPath) || changed.has(normalized)) {
        if (record.verification === 'verified' || record.verification === 'compatibility') {
          record.verification = 'stale';
          record.staleSince = groundedAt;
          if (record.id) stale.push(record.id);
        }
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
