'use strict';
/**
 * Aider (`aider`).
 *
 * SUPPORTED but NOT VERIFIED here. Aider is the one backend that commits by
 * default: --auto-commits and --dirty-commits both default on, and the second
 * commits the user's PRE-EXISTING uncommitted work before editing. Both are
 * forced off and are deliberately not configurable through this relay.
 */
module.exports = {
  id: 'aider',
  cli: 'aider',
  title: 'Aider',
  docs: 'https://aider.chat/docs/scripting.html',
  evidence: null,
  capabilities: {
    edit: 'documented',
    readOnly: 'documented',
    resumeById: 'unsupported',
    modelSelection: 'documented',
    effort: 'unsupported',
    structuredOutput: 'unsupported',
  },
  build(req) {
    const args = ['--yes-always', '--no-auto-commits', '--no-dirty-commits'];
    if (req.mode === 'read-only') args.push('--dry-run');
    args.push('--message', req.prompt);
    if (req.model) args.push('--model', req.model);
    return { args };
  },
  probe(help) {
    return {
      edit: /--yes-always|--yes\b/.test(help) ? 'verified' : 'unknown',
      readOnly: /--dry-run/.test(help) ? 'verified' : 'unsupported',
      resumeById: 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: 'unsupported',
    };
  },
  denyPatterns: [/api key.*not.*set/i, /authentication.*fail/i],
};
