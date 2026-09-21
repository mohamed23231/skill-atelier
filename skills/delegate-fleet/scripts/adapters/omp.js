'use strict';
/** Oh My Pi (`omp`). */
module.exports = {
  id: 'omp',
  cli: 'omp',
  title: 'Oh My Pi',
  docs: 'https://github.com/can1357/oh-my-pi',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  promptDelivery: 'stdin',
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'documented',
    modelSelection: 'documented', effort: 'documented', structuredOutput: 'documented',
  },
  build(req) {
    const args = ['--mode', 'json'];
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--thinking', req.effort);
    if (req.session) args.push('--session', req.session);
    if (req.mode === 'read-only') args.push('--tools', 'read,grep,glob');
    else args.push('--yolo');
    // Project-local extensions stay off: they are untrusted code in a
    // delegated run the orchestrator did not review.
    args.push('--no-extensions', '--no-skills', '--no-rules');
    return { args };
  },
  probe(help) {
    return {
      edit: /--yolo/.test(help) ? 'verified' : 'unknown',
      readOnly: /--tools/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--session/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--thinking/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--mode[\s\S]{0,120}?json/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /no provider/i],
};
