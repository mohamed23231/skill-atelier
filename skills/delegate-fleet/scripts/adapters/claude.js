'use strict';
/**
 * Claude Code (`claude`).
 * Verified against the installed CLI's own --help; see `evidence`.
 */
module.exports = {
  id: 'claude',
  cli: 'claude',
  title: 'Claude Code',
  docs: 'https://code.claude.com/docs/en/overview',
  evidence: { method: '--help', platform: 'darwin', date: '2026-09-21' },
  capabilities: {
    edit: 'verified',
    readOnly: 'verified',
    resumeById: 'verified',
    modelSelection: 'verified',
    effort: 'verified',
    structuredOutput: 'verified',
    turnLimit: 'unsupported', // turnLimit could not be verified in claude --help
    budgetLimit: 'verified', // `--max-budget-usd <amount>` Maximum dollar amount to spend on API calls (only works with --print)
  },
  build(req) {
    const args = ['-p', req.prompt, '--output-format', 'json'];
    args.push('--permission-mode', req.mode === 'read-only' ? 'plan' : 'acceptEdits');
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.session) args.push('--resume', req.session);
    if (req.maxBudgetUsd) args.push('--max-budget-usd', String(req.maxBudgetUsd));
    return { args };
  },
  // Local verification: what the installed version's --help actually offers.
  probe(help) {
    return {
      // build() emits `--permission-mode acceptEdits`, so that mode must exist.
      edit: /--permission-mode[\s\S]{0,400}?\bacceptEdits\b/.test(help) ? 'verified'
        : /--permission-mode/.test(help) ? 'unknown' : 'unsupported',
      readOnly: /--permission-mode[\s\S]{0,400}?\bplan\b/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--effort/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: /--max-budget-usd/.test(help) ? 'verified' : 'unsupported',
    };
  },
  // Markers that mean "the CLI ran but refused/could not work", despite exit 0.
  denyPatterns: [/not logged in/i, /invalid api key/i, /permission denied/i],
};
