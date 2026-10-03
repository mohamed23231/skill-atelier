'use strict';
/**
 * Qwen Code (`qwen`), a Gemini-CLI derivative.
 * SUPPORTED but NOT VERIFIED here. Its flags track gemini-cli, which is why
 * resumeById is declared unsupported rather than unknown.
 */
module.exports = {
  id: 'qwen',
  cli: 'qwen',
  title: 'Qwen Code',
  docs: 'https://github.com/QwenLM/qwen-code',
  evidence: null,
  capabilities: {
    edit: 'documented',
    readOnly: 'documented',
    resumeById: 'unsupported',
    modelSelection: 'documented',
    effort: 'unsupported',
    structuredOutput: 'documented',
    turnLimit: 'unsupported', // turnLimit and budgetLimit could not be verified on this machine
    budgetLimit: 'unsupported',
  },
  build(req) {
    const args = ['-p', req.prompt, '-o', 'json'];
    args.push('--approval-mode', req.mode === 'read-only' ? 'plan' : 'yolo');
    if (req.model) args.push('--model', req.model);
    return { args };
  },
  probe(help) {
    return {
      // build() emits `--approval-mode yolo`. A bare --yolo elsewhere in the
      // help is not the flag this adapter passes.
      edit: /--approval-mode[\s\S]{0,300}?\byolo\b/.test(help) ? 'verified'
        : /--approval-mode/.test(help) ? 'unknown' : 'unsupported',
      readOnly: /--approval-mode[\s\S]{0,300}?plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
      turnLimit: 'unsupported',
      budgetLimit: 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /quota exceeded/i],
};
