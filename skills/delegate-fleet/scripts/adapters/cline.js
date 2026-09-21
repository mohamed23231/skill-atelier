'use strict';
/** Cline (`cline`). Plan mode requires auto-approve false; the pair is enforced here. */
module.exports = {
  id: 'cline',
  cli: 'cline',
  title: 'Cline',
  docs: 'https://github.com/cline/cline',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  promptDelivery: 'stdin',
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'unsupported',
    modelSelection: 'documented', effort: 'unsupported', structuredOutput: 'documented',
  },
  build(req) {
    const readOnly = req.mode === 'read-only';
    const args = ['--json', '-v', '--auto-approve', readOnly ? 'false' : 'true'];
    if (readOnly) args.push('--plan');
    if (req.model) args.push('--model', req.model);
    args.push('Read the brief on stdin and execute it exactly.');
    return { args };
  },
  probe(help) {
    return {
      edit: /--auto-approve/.test(help) ? 'verified' : 'unknown',
      readOnly: /--plan\b/.test(help) ? 'verified' : 'unsupported',
      resumeById: 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--json/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /no api key/i],
};
