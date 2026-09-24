'use strict';
/**
 * GitHub Copilot CLI (`copilot`).
 *
 * SUPPORTED but NOT VERIFIED: no machine in this project's verification runs
 * had `copilot` installed. Flags come from vendor documentation. Run
 * `node scripts/fleet.js doctor` on a machine that has it to promote these
 * claims to `verified` — the relay will not rely on an unverified read-only.
 */
module.exports = {
  id: 'copilot',
  cli: 'copilot',
  title: 'GitHub Copilot CLI',
  docs: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  evidence: null,
  capabilities: {
    edit: 'documented',
    readOnly: 'unknown',
    resumeById: 'unknown',
    modelSelection: 'documented',
    effort: 'unknown',
    structuredOutput: 'unknown',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified on this machine
    budgetLimit: 'unsupported',
  },
  build(req) {
    const args = ['-p', req.prompt];
    if (req.mode !== 'read-only') args.push('--allow-all-tools');
    if (req.model) args.push('--model', req.model);
    if (req.session) args.push('--resume', req.session);
    return { args };
  },
  probe(help) {
    return {
      edit: /--allow-all-tools/.test(help) ? 'verified' : 'unknown',
      readOnly: 'unsupported',
      resumeById: /--resume/.test(help) ? 'verified' : 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /permission denied/i],
};
