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

/** True when the capability is proven on the machine we are running on. */
function isVerified(state) {
  return state === EVIDENCE.verified;
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
  const merged = { ...declared };
  if (!localReport || typeof localReport !== 'object') return merged;
  for (const name of CAPABILITY_NAMES) {
    const observed = localReport[name];
    if (EVIDENCE_STATES.includes(observed)) merged[name] = observed;
  }
  return merged;
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_NAMES,
  EVIDENCE,
  EVIDENCE_STATES,
  AVAILABILITY,
  SAFETY_CRITICAL,
  claims,
  isVerified,
  isSafetyCritical,
  applyLocalEvidence,
};
