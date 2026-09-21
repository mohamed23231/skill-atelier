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
  },
  build(req) {
    const args = ['-p', req.prompt, '-o', 'json'];
    args.push('--approval-mode', req.mode === 'read-only' ? 'plan' : 'yolo');
    if (req.model) args.push('--model', req.model);
    return { args };
  },
  probe(help) {
    return {
      edit: /--approval-mode[\s\S]{0,300}?yolo|--yolo/.test(help) ? 'verified' : 'unknown',
      readOnly: /--approval-mode[\s\S]{0,300}?plan/.test(help) ? 'verified' : 'unsupported',
      resumeById: 'unsupported',
      modelSelection: /--model/.test(help) ? 'verified' : 'unsupported',
      effort: 'unsupported',
      structuredOutput: /--output-format/.test(help) ? 'verified' : 'unsupported',
    };
  },
  denyPatterns: [/not authenticated/i, /quota exceeded/i],
};
