'use strict';

/**
 * The capability vocabulary.
 *
 * A capability answers "what can this worker actually do", never "what does it
 * cost". Worker selection is capability-based: the orchestrator asks for the
 * behaviour a slice needs and takes any worker that can satisfy it.
 *
 * Keep this list small. Every capability here must be something an adapter can
 * really express in argv and a test can really prove reaches the backend.
 */

/** Every capability the framework understands. */
const CAPABILITIES = Object.freeze({
  edit: 'Modify files in the workspace headlessly.',
  readOnly: 'Refuse to modify files, enforced by the backend itself.',
  resumeById: 'Continue an earlier run addressed by a specific session id.',
  modelSelection: 'Choose the model for this run.',
  effort: 'Choose a reasoning-effort level for this run.',
  structuredOutput: 'Emit a machine-readable final result.',
});

const CAPABILITY_NAMES = Object.freeze(Object.keys(CAPABILITIES));

/**
 * The `req` field an adapter's build() must consult for a capability to be
 * more than a claim. `edit` and `structuredOutput` are shapes of the default
 * invocation rather than a per-run switch, so they have no field here.
 */
const CAPABILITY_REQUEST_FIELD = Object.freeze({
  readOnly: 'mode',
  modelSelection: 'model',
  effort: 'effort',
  resumeById: 'session',
});

/**
 * Evidence states for a *declared* capability. This is a claim about the
 * backend, independent of whether the backend is installed here.
 *
 *   verified     Proven against a real CLI. `doctor` records where and when.
 *   documented   Taken from vendor documentation. Plausible, not proven here.
 *   unsupported  The backend genuinely cannot do this.
 *   unknown      Not established. Never treat as support.
 */
const EVIDENCE = Object.freeze({
  verified: 'verified',
  documented: 'documented',
  unsupported: 'unsupported',
  unknown: 'unknown',
});

const EVIDENCE_STATES = Object.freeze(Object.values(EVIDENCE));

/**
 * Availability is a fact about *this machine*, discovered at runtime. It is
 * deliberately not stored in the adapter: the same adapter is correct on a
 * machine where the CLI is missing.
 */
const AVAILABILITY = Object.freeze({
  available: 'available',
  unavailable: 'unavailable',
  unknown: 'unknown',
});

/**
 * Capabilities whose failure is a safety problem rather than an inconvenience.
 *
 * A fake read-only run can silently destroy the user's working tree, so the
 * relay refuses to *rely* on a read-only claim that has not been verified on
 * this machine. Everything else degrades to a warning.
 */
const SAFETY_CRITICAL = Object.freeze(['readOnly']);

/** True when a declared capability state means "the backend can do this". */
function claims(state) {
  return state === EVIDENCE.verified || state === EVIDENCE.documented;
}

/**
 * True when the capability is proven on the machine we are running on.
 *
 * Only `applyLocalEvidence` can produce this state in a merged view, so a
 * `verified` here always came from a local `doctor` probe. An adapter file
 * cannot assert it into existence.
 */
function isVerified(state) {
  return state === EVIDENCE.verified;
}

/**
 * Which capabilities an adapter's build() can actually express.
 *
 * A capability that build() never reads is a flag the relay would accept and
 * then silently drop -- the exact class of defect that made v1 untrustworthy.
 * Deriving this from the source, rather than trusting a declaration, means a
 * probe cannot promote a capability into existence either.
 */
function expressibleCapabilities(adapter) {
  const src = typeof adapter.build === 'function' ? adapter.build.toString() : '';
  const set = new Set();
  for (const name of CAPABILITY_NAMES) {
    const field = CAPABILITY_REQUEST_FIELD[name];
    if (!field) { set.add(name); continue; }
    if (new RegExp(`req\\s*\\.\\s*${field}\\b`).test(src)) set.add(name);
  }
  return set;
}

