'use strict';
/**
 * OpenAI Codex (`codex exec`).
 * The only backend here whose read-only mode is an OS-level sandbox rather
 * than a withheld tool surface.
 */
module.exports = {
  id: 'codex',
  cli: 'codex',
  title: 'OpenAI Codex CLI',
  docs: 'https://github.com/openai/codex',
  evidence: { method: '--help', platform: 'darwin', date: '2026-09-21' },
  capabilities: {
    edit: 'verified',
    readOnly: 'verified',
    resumeById: 'verified',
    modelSelection: 'verified',
    effort: 'verified',
    structuredOutput: 'verified',
  },
  readOnlyEnforcement: 'sandbox',
  // Codex's flags live on the `exec` subcommand, not on top-level --help.
  helpArgs: ['exec', '--help'],
  build(req) {
    const sandbox = req.mode === 'read-only' ? 'read-only' : 'workspace-write';
    // `codex exec resume <id> <prompt>` is a subcommand, not a flag.
    const args = req.session
      ? ['exec', 'resume', req.session, req.prompt]
      : ['exec', req.prompt];
    args.push('--sandbox', sandbox, '--json');
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('-c', `model_reasoning_effort=${req.effort}`);
    return { args };
  },
  probe(help) {
    return {
      edit: /--sandbox[\s\S]{0,300}?workspace-write/.test(help) ? 'verified' : 'unknown',
      readOnly: /--sandbox[\s\S]{0,300}?read-only/.test(help) ? 'verified' : 'unsupported',
      resumeById: /\bresume\b/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--config|<key=value>/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--json/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/unauthorized/i, /not signed in/i, /sandbox.*denied/i],
};
