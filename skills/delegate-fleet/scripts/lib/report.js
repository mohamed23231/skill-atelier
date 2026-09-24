'use strict';

/**
 * The worker's own report: its final message, session id, and token usage.
 *
 * This exists to save the orchestrator tokens. Without it, learning what the
 * worker said means reading the raw stdout log, which is often megabytes of
 * event stream. The relay extracts the few hundred bytes that matter.
 *
 * Everything here is SELF-REPORTED by the worker. It is evidence, not fact:
 * the diff says what changed; this says what the worker claims it did and
 * what the CLI says it spent. It never feeds status, findings, or `blocked`.
 *
 * Parsing is best effort and format-agnostic. It understands the common
 * shapes (a single JSON result object, or a JSON-lines event stream) and
 * falls back to the tail of plain text. An adapter may export
 * `parseReport(stdout)` to override it for a format this cannot read.
 */

const SUMMARY_CAP_CHARS = 2000;

/** Fields that carry a final human-readable message, most specific first. */
const TEXT_KEYS = ['result', 'response', 'final_message', 'finalMessage', 'text'];
const SESSION_KEYS = ['session_id', 'sessionId', 'sessionID', 'thread_id', 'threadId', 'conversation_id'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const first = (obj, keys) => {
  for (const k of keys) if (obj && obj[k] != null) return obj[k];
  return null;
};

/** Parse stdout into a list of JSON objects: one document, or one per line. */
function parseObjects(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return [];
  try {
    const whole = JSON.parse(text);
    if (Array.isArray(whole)) return whole.filter((o) => o && typeof o === 'object');
    if (whole && typeof whole === 'object') return [whole];
  } catch { /* not one document; try lines */ }
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip a non-JSON line */ }
  }
  return out;
}

/** Normalise one usage-like object to our field names. Null if it has none. */
function normaliseUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const cache = u.cache && typeof u.cache === 'object' ? u.cache : {};
  const usage = {
    inputTokens: num(first(u, ['input_tokens', 'inputTokens', 'prompt_tokens', 'input', 'prompt'])),
    outputTokens: num(first(u, ['output_tokens', 'outputTokens', 'completion_tokens', 'output', 'candidates'])),
    cacheReadTokens: num(first(u, ['cache_read_input_tokens', 'cached_input_tokens', 'cacheReadTokens', 'cached'])) ?? num(cache.read),
  };
  return Object.values(usage).some((v) => v !== null) ? usage : null;
}

function addUsage(total, u) {
  for (const k of Object.keys(u)) {
    if (u[k] === null) continue;
    total[k] = (total[k] || 0) + u[k];
  }
}

/** Find the text of the last message the worker produced. */
function extractText(objects) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    const direct = first(o, TEXT_KEYS);
    if (typeof direct === 'string' && direct.trim()) return direct;
    // Event streams nest the message: { item: { type: 'agent_message', text } },
    // { part: { type: 'text', text } }, { message: { content: [{ text }] } }.
    for (const key of ['item', 'part', 'message']) {
      const inner = o[key];
      if (!inner || typeof inner !== 'object') continue;
      const t = first(inner, TEXT_KEYS);
      if (typeof t === 'string' && t.trim() && inner.type !== 'reasoning') return t;
      if (Array.isArray(inner.content)) {
        const joined = inner.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('').trim();
        if (joined) return joined;
      }
    }
  }
  return null;
}

/**
 * Usage. A final `type: "result"` object carries the cumulative total, so it
 * wins outright; otherwise per-turn / per-step events are summed. Taking both
 * would double count.
 */
function extractUsage(objects) {
  const final = [...objects].reverse().find((o) => o.type === 'result' && (o.usage || o.total_cost_usd != null));
  const candidates = final ? [final] : objects;
  const total = {};
  let costUsd = null;
  let seen = false;
  for (const o of candidates) {
    const holder = o.usage ? o : (o.part && typeof o.part === 'object' ? o.part : o);
    const u = normaliseUsage(holder.usage) || normaliseUsage(holder.tokens);
    if (u) { addUsage(total, u); seen = true; }
    const cost = num(first(holder, ['total_cost_usd', 'cost_usd', 'costUsd', 'cost']));
    if (cost !== null) { costUsd = (costUsd || 0) + cost; seen = true; }
    // Gemini: { stats: { models: { <name>: { tokens: {...} } } } }.
    const models = o.stats && o.stats.models && typeof o.stats.models === 'object' ? o.stats.models : null;
    if (models) {
      for (const m of Object.values(models)) {
        const mu = normaliseUsage(m && m.tokens);
        if (mu) { addUsage(total, mu); seen = true; }
      }
    }
  }
  if (!seen) return null;
  return {
    inputTokens: total.inputTokens ?? null,
    outputTokens: total.outputTokens ?? null,
    cacheReadTokens: total.cacheReadTokens ?? null,
    costUsd: costUsd === null ? null : Math.round(costUsd * 1e6) / 1e6,
  };
}

function extractSession(objects) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const s = first(objects[i], SESSION_KEYS);
    if (typeof s === 'string' && s.trim()) return s;
  }
  return null;
}

/** Keep the END of a long message: that is where workers list what they changed. */
function cap(text) {
  const t = String(text).trim();
  if (t.length <= SUMMARY_CAP_CHARS) return { summary: t, summaryTruncated: false };
  return { summary: `…${t.slice(t.length - SUMMARY_CAP_CHARS)}`, summaryTruncated: true };
}

/**
 * Build the `worker` block of the result. Never throws: a report that cannot
 * be read is `source: "none"`, and the full log is still in the artifacts.
 */
function extract(stdout, adapter) {
  const empty = { selfReported: true, source: 'none', summary: null, summaryTruncated: false, sessionId: null, usage: null };
  try {
    if (adapter && typeof adapter.parseReport === 'function') {
      const r = adapter.parseReport(String(stdout || '')) || {};
      const text = typeof r.summary === 'string' && r.summary.trim() ? cap(r.summary) : { summary: null, summaryTruncated: false };
      return { ...empty, source: 'adapter', ...text, sessionId: r.sessionId || null, usage: r.usage || null };
    }
    const objects = parseObjects(stdout);
    if (objects.length) {
      const text = extractText(objects);
      return {
        ...empty,
        source: 'structured',
        ...(text ? cap(text) : {}),
        sessionId: extractSession(objects),
        usage: extractUsage(objects),
      };
    }
    const plain = String(stdout || '').trim();
    if (plain) return { ...empty, source: 'text-tail', ...cap(plain) };
    return empty;
  } catch {
    return empty;
  }
}

module.exports = { extract, parseObjects, SUMMARY_CAP_CHARS };
