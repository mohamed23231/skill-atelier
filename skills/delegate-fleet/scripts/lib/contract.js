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

/**
 * Process outcomes.
 *
 * The relay is synchronous by design; running it in the background is the
 * orchestrator's job. There is deliberately no daemon mode, poller, or
 * "running" status.
 */
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
  FRAMEWORK_STATE_MODIFIED: 'framework_state_modified',
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

  const allChanged = [...new Set([
    ...diff.created, ...diff.modified, ...diff.deleted,
    ...diff.renamed.flatMap((r) => [r.from, r.to].filter(Boolean)),
  ])].sort();

  const frameworkPaths = allChanged.filter((p) => {
    const norm = p.replace(/\\/g, '/');
    return (norm === '.delegate-fleet' || norm.startsWith('.delegate-fleet/')) &&
           !(norm === '.delegate-fleet/runs' || norm.startsWith('.delegate-fleet/runs/'));
  });

  if (frameworkPaths.length > 0) {
    findings.push({
      type: FINDING.FRAMEWORK_STATE_MODIFIED,
      detail: `${frameworkPaths.length} framework state path(s) under .delegate-fleet/ were modified`,
      paths: frameworkPaths,
    });
  }

  if (mode === 'read-only' && (diff.created.length || diff.modified.length || diff.deleted.length || diff.renamed.length)) {
    findings.push({
      type: FINDING.READ_ONLY_VIOLATION,
      detail: 'a read-only run changed the working tree',
      // Renames count at both ends, or the orchestrator is told a file changed
      // without being told which file it came from.
      paths: allChanged,
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

  if (execResult.signal) {
    return { status: STATUS.PROCESS_FAILURE, reason: `the worker was killed by ${execResult.signal}` };
  }
  if (execResult.exitCode !== 0) {
    return { status: STATUS.PROCESS_FAILURE, reason: `the worker exited ${execResult.exitCode}` };
  }

  // Deny markers classify a COOPERATIVE exit 0 -- a worker that printed
  // "permission denied" and stopped. A crash is a process failure first; how
  // it died is more informative than what it happened to print on the way out.
  const moved = diff ? (diff.created.length || diff.modified.length || diff.deleted.length || diff.renamed.length) : 0;
  const combined = `${execResult.stdout}\n${execResult.stderr}`;
  let matchedPattern = null;
  for (const pattern of denyPatterns || []) {
    if (pattern.test(combined)) {
      matchedPattern = pattern;
      break;
    }
  }

  if (matchedPattern) {
    if (moved > 0) {
      // The worker matched a deny pattern but actually made changes to the repository.
      // Real changes are the stronger evidence: keep completed, record match as warning.
      return {
        status: STATUS.COMPLETED,
        reason: null,
        warning: `worker output matched deny pattern ${matchedPattern}, but repository changes were observed`,
      };
    }
    return { status: STATUS.IMPLEMENTER_FAILURE, reason: `the worker reported a refusal or auth failure matching ${matchedPattern}` };
  }

  if (mode === 'edit' && diff) {
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
    repository, artifacts, warnings = [], worker = null, checks = [],
  } = parts;

  // A run whose repository could not be observed has not been checked at all:
  // scope, noop and commit detection were every one of them disabled. Never
  // let automation read that as a clean result.
  const unobserved = Boolean(repository) && repository.observed === false;
  // A check the orchestrator named and that did not pass is a decision the
  // orchestrator must make. Skipped checks do not block on their own: they
  // are only ever skipped when the status already blocks.
  const failedChecks = checks.some((c) => c.passed === false);

  return {
    schemaVersion: SCHEMA_VERSION,
    status,
    reason: reason ?? null,
    // A result is safe to accept only when the process succeeded, no
    // repository finding is outstanding, and the repository was actually
    // observed. This is arithmetic, not judgement.
    blocked: status !== STATUS.COMPLETED || findings.length > 0 || unobserved || failedChecks,
    findings,
    warnings,
    request: request ?? null,
    backend: backend ?? null,
    execution: execution ?? null,
    repository: repository ?? null,
    // What the worker says about itself: final message, session, usage.
    // Self-reported evidence; it never feeds status, findings or blocked.
    worker: worker ?? null,
    // The relay runs only the checks it was handed and records their exit
    // codes. Passing checks are not acceptance: the diff is still read.
    verification: { performedByRelay: checks.length > 0, requiredFromOrchestrator: true, checks },
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
