// Pure, DOM-free trust model for the architecture workbench. It reads the embedded ARCH_SPEC and
// the quality gate and reports per-component evidence state plus the summary behind the trust strip.
// Nothing here touches the document, so the same code runs under Node in the tests.

function trustArray(value) {
  return Array.isArray(value) ? value : [];
}

function trustObject(value) {
  return value && typeof value === 'object' ? value : {};
}

// A locator is either the authored string or a stable key derived from its object shape.
function trustLocatorKey(locator) {
  if (typeof locator === 'string') return locator;
  const source = trustObject(locator);
  if (source.method && source.path) return `${source.method} ${source.path}`;
  if (source.path) return source.path;
  if (source.document) return source.document;
  if (source.table) return source.table;
  if (source.name) return source.name;
  if (source.assertion) return source.assertion;
  if (source.command) return source.command;
  return JSON.stringify(locator);
}

// Worst evidence state first: a claim is only as strong as its weakest record.
function trustEvidenceState(spec, node, records) {
  const verifications = records.map((record) => record.verification);
  const illustrative = trustObject(trustObject(spec).meta).grounding === 'illustrative';
  if (verifications.indexOf('unresolved') !== -1) return { state: 'missing', label: 'Missing' };
  if (verifications.indexOf('stale') !== -1) return { state: 'stale', label: 'Stale' };
  if (verifications.indexOf('compatibility') !== -1) {
    return illustrative
      ? { state: 'declared', label: 'Declared' }
      : { state: 'declared-unchecked', label: 'Declared, not checked' };
  }
  const asserted = records.find((record) => record.verification === 'asserted' || record.type === 'assertion');
  if (asserted) return { state: 'asserted', label: `Asserted by ${asserted.author || 'a reviewer'}` };
  if (records.length > 0 && verifications.every((value) => value === 'verified')) {
    return { state: 'verified', label: 'Verified' };
  }
  if (records.length === 0) {
    if (node.delta === 'ADDED') return { state: 'planned', label: 'Planned' };
    if (node.status === 'INFERRED') return { state: 'unknown', label: 'Inferred' };
    if (node.status === 'ASSUMED') return { state: 'unknown', label: 'Assumed' };
  }
  return { state: 'unknown', label: 'Unknown' };
}

function nodeEvidence(spec, nodeId) {
  const source = trustObject(spec);
  const node = trustArray(source.nodes).find((entry) => entry && entry.id === nodeId) || {};
  const evidenceIds = trustArray(node.evidenceIds);
  const records = trustArray(source.evidence).filter(
    (record) => record && ((nodeId != null && record.nodeId === nodeId) || evidenceIds.indexOf(record.id) !== -1)
  );
  const locators = [];
  const keys = new Set();
  records.forEach((record) => {
    const key = `${record.type}\u0000${trustLocatorKey(record.locator)}`;
    if (keys.has(key)) return;
    keys.add(key);
    locators.push(record);
  });
  const state = trustEvidenceState(source, node, records);
  return { records, locators, state: state.state, label: state.label };
}

function trustEntry(state, label, detail, chapter) {
  return { state, label, detail, chapter };
}

function trustGroundingEntry(spec) {
  const source = trustObject(spec);
  const meta = trustObject(source.meta);
  if (meta.grounding === 'illustrative') {
    return trustEntry('neutral', 'Illustrative', 'A design sketch: file paths are examples and were not checked.', 'evidence');
  }
  if (!meta.groundedAt) {
    return trustEntry('unchecked', 'Not grounded', 'The spec claims repository grounding but records no commit.', 'evidence');
  }
  const sha7 = String(meta.groundedAt).slice(0, 7);
  const stale = trustArray(source.evidence).filter((record) => record && record.verification === 'stale').length;
  if (stale > 0) {
    return trustEntry('warn', `${stale} stale since ${sha7}`, `${stale} evidence record(s) no longer match the grounded commit.`, 'evidence');
  }
  return trustEntry('ok', `Grounded at ${sha7}`, `Evidence was checked against commit ${sha7}.`, 'evidence');
}

