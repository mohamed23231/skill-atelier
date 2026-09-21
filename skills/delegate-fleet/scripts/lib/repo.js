'use strict';

/**
 * Repository facts. READ ONLY, always.
 *
 * This module never writes, resets, checks out, stashes or cleans anything. It
 * takes a content-addressed snapshot of the dirty working tree before and
 * after a run and reports, mechanically, what moved.
 *
 * Why content hashes and not just `git status` codes: a file that was already
 * ` M` before the run and that the worker then edits further is STILL ` M`
 * afterwards. A status-code-only baseline cannot see that edit, which is
 * exactly the case where a worker quietly mangles the user's uncommitted work.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const HASH_SIZE_LIMIT = 16 * 1024 * 1024;

function git(repoRoot, args) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function revParse(repoRoot, ref) {
  const res = git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
  const out = (res.stdout || '').trim();
  return res.status === 0 && out ? out : null;
}

/** sha256 of a worktree file, or a cheap stand-in for very large files. */
function hashFile(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return `symlink:${crypto.createHash('sha256').update(fs.readlinkSync(abs)).digest('hex')}`;
    if (st.isDirectory()) return 'dir';
    if (st.size > HASH_SIZE_LIMIT) return `large:${st.size}:${st.mtimeMs}`;
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  } catch {
    return null; // absent (deleted) or unreadable
  }
}

/**
 * Parse `git status --porcelain=v1 -z -uall`.
 * In -z form every record is `XY <path>\0`, and a rename/copy record is
 * `XY <new>\0<old>\0` — the extra field is why this cannot be split on \0
 * naively.
 */
function parsePorcelainZ(buf) {
  const fields = buf.split('\0');
  const entries = [];
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    const code = rec.slice(0, 2);
    const file = rec.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      const from = fields[++i] ?? null;
      entries.push({ code, path: file, renamedFrom: from });
    } else {
      entries.push({ code, path: file, renamedFrom: null });
    }
  }
  return entries;
}

/**
 * A snapshot of everything git can see as dirty, plus the refs a worker would
 * move if it committed or stashed.
 */
function snapshot(repoRoot) {
  const inside = git(repoRoot, ['rev-parse', '--is-inside-work-tree']);
  if (inside.status !== 0 || (inside.stdout || '').trim() !== 'true') {
    return { ok: false, reason: 'not a git work tree', entries: new Map(), head: null, stash: null };
  }
  const res = git(repoRoot, ['status', '--porcelain=v1', '-z', '-uall']);
  if (res.status !== 0) {
    return { ok: false, reason: (res.stderr || 'git status failed').trim(), entries: new Map(), head: null, stash: null };
  }
  const entries = new Map();
  for (const e of parsePorcelainZ(res.stdout)) {
    entries.set(e.path, {
      code: e.code,
      renamedFrom: e.renamedFrom,
      hash: hashFile(path.join(repoRoot, e.path)),
    });
  }
  return {
    ok: true,
    reason: null,
    entries,
    head: revParse(repoRoot, 'HEAD'),
    stash: revParse(repoRoot, 'refs/stash'),
  };
}

function classify(code) {
  if (code === '??' || code[0] === 'A') return 'created';
  if (code[0] === 'R' || code[0] === 'C') return 'renamed';
  if (code.trim() === 'D' || code[0] === 'D' || code[1] === 'D') return 'deleted';
  return 'modified';
}

/**
 * Compare two snapshots and attribute every difference.
 *
 * `preExisting` is the user's work as it stood before dispatch. Anything in it
 * that the worker then altered is called out separately, because a worker
 * editing someone else's uncommitted work is a finding even when the file was
 * inside the declared scope.
 */
function diffSnapshots(before, after) {
  const created = [];
  const modified = [];
  const deleted = [];
  const renamed = [];
  const preExistingModified = [];
  const vanished = [];

  const preExisting = [...before.entries.keys()].sort();

  for (const [file, now] of after.entries) {
    const was = before.entries.get(file);
    const untouched = was && was.code === now.code && was.hash === now.hash;
    if (untouched) continue;

    const kind = classify(now.code);
    if (was) preExistingModified.push(file);
    if (kind === 'created') created.push(file);
    else if (kind === 'deleted') deleted.push(file);
    else if (kind === 'renamed') renamed.push({ from: now.renamedFrom, to: file });
    else modified.push(file);
  }

  for (const file of before.entries.keys()) {
    // Dirty before and not dirty now: committed, reverted, or stashed away.
    if (!after.entries.has(file)) vanished.push(file);
  }

  const headChanged = Boolean(before.head && after.head && before.head !== after.head);
  const stashChanged = before.stash !== after.stash;

  return {
    created: created.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    renamed,
    preExisting,
    preExistingModified: preExistingModified.sort(),
    vanished: vanished.sort(),
    headChanged,
    stashChanged,
    headBefore: before.head,
    headAfter: after.head,
  };
}

/** Every path the worker touched, renames counted at both ends. */
function changedPaths(diff) {
  const all = new Set([...diff.created, ...diff.modified, ...diff.deleted]);
  for (const r of diff.renamed) {
    if (r.from) all.add(r.from);
    if (r.to) all.add(r.to);
  }
  return [...all].sort();
}

function normalize(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Reconcile changed paths against the brief's declared scope.
 * A path is in scope when it equals a declared entry or sits underneath a
 * declared directory. Nothing else counts — an undeclared sibling is a
 * violation, not a near miss.
 */
function reconcileScope(paths, scope) {
  const declared = (scope || []).map(normalize).filter(Boolean);
  const inScope = [];
  const outOfScope = [];
  for (const raw of paths) {
    const p = normalize(raw);
    const ok = declared.some((d) => p === d || p.startsWith(`${d}/`));
    (ok ? inScope : outOfScope).push(raw);
  }
  return { inScope, outOfScope, declared };
}

module.exports = {
  snapshot,
  diffSnapshots,
  changedPaths,
  reconcileScope,
  parsePorcelainZ,
  classify,
  normalize,
  hashFile,
};