/** Build a representative request, for checking what the invocation contains. */
function probeRequest(mode) {
  return {
    prompt: 'x', mode, model: null, effort: null, session: null,
    cwd: '/tmp/delegate-fleet-probe', promptFile: '/tmp/delegate-fleet-probe/brief.md',
  };
}

function builtArgs(adapter, mode) {
  try {
    return ((adapter.build(probeRequest(mode)) || {}).args || []).map(String);
  } catch {
    return null;
  }
}

/**
 * Does the invocation actually ask for machine-readable output?
 *
 * `structuredOutput` has no per-run switch, so nothing else would catch an
 * adapter that claims it and then emits a human-readable stream. A token
 * naming JSON in some form is the whole contract -- `--json`, `-o json`,
 * `--output-format stream-json`, `ndjson`. A flag like `--output streaming`
 * is a text stream and does not count.
 */
function deliversStructuredOutput(adapter) {
  const args = builtArgs(adapter, 'edit');
  return Boolean(args && args.some((a) => /json/i.test(a)));
}

/**
 * Does this adapter's read-only invocation actually *add* a restriction?
 *
 * Reading `req.mode` is not enough. An adapter that merely omits its
 * write-enabling flag in read-only mode is relying on the CLI's default
 * permissions, which is a hope, not an enforcement. A real read-only run
 * carries at least one argument that the edit run does not.
 */
function enforcesReadOnly(adapter) {
  const readOnlyArgs = builtArgs(adapter, 'read-only');
  const editArgs = builtArgs(adapter, 'edit');
  if (!readOnlyArgs || !editArgs) return false;
  const edit = new Set(editArgs);
  return readOnlyArgs.some((a) => !edit.has(a));
}

/**
 * Force every capability the adapter cannot express down to `unsupported`.
 * Applied to declarations at load time and to probe output at verify time, so
 * neither path can claim something the invocation will not carry.
 */
function clampToExpressible(states, adapter) {
  const expressible = expressibleCapabilities(adapter);
  const out = { ...states };
  for (const name of CAPABILITY_NAMES) {
    if (out[name] === undefined) continue;
    if (!expressible.has(name) && claims(out[name])) out[name] = EVIDENCE.unsupported;
  }
  if (claims(out.readOnly) && !enforcesReadOnly(adapter)) out.readOnly = EVIDENCE.unsupported;
  if (claims(out.structuredOutput) && !deliversStructuredOutput(adapter)) out.structuredOutput = EVIDENCE.unsupported;
  return out;
}

function isSafetyCritical(capability) {
  return SAFETY_CRITICAL.includes(capability);
}

/**
 * Merge a locally recorded verification report over an adapter's static
 * declaration. Local evidence always wins: the installed version is the truth,
 * the declaration is only the starting point. A local probe can both promote
 * (`documented` -> `verified`) and demote (`documented` -> `unsupported`).
 */
function applyLocalEvidence(declared, localReport) {
  const report = localReport && typeof localReport === 'object' ? localReport : null;
  const merged = {};
  for (const name of CAPABILITY_NAMES) {
    const observed = report ? report[name] : undefined;
    if (EVIDENCE_STATES.includes(observed)) { merged[name] = observed; continue; }
    // No local evidence for this capability. A declared `verified` was proven
    // on the author's machine, not on this one, so it may not stand as local
    // proof -- otherwise an adapter file could assert its way past the
    // safety gate. It survives as the claim it really is.
    const state = declared[name];
    merged[name] = state === EVIDENCE.verified ? EVIDENCE.documented : state;
  }
  return merged;
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_NAMES,
  CAPABILITY_REQUEST_FIELD,
  expressibleCapabilities,
  enforcesReadOnly,
  deliversStructuredOutput,
  clampToExpressible,
  EVIDENCE,
  EVIDENCE_STATES,
  AVAILABILITY,
  SAFETY_CRITICAL,
  claims,
  isVerified,
  isSafetyCritical,
  applyLocalEvidence,
};
