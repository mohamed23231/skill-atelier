'use strict';

/**
 * The delegation brief.
 *
 * A worker starts with zero conversation history, so the brief is the entire
 * contract. It is linted mechanically before dispatch because a vague brief
 * fails on every backend, and a failure you paid for is the expensive kind.
 *
 * The non-negotiable constraints are NOT linted for — they are injected by the
 * relay on every run (see buildPrompt). A rule you can forget to write is not
 * a rule.
 */

const MIN_CHARS = 200;
const MAX_PROMPT_BYTES = 256 * 1024;

const SECTIONS = {
  objective: { pattern: /^#\s+Objective\b/im, required: true, hint: '# Objective' },
  scope: { pattern: /^##\s+Scope\b/im, required: true, hint: '## Scope' },
  acceptance: { pattern: /^##\s+Acceptance criteria\b/im, required: true, hint: '## Acceptance criteria' },
  context: { pattern: /^##\s+Context\b/im, required: false, hint: '## Context' },
  nonGoals: { pattern: /^##\s+Non-goals\b/im, required: false, hint: '## Non-goals' },
  verification: { pattern: /^##\s+Verification\b/im, required: false, hint: '## Verification' },
};

/** Unfilled template markers that mean the brief was never actually written. */
const PLACEHOLDERS = [/\bTBD\b/i, /\bTODO\b/, /<[a-z][a-z ._-]{2,}>/i, /\bFIXME\b/];

/**
 * Pull the body of one `## Heading` section.
 *
 * Only `#` and `##` are section headings. Matching `###` too would let a
 * nested `### Scope` earlier in the brief shadow the real `## Scope`, and the
 * relay would then reconcile the run against the wrong list of paths.
 */
function sectionBody(markdown, heading) {
  const re = new RegExp(`^##\\s+${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?=^#{1,2}\\s+|\\s*$(?![\\s\\S]))`, 'im');
  const m = markdown.match(re);
  return m ? m[1] : '';
}

/**
 * The declared scope: every backtick-quoted path under `## Scope`.
 * This list is what the relay reconciles the run against, so it is the single
 * most load-bearing part of the brief.
 */
function extractScope(markdown) {
  const body = sectionBody(markdown, 'Scope');
  const paths = new Set();
  const re = /`([^`\n]+)`/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const p = m[1].trim();
    // A path, not prose in backticks.
    if (p && !/\s/.test(p) && /[\w.]/.test(p)) paths.add(p.replace(/\/+$/, ''));
  }
  return [...paths];
}

function lint(markdown) {
  const errors = [];
  const warnings = [];
  const text = String(markdown || '');

  for (const [key, def] of Object.entries(SECTIONS)) {
    if (def.pattern.test(text)) continue;
    if (def.required) errors.push(`missing required section: ${def.hint}`);
    else warnings.push(`no ${def.hint} section — the worker will have to guess`);
    void key;
  }

  if (text.trim().length < MIN_CHARS) {
    errors.push(`brief is ${text.trim().length} characters; under ${MIN_CHARS} is too vague to dispatch`);
  }

  const scope = extractScope(text);
  if (scope.length === 0) {
    errors.push('no backtick-quoted paths under "## Scope" — scope reconciliation would be meaningless');
  }

  for (const p of PLACEHOLDERS) {
    if (p.test(text)) {
      warnings.push(`brief still contains an unfilled placeholder matching ${p}`);
      break;
    }
  }

  const acceptance = sectionBody(text, 'Acceptance criteria').trim();
  const acceptanceLines = acceptance ? acceptance.split('\n').filter((l) => l.trim()).length : 0;
  if (acceptanceLines === 0) {
    // A heading with nothing under it is not acceptance criteria. Without one
    // there is no oracle, so there is nothing to verify the run against.
    errors.push('"## Acceptance criteria" is empty — there would be nothing to verify the run against');
  } else if (acceptanceLines < 2) {
    warnings.push('only one acceptance criterion — most slices need more than one to be checkable');
  }

  return { ok: errors.length === 0, errors, warnings, scope };
}

/**
 * The constraints every delegated run carries, injected by the relay rather
 * than trusted to the brief author.
 */
const ENFORCED_CONSTRAINTS = [
  'Do NOT commit, push, stash, revert, or reset anything. Leave every change uncommitted in the working tree.',
  'Do NOT modify, revert, or "clean up" any file that was already modified before you started; that work belongs to someone else.',
  'Do NOT modify files outside the Scope section. If you believe another file must change, stop and say so in your final message instead of editing it.',
  'Do NOT install dependencies or edit lockfiles.',
  'Do NOT run repository-wide tests, linters, or builds; the orchestrator runs those and will verify your work independently.',
  'Your final message must list every file you changed and one line on why.',
];

/**
 * Build the self-contained prompt handed to the worker.
 * The brief text is embedded rather than referenced by path, so the run does
 * not depend on the worker being willing or able to read an extra file.
 */
function buildPrompt({ briefText, mode, scope }) {
  const modeLine = mode === 'read-only'
    ? 'This is a READ-ONLY analysis run. Do not create, modify, or delete any file. Report findings in your final message.'
    : 'This is an IMPLEMENTATION run. Modify only the files listed under Scope.';

  const prompt = [
    'You are a delegated worker. An orchestrating engineer planned this task, will review your diff, and owns the commit.',
    modeLine,
    '',
    'NON-NEGOTIABLE CONSTRAINTS:',
    ...ENFORCED_CONSTRAINTS.map((c, i) => `${i + 1}. ${c}`),
    '',
    scope && scope.length ? `Declared scope (${scope.length} path(s)): ${scope.join(', ')}` : '',
    '',
    '--- BEGIN TASK BRIEF ---',
    briefText.trim(),
    '--- END TASK BRIEF ---',
  ].filter((l) => l !== null).join('\n');

  return prompt;
}

function promptTooLarge(prompt) {
  const bytes = Buffer.byteLength(prompt, 'utf8');
  return bytes > MAX_PROMPT_BYTES ? bytes : 0;
}

module.exports = {
  lint,
  extractScope,
  sectionBody,
  buildPrompt,
  promptTooLarge,
  ENFORCED_CONSTRAINTS,
  SECTIONS,
  MIN_CHARS,
  MAX_PROMPT_BYTES,
};
