'use strict';
/** Mistral Vibe (`vibe`). */
module.exports = {
  id: 'vibe',
  cli: 'vibe',
  title: 'Mistral Vibe',
  docs: 'https://github.com/mistralai/mistral-vibe',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'documented',
    // `--output streaming` is a human-readable stream, not a machine-readable
    // result, so there is no structured output to claim.
    modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'unsupported',
  },
  build(req) {
    const args = ['--output', 'streaming', '--agent', req.mode === 'read-only' ? 'plan' : 'default', '--trust'];
    if (req.session) args.push('--resume', req.session);
    args.push(`--prompt=${req.prompt}`);
    return { args };
  },
  probe(help) {
    return {
      edit: /--agent/.test(help) ? 'verified' : 'unknown',
      readOnly: /--agent[^\r\n]*\bplan\b/.test(help) ? 'verified' : 'unknown',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: 'unsupported',
      effort: 'unsupported',
      structuredOutput: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /invalid api key/i],
};
