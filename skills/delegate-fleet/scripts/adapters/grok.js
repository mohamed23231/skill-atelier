'use strict';
/**
 * Grok Build (`grok`).
 * Flags sourced from amElnagdy/delegate-skills (verified there against grok
 * 1.0.25), not verified in this project. Grok's read-only is a sandbox profile
 * that still permits writes to /tmp and ~/.grok, so it is a repository
 * guarantee only — hence `documented`, which the relay refuses to lean on
 * until `doctor` confirms it here.
 */
module.exports = {
  id: 'grok',
  cli: 'grok',
  title: 'Grok Build',
  docs: 'https://github.com/superagent-ai/grok-cli',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  promptDelivery: 'file',
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'documented',
    modelSelection: 'documented', effort: 'documented', structuredOutput: 'documented',
    turnLimit: 'documented', // `--max-turns <N>` Maximum number of agent turns
    budgetLimit: 'unsupported', // budgetLimit could not be verified in grok --help
  },
  build(req) {
    const args = ['--output-format', 'json', '--no-alt-screen', '--no-auto-update'];
    args.push('--sandbox', req.mode === 'read-only' ? 'read-only' : 'workspace');
    if (req.mode !== 'read-only') args.push('--always-approve');
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.session) args.push('--resume', req.session);
    if (req.maxTurns) args.push('--max-turns', String(req.maxTurns));
    args.push('--prompt-file', req.promptFile);
    return { args };
  },
  probe(help) {
    return {
      edit: /--always-approve/.test(help) ? 'verified' : 'unknown',
      // build() emits `--sandbox read-only`. grok's help documents --sandbox
      // as taking a <PROFILE> without naming the profiles, so a bare flag
      // match proves nothing: unknown refuses the run without claiming the
      // backend cannot do it.
      readOnly: /--sandbox[^\r\n]*\bread-only\b/.test(help) ? 'verified'
        : /--sandbox/.test(help) ? 'unknown' : 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: /--effort/.test(help) ? 'verified' : 'unsupported',
      structuredOutput: /--output-format[^\r\n]*\bjson\b/.test(help) ? 'verified'
        : /--output-format/.test(help) ? 'unknown' : 'unsupported',
      turnLimit: /--max-turns/.test(help) ? 'verified' : 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /user cancelled the execution/i],
};
