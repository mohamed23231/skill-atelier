'use strict';
/** Cursor Agent (`cursor-agent`). */
module.exports = {
  id: 'cursor',
  cli: 'cursor-agent',
  title: 'Cursor Agent',
  docs: 'https://cursor.com/cli',
  evidence: { method: '--help', platform: 'darwin', date: '2026-09-21' },
  capabilities: {
    edit: 'verified',
    readOnly: 'verified',
    resumeById: 'verified',
    modelSelection: 'verified',
    // Cursor expresses effort inside the model string (model[effort=high]),
    // not as its own flag. Declaring an `--effort` flag here would be a lie.
    effort: 'unsupported',
    structuredOutput: 'verified',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified in cursor-agent --help
    budgetLimit: 'unsupported',
  },
  build(req) {
    const args = ['-p', req.prompt, '--output-format', 'json'];
    if (req.mode === 'read-only') args.push('--mode', 'plan');
    else args.push('--force');
    if (req.model) args.push('--model', req.model);
    if (req.session) args.push('--resume', req.session);
    return { args };
  },
  probe(help) {
    return {
      edit: /--force/.test(help) ? 'verified' : 'unknown',
      readOnly: /--mode[\s\S]{0,300}?\bplan\b/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /permission denied/i],
};