function trustEvidenceEntry(spec) {
  const nodes = trustArray(trustObject(spec).nodes);
  // An actor is a person or a client outside the system: nothing in a repository can back it.
  const existing = nodes.filter((node) => node && node.delta !== 'ADDED' && node.type !== 'actor');
  const planned = nodes.filter((node) => node && node.delta === 'ADDED').length;
  let lacking = 0;
  let unbacked = 0;
  let verified = 0;
  existing.forEach((node) => {
    const evidence = nodeEvidence(spec, node.id);
    // Lacking means a claim with nothing behind it: a record that did not resolve, a VERIFIED status
    // without records, or evidence ids that point at nothing. An inferred node that never claimed
    // evidence is counted as without evidence, neither hidden nor raised as a warning.
    const claimed = node.status === 'VERIFIED' || trustArray(node.evidenceIds).length > 0;
    if (evidence.state === 'missing' || (evidence.records.length === 0 && claimed)) lacking += 1;
    else if (evidence.records.length === 0) unbacked += 1;
    else if (evidence.state === 'verified') verified += 1;
  });
  const total = existing.length;
  const backed = total - lacking - unbacked;
  const suffix = `${unbacked > 0 ? ` · ${unbacked} without evidence` : ''}${planned > 0 ? ` · ${planned} planned` : ''}`;
  if (lacking > 0) {
    return trustEntry('warn', `${lacking} of ${total} existing lack evidence${suffix}`, `${lacking} of ${total} existing components claim evidence that is not there.`, 'evidence');
  }
  if (total > 0 && verified === total) {
    return trustEntry('ok', `${total}/${total} existing verified${suffix}`, 'Every existing component cites verified evidence.', 'evidence');
  }
  return trustEntry('unchecked', `${backed}/${total} existing backed${suffix}`, 'Existing components cite evidence that was declared, not verified.', 'evidence');
}

function trustRulesEntry(spec) {
  const source = trustObject(spec);
  const policies = trustArray(source.policies);
  const findings = trustArray(source.findings).concat(trustArray(trustObject(source.review).policyFindings));
  const known = new Set();
  policies.forEach((policy) => {
    if (policy && policy.id != null) known.add(policy.id);
  });
  const violated = new Set();
  findings.forEach((finding) => {
    if (finding && finding.policyId != null && known.has(finding.policyId)) violated.add(finding.policyId);
  });
  const total = policies.length;
  if (total === 0) {
    return trustEntry('neutral', 'No rules', 'The specification declares no policies.', 'review');
  }
  if (violated.size === 0) {
    return trustEntry('ok', `${total}/${total} rules pass`, 'Every declared policy passed.', 'review');
  }
  const count = violated.size;
  return trustEntry('risk', `${count} violation${count === 1 ? '' : 's'} of ${total}`, `${count} of ${total} policies were violated by findings.`, 'review');
}

function trustOpenItemsEntry(spec) {
  const source = trustObject(spec);
  const review = trustObject(source.review);
  const meta = trustObject(source.meta);
  const questions = Array.isArray(review.unresolvedQuestions) ? review.unresolvedQuestions : trustArray(meta.unresolvedQuestions);
  const assumptions = Array.isArray(review.assumptions) ? review.assumptions : trustArray(meta.assumptions);
  const q = questions.length;
  const a = assumptions.length;
  if (q > 0) {
    let label = `${q} open question${q === 1 ? '' : 's'}`;
    if (a > 0) label += ` · ${a} assumption${a === 1 ? '' : 's'}`;
    return trustEntry('warn', label, `${q} question(s) and ${a} assumption(s) remain open.`, 'review');
  }
  if (a > 0) {
    return trustEntry('neutral', `${a} assumption${a === 1 ? '' : 's'}`, `${a} assumption(s) were declared without verification.`, 'review');
  }
  return trustEntry('ok', 'No open items', 'No unresolved questions or assumptions.', 'review');
}

function trustGateEntry(gate) {
  const entries = trustArray(gate);
  if (entries.length === 0) {
    return trustEntry('unchecked', 'Gate not run', '', 'review');
  }
  const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
  entries.forEach((entry) => {
    if (entry && counts[entry.status] !== undefined) counts[entry.status] += 1;
  });
  let state = 'ok';
  if (counts.FAIL > 0) state = 'risk';
  else if (counts.WARN > 0) state = 'warn';
  let label = `${counts.PASS} of ${entries.length} pass`;
  if (counts.SKIP > 0) label += ` · ${counts.SKIP} skipped`;
  if (counts.WARN > 0) label += ` · ${counts.WARN} warning${counts.WARN === 1 ? '' : 's'}`;
  if (counts.FAIL > 0) label += ` · ${counts.FAIL} failed`;
  const detail = entries
    .filter((entry) => entry && (entry.status === 'SKIP' || entry.status === 'WARN' || entry.status === 'FAIL'))
    .map((entry) => `${entry.name}: ${entry.detail}`)
    .join(' ');
  return trustEntry(state, label, detail, 'review');
}

function trustSummary(spec, gate) {
  return {
    grounding: trustGroundingEntry(spec),
    evidence: trustEvidenceEntry(spec),
    rules: trustRulesEntry(spec),
    openItems: trustOpenItemsEntry(spec),
    gate: trustGateEntry(gate),
  };
}
