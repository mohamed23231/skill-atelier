'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
/**
 * OpenCode (`opencode run`).
 * Note: OpenCode has no --read-only flag. Read-only is the built-in `plan`
 * agent, and a write run needs --auto or it stalls waiting for approval.
 * Note: OpenCode does NOT take the spawned process cwd as its project root. It
 * resolves relative paths against its own last-used project unless --dir says
 * otherwise, so a run without --dir can read and write a different repository.
 */
module.exports = {
  id: 'opencode',
  cli: 'opencode',
  title: 'OpenCode',
  docs: 'https://opencode.ai',
  evidence: { method: '--help + `opencode agent list`', platform: 'darwin', date: '2026-09-21' },
  capabilities: {
    edit: 'verified',
    readOnly: 'verified',
    resumeById: 'verified',
    modelSelection: 'verified',
    effort: 'verified',
    structuredOutput: 'verified',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified in opencode run --help
    budgetLimit: 'unsupported',
  },
  // OpenCode's run flags are on the `run` subcommand's help, not top-level.
  helpArgs: ['run', '--help'],
  // `--agent` only proves a selector exists. The `plan` agent that build()
  // names has to be verified against the agent list itself.
  evidenceArgs: [['agent', 'list']],
  build(req) {
    const args = ['run', req.prompt, '--format', 'json'];
    // Without --dir, OpenCode ignores the process cwd and works in whatever
    // project it used last -- outside the workspace the relay is observing.
    if (req.cwd) args.push('--dir', req.cwd);
    if (req.mode === 'read-only') {
      args.push('--agent', 'plan');
    } else {
      // Without --auto, a headless write run blocks on a permission prompt.
      args.push('--agent', 'build', '--auto');
    }
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--variant', req.effort);
    if (req.session) args.push('--session', req.session);
    return { args };
  },
  // OpenCode keeps sessions in one SQLite database under XDG_DATA_HOME, so two runs at once fail
  // with "database is locked". Each workspace gets its own data dir (stable across fix attempts, so
  // --session still resumes) with the user's auth files linked in.
  isolate({ cwd, env = process.env } = {}) {
    if (!cwd) return null;
    const shared = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
    const key = crypto.createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 16);
    // One namespace per user: on a shared /tmp a 0700 parent created by one user would lock out the rest.
    let user = 'user';
    try { user = String(os.userInfo().uid >= 0 ? os.userInfo().uid : os.userInfo().username); } catch { /* no passwd entry */ }
    const root = path.join(os.tmpdir(), `delegate-fleet-opencode-${user}`, key);
    const data = path.join(root, 'opencode');
    // The data dir holds session history: only this user may read it, whatever the umask.
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    for (const dir of [root, data]) { try { fs.chmodSync(dir, 0o700); } catch { /* not ours to tighten */ } }
    for (const name of ['auth.json', 'mcp-auth.json']) {
      const target = path.join(shared, name);
      const link = path.join(data, name);
      if (!fs.existsSync(target)) {
        // A link to credentials that are no longer shared must not outlive them.
        // unlinkSync, not rmSync: rmSync follows a dangling link, finds nothing and silently keeps it.
        try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch { /* no link */ }
        continue;
      }
      // Re-point a link left by an earlier run (a moved or deleted XDG_DATA_HOME leaves it dangling).
      let current = null;
      try { current = fs.readlinkSync(link); } catch { current = null; }
      if (current === target) continue;
      try { fs.unlinkSync(link); } catch { /* no earlier link */ }
      try { fs.symlinkSync(target, link); } catch { /* a concurrent run linked it first */ }
    }
    return { XDG_DATA_HOME: root };
  },
  // `opencode models` prints one provider/model id per line.
  listModels: {
    args: ['models'],
    parse: (out) => out.split('\n').map((l) => l.trim()).filter((id) => /^[\w.-]+\/[\w.:-]+$/.test(id)),
  },
  probe(help, evidence = {}) {
    return {
      edit: /--auto/.test(help) ? 'verified' : 'unknown',
      readOnly: /--agent/.test(help) && /^\s*plan\b/m.test((evidence.extra || [])[0] || '') ? 'verified'
        : /--agent/.test(help) ? 'unknown' : 'unsupported',
      resumeById: /--session/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--variant/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--format/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/permission denied/i, /no provider configured/i],
};
