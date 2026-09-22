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
  // build() invokes `crush run`, so the flags to verify against live on the
  // subcommand's help, not the top-level one.
  helpArgs: ['run', '--help'],
  probe(help) {
    return {
      edit: /--yolo/.test(help) ? 'verified' : 'unknown',
      readOnly: 'unsupported',
      resumeById: 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: 'unsupported',
    };
  },
  denyPatterns: [/permission denied/i, /no provider/i],
};
