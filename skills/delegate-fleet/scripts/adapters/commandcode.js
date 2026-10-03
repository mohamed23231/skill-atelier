'use strict';
/**
 * Command Code (`cmd`, `cmdc` on Windows).
 * Headless has exactly two states: a plain -p run withholds write/edit/shell,
 * and --yolo allows everything anywhere the process can reach. There is
 * nothing in between, so a write run is full-trust and the brief's path list
 * is guidance, not containment.
 */
module.exports = {
  id: 'commandcode',
  cli: process.platform === 'win32' ? 'cmdc' : 'cmd',
  title: 'Command Code',
  docs: 'https://commandcode.ai/docs/headless',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  promptDelivery: 'stdin',
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'documented',
    modelSelection: 'documented', effort: 'documented', structuredOutput: 'documented',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified on this machine
    budgetLimit: 'unsupported',
  },
  build(req) {
    const args = ['-p', '--output-format', 'json', '--skip-onboarding', '--no-auto-update', '-t'];
    if (req.mode === 'read-only') args.push('--permission-mode', 'plan');
    else args.push('--yolo');
    if (req.session) args.push('--resume', req.session);
    if (req.model) args.push('-m', req.model);
    if (req.effort) args.push('--effort', req.effort);
    return { args };
  },
  probe(help) {
    return {
      edit: /--yolo/.test(help) ? 'verified' : 'unknown',
      readOnly: /--permission-mode[\s\S]{0,200}?plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /-m\b|--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--effort/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /too many arguments/i],
};
