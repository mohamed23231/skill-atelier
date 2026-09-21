'use strict';
/**
 * Charm Crush (`crush run`).
 * SUPPORTED but NOT VERIFIED here. Run `doctor` on a machine that has it.
 */
module.exports = {
  id: 'crush',
  cli: 'crush',
  title: 'Charm Crush',
  docs: 'https://github.com/charmbracelet/crush',
  evidence: null,
  capabilities: {
    edit: 'documented',
    readOnly: 'unknown',
    resumeById: 'unknown',
    modelSelection: 'unknown',
    effort: 'unsupported',
    structuredOutput: 'unknown',
  },
  build(req) {
    const args = ['run', req.prompt];
    if (req.mode !== 'read-only') args.push('--yolo');
    if (req.model) args.push('--model', req.model);
    return { args };
  },
  probe(help) {
    return {
      edit: /--yolo/.test(help) ? 'verified' : 'unknown',
      readOnly: /--read-only|plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: /--session/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--json|--format/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/permission denied/i, /no provider/i],
};
