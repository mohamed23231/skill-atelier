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
      readOnly: /--plan-only|--agent/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output[\s\S]{0,200}?json/i.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /invalid api key/i],
};
