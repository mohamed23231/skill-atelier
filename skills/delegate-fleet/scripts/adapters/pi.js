'use strict';
/** Pi (`pi`). Read-only is a restricted tool list, not a sandbox. */
module.exports = {
  id: 'pi',
  cli: 'pi',
  title: 'Pi',
  docs: 'https://github.com/earendil-works/pi-mono',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  promptDelivery: 'stdin',
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'documented',
    modelSelection: 'documented', effort: 'unsupported', structuredOutput: 'documented',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified on this machine
    budgetLimit: 'unsupported',
  },
  build(req) {
    const args = ['--mode', 'json'];
    if (req.model) args.push('--model', req.model);
    if (req.session) args.push('--session', req.session);
    if (req.mode === 'read-only') args.push('--no-approve', '--tools', 'read,grep,find,ls');
    else args.push('--approve');
    return { args };
  },
  probe(help) {
    return {
      edit: /--approve/.test(help) ? 'verified' : 'unknown',
      readOnly: /--tools/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--session/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--mode[\s\S]{0,120}?json/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /no provider/i],
};
