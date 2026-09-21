'use strict';
/**
 * Z.AI ZCode (`zcode`) — the CLI for GLM models.
 * Of ZCode's four modes only `plan` and `yolo` work headlessly; `build` and
 * `edit` block every write tool and exit 0 having changed nothing, which this
 * framework would report as a NOOP rather than success.
 */
module.exports = {
  id: 'zcode',
  cli: 'zcode',
  title: 'Z.AI ZCode (GLM)',
  docs: 'https://zcode.z.ai',
  evidence: { source: 'amElnagdy/delegate-skills', verifiedHere: false },
  promptDelivery: 'file',
  capabilities: {
    edit: 'documented', readOnly: 'documented', resumeById: 'documented',
    modelSelection: 'unsupported', effort: 'unsupported', structuredOutput: 'documented',
  },
  build(req) {
    const args = ['--json', '--no-color', '--mode', req.mode === 'read-only' ? 'plan' : 'yolo'];
    if (req.session) args.push('--resume', req.session);
    args.push('--attach', req.promptFile, '--prompt', 'Read the attached brief and execute it exactly.');
    return { args };
  },
  probe(help) {
    return {
      edit: /--mode[\s\S]{0,200}?yolo/.test(help) ? 'verified' : 'unknown',
      readOnly: /--mode[\s\S]{0,200}?plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--json/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/oauth response is not valid json/i, /unauthorized/i],
};
