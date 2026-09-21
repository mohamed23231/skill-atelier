'use strict';

/**
 * The result contract.
 *
 * Two independent axes, deliberately not collapsed into one:
 *
 *   status    what happened to the PROCESS. Exactly one, terminal.
 *   findings  what happened to the REPOSITORY that needs a human decision.
 *             Zero or more, and computed even when the process failed — a
 *             worker that timed out can still have violated scope first.
 *
 * The relay fills both from mechanical facts. It never sets `accepted`; that
 * is the orchestrator's and only the orchestrator's.
 */

const SCHEMA_VERSION = 2;

/** Process outcomes. */
const STATUS = Object.freeze({
  INVALID_REQUEST: 'invalid_request',           // rejected before dispatch; nothing ran
  BACKEND_UNAVAILABLE: 'backend_unavailable',   // CLI absent here; nothing ran
  LAUNCH_FAILURE: 'launch_failure',             // spawn itself failed
  TIMEOUT: 'timeout',                           // watchdog fired; partial edits likely
  ABORTED: 'aborted',                           // relay was killed and forwarded the kill
  PROCESS_FAILURE: 'process_failure',           // non-zero exit or fatal signal
  IMPLEMENTER_FAILURE: 'implementer_failure',   // exit 0, but the worker refused or could not auth
  NOOP: 'noop',                                 // exit 0 on an edit run, tree unchanged
  COMPLETED: 'completed',                       // exit 0 and the run did something
});

/** Repository findings. Each one blocks automatic acceptance. */
const FINDING = Object.freeze({
  SCOPE_VIOLATION: 'scope_violation',
  UNEXPECTED_REPOSITORY_CHANGE: 'unexpected_repository_change',
  WORKER_COMMIT: 'worker_commit',
  WORKER_STASH: 'worker_stash',
  READ_ONLY_VIOLATION: 'read_only_violation',
});

/** Statuses where nothing was dispatched, so no repository facts exist. */
const PRE_DISPATCH = new Set([STATUS.INVALID_REQUEST, STATUS.BACKEND_UNAVAILABLE]);

/**
 * Derive repository findings. Pure.
 * `diff` may be null when git could not report, in which case the absence of
 * findings means "unknown", not "clean" — the contract records that separately
 * via repository.observed.
 */
function deriveFindings({ mode, diff, scopeReport }) {
  const findings = [];
  if (!diff) return findings;

  if (scopeReport && scopeReport.outOfScope.length > 0) {
    findings.push({
      type: FINDING.SCOPE_VIOLATION,
      detail: `${scopeReport.outOfScope.length} path(s) changed outside the declared scope`,
      paths: scopeReport.outOfScope,
    });
  }

  if (mode === 'read-only' && (diff.created.length || diff.modified.length || diff.deleted.length || diff.renamed.length)) {
    findings.push({
      type: FINDING.READ_ONLY_VIOLATION,
      detail: 'a read-only run changed the working tree',
      paths: [...diff.created, ...diff.modified, ...diff.deleted],
    });
  }

  if (diff.headChanged) {
    findings.push({
      type: FINDING.WORKER_COMMIT,
      detail: `HEAD moved during the run (${String(diff.headBefore).slice(0, 8)} -> ${String(diff.headAfter).slice(0, 8)}); the worker committed`,
      paths: [],
    });
  }

  if (diff.stashChanged) {
    findings.push({ type: FINDING.WORKER_STASH, detail: 'the stash ref moved during the run', paths: [] });
  }

  const disturbed = [...new Set([...diff.preExistingModified, ...diff.vanished])].sort();
  if (disturbed.length > 0) {
    findings.push({
      type: FINDING.UNEXPECTED_REPOSITORY_CHANGE,
      detail: 'the worker altered files that were already uncommitted before dispatch',
      paths: disturbed,
    });
  }

  return findings;
}

/**
 * Derive the process status. Pure.
 * Precedence matters: a timeout outranks whatever exit code the dying child
 * managed to emit, and a deny marker outranks a cooperative exit 0.
 */
function deriveStatus({ execResult, mode, diff, denyPatterns }) {
  if (execResult.outcome === 'launch_failure') {
    return { status: STATUS.LAUNCH_FAILURE, reason: execResult.error || 'the worker process could not be started' };
  }
  if (execResult.outcome === 'timeout') {
    return { status: STATUS.TIMEOUT, reason: 'the relay watchdog fired; the tree may hold partial edits' };
  }
  if (execResult.outcome === 'aborted') {
    return { status: STATUS.ABORTED, reason: 'the relay was terminated and forwarded the kill to the worker' };
  }

  const combined = `${execResult.stdout}\n${execResult.stderr}`;
  for (const pattern of denyPatterns || []) {
    if (pattern.test(combined)) {
      return { status: STATUS.IMPLEMENTER_FAILURE, reason: `the worker reported a refusal or auth failure matching ${pattern}` };
    }
  }

  if (execResult.signal) {
    return { status: STATUS.PROCESS_FAILURE, reason: `the worker was killed by ${execResult.signal}` };
  }
  if (execResult.exitCode !== 0) {
    return { status: STATUS.PROCESS_FAILURE, reason: `the worker exited ${execResult.exitCode}` };
  }

  if (mode === 'edit' && diff) {
    const moved = diff.created.length || diff.modified.length || diff.deleted.length || diff.renamed.length;
    if (!moved) {
      return { status: STATUS.NOOP, reason: 'the worker exited 0 but changed nothing; treat as a silent refusal until the log says otherwise' };
    }
  }

  return { status: STATUS.COMPLETED, reason: null };
}

/** Assemble the full versioned result. */
function buildResult(parts) {
  const {
    status, reason, findings = [], request, backend, execution,
    repository, artifacts, warnings = [],
  } = parts;

  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    reason: reason ?? null,
    // A result is safe to accept only when the process succeeded AND no
    // repository finding is outstanding. This is arithmetic, not judgement.
    blocked: status !== STATUS.COMPLETED || findings.length > 0,
    findings,
    warnings,
    request: request ?? null,
    backend: backend ?? null,
    execution: execution ?? null,
    repository: repository ?? null,
    // The relay measures; it never verifies and never accepts.
    verification: { performedByRelay: false, requiredFromOrchestrator: true, checks: [] },
    acceptance: { decidedBy: 'orchestrator', accepted: null, committedBy: null },
    artifacts: artifacts ?? null,
  };
}

/** A terminal result for failures that happen before anything is dispatched. */
function preDispatchResult({ status, reason, request, backend, warnings = [] }) {
  return buildResult({
    status, reason, request, backend, warnings,
    execution: null,
    repository: { observed: false, reason: 'nothing was dispatched' },
    artifacts: null,
  });
}

module.exports = {
  SCHEMA_VERSION, STATUS, FINDING, PRE_DISPATCH,
  deriveFindings, deriveStatus, buildResult, preDispatchResult,
};
