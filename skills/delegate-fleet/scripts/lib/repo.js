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

// Read in fixed chunks so a huge file costs bounded memory instead of being
// skipped. A size-and-mtime shortcut would miss a same-size rewrite, which is
// precisely the edit this module exists to catch.
const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * A path whose state could not be established. Distinct from `null`, which
 * means "absent". A stable hash derived from a failed probe would read as
 * "unchanged" on both sides of a run and hide the very edit we are looking
 * for, so this poisons the whole snapshot instead.
 */
const UNREADABLE = '\u0000unreadable';

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

/** sha256 of a file's bytes, read in bounded chunks. */
function hashContents(abs) {
  const hash = crypto.createHash('sha256');
  const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  const fd = fs.openSync(abs, 'r');
  try {
    let read;
    while ((read = fs.readSync(fd, buf, 0, HASH_CHUNK_BYTES, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * A directory entry in `git status` is a submodule (or an untracked folder).
 * Hashing it as a constant would hide every edit inside it, so ask the nested
 * repository for its own HEAD and dirty state instead.
 */
function hashDirectory(abs) {
  const root = spawnSync('git', ['-C', abs, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (root.error || root.signal) return UNREADABLE;
  if (root.status !== 0) {
    return /not a git repository/i.test(root.stderr || '') ? 'dir' : UNREADABLE;
  }
  if (fs.realpathSync((root.stdout || '').trim()) !== fs.realpathSync(abs)) return 'dir';
  const head = spawnSync('git', ['-C', abs, 'rev-parse', '--verify', '--quiet', 'HEAD'], {
    encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const inner = spawnSync('git', ['-C', abs, 'status', '--porcelain', '-uall'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (head.error || head.signal || inner.error || inner.signal || inner.status !== 0) return UNREADABLE;
  // An unborn HEAD is valid when the repository status itself succeeded.
  if (head.status !== 0 && (head.stderr || '').trim()) return UNREADABLE;
  const state = `${(head.stdout || '').trim()}\n${(inner.stdout || '').trim()}`;
  return `dir:${crypto.createHash('sha256').update(state).digest('hex')}`;
}

/** A content address for whatever sits at this path. */
function hashFile(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return `symlink:${crypto.createHash('sha256').update(fs.readlinkSync(abs)).digest('hex')}`;
    if (st.isDirectory()) return hashDirectory(abs);
    if (st.isFile()) return hashContents(abs);
    return UNREADABLE;
  } catch (err) {
    return err && err.code === 'ENOENT' ? null : UNREADABLE;
  }
}

function isRelayRunArtifact(filePath) {
  const norm = filePath.split(path.sep).join('/');
  return norm === '.delegate-fleet/runs' || norm.startsWith('.delegate-fleet/runs/');
}

/**
 * Observe ignored framework state under `.delegate-fleet/` because a worker can plant
 * adapters, rewrite config.json to redirect the next dispatch's executable/model/timeout,
 * or forge verification.json to bypass capability checks.
 *
 * `.delegate-fleet/runs/` holds relay-authored artifacts written after each run,
 * so it is excluded from force-observation to prevent attributing relay output to workers
 * or polluting repository state.
 */
function localFrameworkStateEntries(repoRoot) {
  const rootDir = path.join(repoRoot, '.delegate-fleet');
  let st;
  try {
    st = fs.lstatSync(rootDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  // If .delegate-fleet itself is a symlink, do not traverse: record the symlink itself.
  if (st.isSymbolicLink()) {
    return ['.delegate-fleet'];
  }
  if (!st.isDirectory()) {
    throw new Error(`.delegate-fleet is not a directory`);
  }

  const entries = [];
  function visit(current) {
    let children;
    try {
      children = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err && err.code === 'ENOENT') return;
      throw err;
    }
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const rel = path.relative(repoRoot, absolute).split(path.sep).join('/');

      // .delegate-fleet/runs/ holds relay-authored artifacts; exclude it from observation.
      if (isRelayRunArtifact(rel)) {
        continue;
      }

      if (child.isSymbolicLink()) {
        // Do not traverse symlinked directories outside or inside repo; record the symlink itself.
        entries.push(rel);
      } else if (child.isDirectory()) {
        visit(absolute);
      } else if (child.isFile()) {
        entries.push(rel);
      } else {
        // A FIFO, socket, or device node planted here fails the snapshot CLOSED
        // (repository not observed, which already forces blocked).
        throw new Error(`unsupported file type at "${rel}": only regular files and symlinks may be recorded`);
      }
    }
  }
  visit(rootDir);
  return entries;
}

function localAdapterEntries(repoRoot) {
  return localFrameworkStateEntries(repoRoot).filter((p) => p.startsWith('.delegate-fleet/adapters/'));
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
  let statusEntries;
  try {
    // Treat .delegate-fleet/runs/** as relay-authored and never attribute it to the worker.
    statusEntries = parsePorcelainZ(res.stdout).filter((entry) => !isRelayRunArtifact(entry.path));
    const seen = new Set(statusEntries.map((entry) => entry.path));
    for (const file of localFrameworkStateEntries(repoRoot)) {
      if (!seen.has(file)) statusEntries.push({ code: '??', path: file, renamedFrom: null });
    }
  } catch (err) {
    return { ok: false, reason: `could not inspect local framework state: ${err.message}`, entries: new Map(), head: null, stash: null };
  }
  for (const e of statusEntries) {
    const hash = hashFile(path.join(repoRoot, e.path));
    if (hash === UNREADABLE) {
      return {
        ok: false,
        reason: `could not establish the state of "${e.path}"; refusing to report a snapshot that could hide an edit`,
        entries: new Map(), head: null, stash: null,
      };
    }
    entries.set(e.path, { code: e.code, renamedFrom: e.renamedFrom, hash });
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

  // Compared directly, so an unborn HEAD becoming a first commit still counts.
  const headChanged = before.head !== after.head;
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
    // "." is the repository root, which contains every path.
    const ok = declared.some((d) => d === '.' || p === d || p.startsWith(`${d}/`));
    (ok ? inScope : outOfScope).push(raw);
  }
  return { inScope, outOfScope, declared };
}

module.exports = {
  UNREADABLE,
  snapshot,
  diffSnapshots,
  changedPaths,
  reconcileScope,
  parsePorcelainZ,
  classify,
  normalize,
  hashFile,
  localFrameworkStateEntries,
  localAdapterEntries,
};
