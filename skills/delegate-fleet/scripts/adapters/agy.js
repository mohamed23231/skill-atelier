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
    const notes = [];
    if (req.mode === 'read-only') args.push('--mode', 'plan');
    else args.push('--mode', 'accept-edits', '--dangerously-skip-permissions');
    if (req.model) args.push('--model', req.model);
    // agy refuses the whole run ("--effort is not supported for model ...")
    // when a Claude model is paired with --effort. Drop the flag, and say so.
    if (req.effort && /^claude-/i.test(req.model || '')) notes.push(`--effort ${req.effort} dropped: agy rejects --effort for Claude models`);
    else if (req.effort) args.push('--effort', req.effort);
    if (req.session) args.push('--conversation', req.session);
    return { args, notes };
  },
  // `agy models` prints one "id<TAB>label" line per model it can run.
  listModels: {
    args: ['models'],
    parse: (out) => out.split('\n').map((l) => l.split('\t')[0].trim()).filter((id) => /^[\w.-]+$/.test(id) && /\d/.test(id)),
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
  // agy reports a rejected run (bad model, bad flag combination) with exit 0
  // and `"status":"ERROR"` in its JSON, or a bare `error:` line on stderr.
  denyPatterns: [/auto[- ]?denied/i, /not signed in/i, /permission denied/i, /not logged in/i, /please sign in/i,
    /"status"\s*:\s*"ERROR"/, /^error: /m],
};
