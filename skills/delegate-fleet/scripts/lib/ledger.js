'use strict';

/**
 * The fleet's memory between runs: which workers are out of quota, and what
 * past runs cost. Both live under `.delegate-fleet/` and are plain JSON.
 *
 *   quota.json   workers marked exhausted, and until when
 *   runs/        every relay result, which the report and the limits read
 *
 * None of this is a safety boundary. It steers selection toward workers that
 * can actually take the job and keeps an expensive tier on a budget. A
 * worker that edits quota.json is caught by framework_state_modified like any
 * other framework file.
 */

const fs = require('node:fs');
const path = require('node:path');

const STATE_DIR = '.delegate-fleet';
const QUOTA_FILE = 'quota.json';
const DEFAULT_COOLDOWN_MINUTES = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Output that means "this account is out of quota", as opposed to "this task
 * failed". A match makes the worker skippable for a while; it never changes
 * the run's status.
 */
const QUOTA_PATTERNS = [
  /usage limit (reached|exceeded)/i,
  /rate[ -]?limit(ed| exceeded| reached)/i,
  /quota (exceeded|exhausted)/i,
  /insufficient[_ ]quota/i,
  /out of credits/i,
  /credit balance is too low/i,
  /you'?ve (hit|reached) your (usage )?limit/i,
];

function quotaPath(root) { return path.join(root, STATE_DIR, QUOTA_FILE); }

function loadQuota(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(quotaPath(root), 'utf8'));
    const backends = raw && typeof raw.backends === 'object' && !Array.isArray(raw.backends) ? raw.backends : {};
    return { backends };
  } catch {
    return { backends: {} };
  }
}

function saveQuota(root, quota) {
  fs.mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  fs.writeFileSync(quotaPath(root), `${JSON.stringify({ backends: quota.backends }, null, 2)}\n`);
}

/** The exhaustion record for a backend if it is still in force, else null. */
function exhaustedUntil(quota, id, now = Date.now()) {
  const rec = quota.backends[id];
  if (!rec || !rec.until) return null;
  const t = Date.parse(rec.until);
  return Number.isFinite(t) && t > now ? rec : null;
}

function markExhausted(root, id, untilMs, reason) {
  const quota = loadQuota(root);
  quota.backends[id] = { until: new Date(untilMs).toISOString(), reason: reason || null, at: new Date().toISOString() };
  saveQuota(root, quota);
  return quota.backends[id];
}

function clearExhausted(root, id) {
  const quota = loadQuota(root);
  const had = Boolean(quota.backends[id]);
  delete quota.backends[id];
  saveQuota(root, quota);
  return had;
}

/**
 * Parse `--until`: an ISO timestamp, a relative `+90m` / `+2h` / `+1d`, or a
 * clock time `HH:MM` (today, or tomorrow if that has passed).
 */
function parseUntil(text, now = Date.now()) {
  const s = String(text || '').trim();
  const rel = s.match(/^\+(\d+)([mhd])$/);
  if (rel) return now + Number(rel[1]) * { m: 60e3, h: 3600e3, d: DAY_MS }[rel[2]];
  const clock = s.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (Number(clock[1]) > 23 || Number(clock[2]) > 59) return null;
    return d.getTime() > now ? d.getTime() : d.getTime() + DAY_MS;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function matchesQuota(text) {
  return QUOTA_PATTERNS.find((p) => p.test(String(text || ''))) || null;
}

/** Every result.json under runs/, newest last. Unreadable ones are skipped. */
function loadRuns(root) {
  const runsDir = path.join(root, STATE_DIR, 'runs');
  const out = [];
  const visit = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'result.json') {
        try { out.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } catch { /* skip */ }
      } else if (e.isDirectory() && depth < 3) {
        visit(p, depth + 1);
      }
    }
  };
  visit(runsDir, 0);
  const started = (r) => Date.parse(r && r.execution && r.execution.startedAt) || 0;
  return out.filter((r) => r && r.execution).sort((a, b) => started(a) - started(b));
}

/** How many dispatched runs a tier started in the rolling 24 hours before now. */
function runsInLastDay(runs, tier, now = Date.now()) {
  return runs.filter((r) => {
    const t = Date.parse(r.execution.startedAt);
    return r.backend && r.backend.tier === tier && Number.isFinite(t) && now - t < DAY_MS;
  }).length;
}

module.exports = {
  QUOTA_FILE, QUOTA_PATTERNS, DEFAULT_COOLDOWN_MINUTES, DAY_MS,
  loadQuota, saveQuota, exhaustedUntil, markExhausted, clearExhausted, parseUntil, matchesQuota,
  loadRuns, runsInLastDay,
};
