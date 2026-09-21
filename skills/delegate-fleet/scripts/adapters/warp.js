'use strict';
/**
 * Warp Agent CLI (`oz`).
 * No permission modes and no sandbox: a warp run has full local tool access,
 * so there is no read-only mode to offer. Declaring one would be a lie.
 */
module.exports = {
  id: 'warp',
  cli: 'oz',
  title: 'Warp Agent CLI',
  docs: 'https://docs.warp.dev/cli/',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  // Warp's run flags live under `oz agent run --help`.
  helpArgs: ['agent', 'run', '--help'],
  capabilities: {
    edit: 'documented', readOnly: 'unsupported', resumeById: 'documented',
    modelSelection: 'documented', effort: 'unsupported', structuredOutput: 'documented',
  },
  build(req) {
    const args = ['agent', 'run', '--output-format', 'ndjson', '--cwd', req.cwd];
    if (req.model) args.push('--model', req.model);
    if (req.session) args.push('--conversation', req.session);
    args.push('--prompt', req.prompt);
    return { args };
  },
  probe(help) {
    return {
      edit: /agent/.test(help) ? 'verified' : 'unknown',
      readOnly: /--read-only|plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--conversation/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i],
};
