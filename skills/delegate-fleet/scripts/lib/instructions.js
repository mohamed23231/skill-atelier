'use strict';

/**
 * Repository instruction files that tax every delegated run.
 *
 * Worker CLIs load AGENTS.md, CLAUDE.md and their kin on their own. When one
 * of those tells the agent to read a large state or plan file first, every
 * delegated worker pays for that file before it reads a word of the brief.
 * The relay's prompt tells workers not to, but a worker may still comply with
 * the file, so `doctor` names the offenders for the owner to fix at the source.
 */

const fs = require('node:fs');
const path = require('node:path');

const INSTRUCTION_FILES = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'QWEN.md', 'CONVENTIONS.md', '.cursorrules',
  '.github/copilot-instructions.md', '.windsurfrules',
];
const LARGE_BYTES = 40 * 1024;
const LARGE_LINES = 600;
// A line that asks the agent to take something in, as opposed to one that
// merely mentions a path.
const READ_VERB = /\b(read|load|review|consult|study|open|ingest|start (by|with)|before (you )?(start|begin|doing|any))\b/i;
const PATH_TOKEN = /`([^`\s]+)`|\]\(([^)\s#]+)\)|(?:^|\s)((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|mdx|txt|json|ya?ml))\b/g;

function countLines(file) {
  const buf = fs.readFileSync(file);
  let n = 0;
  for (const b of buf) if (b === 10) n += 1;
  return n + (buf.length && buf[buf.length - 1] !== 10 ? 1 : 0);
}

/** Return one warning per (instruction file, large file it tells agents to read). */
function scanPreloads(workspace) {
  const warnings = [];
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(workspace, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const seen = new Set();
    text.split('\n').forEach((line, i) => {
      if (!READ_VERB.test(line)) return;
      for (const m of line.matchAll(PATH_TOKEN)) {
        const ref = (m[1] || m[2] || m[3] || '').replace(/[.,;:]+$/, '');
        if (!ref || /^[a-z]+:\/\//i.test(ref) || seen.has(ref)) continue;
        for (const base of [workspace, path.dirname(file)]) {
          const target = path.resolve(base, ref);
          if (!target.startsWith(workspace + path.sep)) continue;
          let st;
          try { st = fs.statSync(target); } catch { continue; }
          if (!st.isFile()) continue;
          const lines = countLines(target);
          if (st.size >= LARGE_BYTES || lines >= LARGE_LINES) {
            seen.add(ref);
            warnings.push({
              file: name, line: i + 1, target: path.relative(workspace, target), bytes: st.size, lines,
              message: `${name}:${i + 1} tells agents to read ${path.relative(workspace, target)} (${lines} lines, ${Math.round(st.size / 1024)} KB). ` +
                'Every delegated worker may spend that context before the brief; point to it "when needed" instead of up front.',
            });
          }
          break;
        }
      }
    });
  }
  return warnings;
}

module.exports = { scanPreloads, INSTRUCTION_FILES, LARGE_BYTES, LARGE_LINES };
