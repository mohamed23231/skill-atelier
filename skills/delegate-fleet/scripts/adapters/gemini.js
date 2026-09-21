'use strict';
/**
 * Gemini CLI (`gemini`).
 * --resume takes "latest" or an index, and --session-id *starts* a new session
 * with a chosen UUID. Neither resumes an arbitrary prior id, so resumeById is
 * genuinely unsupported rather than merely unverified.
 */
module.exports = {
  id: 'gemini',
  cli: 'gemini',
  title: 'Gemini CLI',
  docs: 'https://geminicli.com/docs',
  evidence: { method: '--help', platform: 'darwin', date: '2026-09-21' },
  capabilities: {
    edit: 'verified',
    readOnly: 'verified',
    resumeById: 'unsupported',
    modelSelection: 'verified',
    effort: 'unsupported',
    structuredOutput: 'verified',
  },
  build(req) {
    const args = ['-p', req.prompt, '-o', 'json'];
    args.push('--approval-mode', req.mode === 'read-only' ? 'plan' : 'yolo');
    if (req.model) args.push('--model', req.model);
    return { args };
  },
  probe(help) {
    return {
      edit: /--approval-mode[\s\S]{0,300}?yolo/.test(help) ? 'verified' : 'unknown',
      readOnly: /--approval-mode[\s\S]{0,300}?plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /quota exceeded/i],
};
