'use strict';
/**
 * Kimi Code (`kimi`).
 * Kimi runs in `auto` permission mode always and exposes no read-only mode,
 * so readOnly is genuinely unsupported rather than merely unverified.
 */
module.exports = {
  id: 'kimi',
  cli: 'kimi',
  title: 'Kimi Code',
  docs: 'https://moonshotai.github.io/kimi-code/en/',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  capabilities: {
    edit: 'documented', readOnly: 'unsupported', resumeById: 'documented',
    modelSelection: 'documented', effort: 'unsupported', structuredOutput: 'documented',
  },
  build(req) {
    const args = ['--output-format', 'stream-json'];
    if (req.model) args.push('-m', req.model);
    if (req.session) args.push('--session', req.session);
    // The `--prompt=` equals form binds a brief that begins with "-".
    args.push(`--prompt=${req.prompt}`);
    return { args };
  },
  probe(help) {
    return {
      edit: /--prompt/.test(help) ? 'verified' : 'unknown',
      readOnly: 'unsupported',
      resumeById: /--session/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /-m\b|--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /invalid api key/i],
};
