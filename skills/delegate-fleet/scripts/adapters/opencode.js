'use strict';
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
  probe(help) {
    return {
      edit: /--auto/.test(help) ? 'verified' : 'unknown',
      readOnly: /--agent/.test(help) && /^\s*plan\b/m.test(help) ? 'verified'
        : /--agent/.test(help) ? 'unknown' : 'unsupported',
      resumeById: /--session/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--variant/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--format/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/permission denied/i, /no provider configured/i],
};
