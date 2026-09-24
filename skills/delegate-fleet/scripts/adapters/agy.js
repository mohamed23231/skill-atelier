'use strict';
/** Google Antigravity (`agy`). */
module.exports = {
  id: 'agy',
  cli: 'agy',
  title: 'Google Antigravity',
  docs: 'https://antigravity.google',
  evidence: { method: '--help', platform: 'darwin', date: '2026-09-21' },
  capabilities: {
    edit: 'verified',
    readOnly: 'verified',
    resumeById: 'verified',
    modelSelection: 'verified',
    effort: 'verified',
    structuredOutput: 'verified',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified in agy --help
    budgetLimit: 'unsupported',
  },
  build(req) {
    const args = ['--print', req.prompt, '--output-format', 'json'];
    if (req.mode === 'read-only') args.push('--mode', 'plan');
    else args.push('--mode', 'accept-edits', '--dangerously-skip-permissions');
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.session) args.push('--conversation', req.session);
    return { args };
  },
  probe(help) {
    return {
      edit: /accept-edits/.test(help) ? 'verified' : 'unknown',
      readOnly: /--mode[\s\S]{0,300}?plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--conversation/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--effort/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/auto[- ]?denied/i, /not signed in/i, /permission denied/i, /not logged in/i, /please sign in/i],
};
