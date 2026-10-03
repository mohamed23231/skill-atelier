'use strict';
/** Qoder (`qodercli`). */
module.exports = {
  id: 'qoder',
  cli: 'qodercli',
  title: 'Qoder',
  docs: 'https://docs.qoder.com/en/cli/quick-start',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'documented',
    modelSelection: 'documented', effort: 'unsupported', structuredOutput: 'documented',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified on this machine
    budgetLimit: 'unsupported',
  },
  build(req) {
    const args = ['--output-format', 'stream-json', '--permission-mode', req.mode === 'read-only' ? 'plan' : 'auto'];
    if (req.session) args.push('--resume', req.session);
    if (req.model) args.push('--model', req.model);
    args.push('-p', req.prompt);
    return { args };
  },
  probe(help) {
    return {
      // build() emits `--permission-mode auto`, so that mode must exist.
      edit: /--permission-mode[\s\S]{0,300}?\bauto\b/.test(help) ? 'verified'
        : /--permission-mode/.test(help) ? 'unknown' : 'unsupported',
      readOnly: /--permission-mode[\s\S]{0,200}?plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i],
};
