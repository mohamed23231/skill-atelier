// Pure, DOM-free lens engine for the architecture workbench. Each lens answers one question about
// the same model -- how it is structured, what backs it, what changed, what could go wrong -- and
// encodes every component and connection with design tokens, never colors. Nothing here touches the
// document, so the same code runs under Node in the tests.

const LENSES = ['structure', 'evidence', 'change', 'risk'];

const LENS_EVIDENCE_KEY_ORDER = [
  'verified',
  'declared',
  'declared-unchecked',
  'asserted',
  'stale',
  'missing',
  'planned',
  'unknown',
];

const LENS_EVIDENCE_KEY = {
  verified: { label: 'Verified', stroke: 'ink', strokeStyle: 'solid' },
  declared: { label: 'Declared', stroke: 'line', strokeStyle: 'solid' },
  'declared-unchecked': { label: 'Declared, not checked', stroke: 'line', strokeStyle: 'solid' },
  asserted: { label: 'Asserted', stroke: 'line', strokeStyle: 'solid' },
  stale: { label: 'Stale', stroke: 'warn', strokeStyle: 'solid' },
  missing: { label: 'Missing', stroke: 'risk', strokeStyle: 'dashed' },
  planned: { label: 'Planned', stroke: 'line', strokeStyle: 'dotted' },
  unknown: { label: 'Inferred, assumed or unknown', stroke: 'warn', strokeStyle: 'dashed' },
};

const LENS_DELTA_ORDER = ['ADDED', 'CHANGED', 'REMOVED', 'MOVED', 'UNCHANGED'];

const LENS_DELTA_KEY = {
  ADDED: { label: 'Added', stroke: 'ok', strokeStyle: 'solid' },
  CHANGED: { label: 'Changed', stroke: 'warn', strokeStyle: 'solid' },
  REMOVED: { label: 'Removed', stroke: 'risk', strokeStyle: 'dashed' },
  MOVED: { label: 'Moved', stroke: 'line', strokeStyle: 'solid' },
  UNCHANGED: { label: 'Unchanged', stroke: 'line', strokeStyle: 'solid' },
};

function lensArray(value) {
  return Array.isArray(value) ? value : [];
}

function lensObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function lensBadge(text, tone) {
  return { text: text, tone: tone };
}

function lensNodeEncoding(overrides) {
  return Object.assign(
    { stroke: 'line', strokeStyle: 'solid', fill: null, badge: null, strike: false, mutedText: false, marker: null },
    overrides || {}
  );
}

function lensEdgeEncoding(stroke, strokeStyle) {
  return { stroke: stroke, strokeStyle: strokeStyle };
}

function lensKeyItem(id, label, stroke, strokeStyle) {
  return { id: id, label: label, stroke: stroke, strokeStyle: strokeStyle };
}

function lensFindings(spec) {
  const source = lensObject(spec);
  return lensArray(source.findings).concat(lensArray(lensObject(source.review).policyFindings));
}

function lensParts(spec) {
  const source = lensObject(spec);
  return {
    nodes: lensArray(source.nodes),
    edges: lensArray(source.edges),
    policies: lensArray(source.policies),
    findings: lensFindings(source),
  };
}

// Every lens that leaves edges alone reads them the structure way: a request is solid, an event dashed.
function lensStructureEdges(parts) {
  const edges = Object.create(null);
  let hasSync = false;
  let hasAsync = false;
  parts.edges.forEach((edge) => {
    if (!edge || edge.id == null) return;
    const sync = edge.communication !== 'async';
    if (sync) hasSync = true;
    else hasAsync = true;
    edges[edge.id] = lensEdgeEncoding('edge', sync ? 'solid' : 'dashed');
  });
  return { edges: edges, hasSync: hasSync, hasAsync: hasAsync };
}

function lensStructure(spec) {
  const parts = lensParts(spec);
  const nodes = Object.create(null);
  let hasRing = false;
  parts.nodes.forEach((node) => {
    if (!node || node.id == null) return;
    const ring = node.status !== 'VERIFIED';
    if (ring) hasRing = true;
    nodes[node.id] = lensNodeEncoding({ marker: ring ? 'exception-ring' : null });
  });
  const structure = lensStructureEdges(parts);
  const keyItems = [];
  if (structure.hasSync) keyItems.push(lensKeyItem('call', 'Call', 'edge', 'solid'));
  if (structure.hasAsync) keyItems.push(lensKeyItem('event', 'Event', 'edge', 'dashed'));
  if (hasRing) keyItems.push(lensKeyItem('not-backed', 'Not backed by evidence', 'line', 'solid'));
  return { nodes: nodes, edges: structure.edges, ghosts: [], keyItems: keyItems };
}

function lensEvidenceBadge(state, label, count) {
  if (state === 'verified') return lensBadge(`Verified · ${count}`, 'ok');
  if (state === 'declared') return lensBadge(`Declared · ${count}`, 'neutral');
  if (state === 'declared-unchecked') return lensBadge(`Declared, not checked · ${count}`, 'neutral');
  if (state === 'asserted') return lensBadge(label, 'neutral');
  if (state === 'stale') return lensBadge('Stale', 'warn');
  if (state === 'missing') return lensBadge('Missing', 'risk');
  if (state === 'planned') return lensBadge('Planned', 'neutral');
  return lensBadge(label, 'warn');
}

function lensEvidence(spec) {
  const parts = lensParts(spec);
  const nodes = Object.create(null);
  const seen = {};
  parts.nodes.forEach((node) => {
    if (!node || node.id == null) return;
    const evidence = nodeEvidence(spec, node.id);
    const base = LENS_EVIDENCE_KEY[evidence.state] || LENS_EVIDENCE_KEY.unknown;
    seen[evidence.state] = true;
    nodes[node.id] = lensNodeEncoding({
      stroke: base.stroke,
      strokeStyle: base.strokeStyle,
      marker: evidence.state === 'declared-unchecked' ? 'exception-ring' : null,
      badge: lensEvidenceBadge(evidence.state, evidence.label, evidence.locators.length),
    });
  });
  const keyItems = [];
  LENS_EVIDENCE_KEY_ORDER.forEach((state) => {
    if (!seen[state]) return;
    const base = LENS_EVIDENCE_KEY[state];
    keyItems.push(lensKeyItem(state, base.label, base.stroke, base.strokeStyle));
  });
  return { nodes: nodes, edges: lensStructureEdges(parts).edges, ghosts: [], keyItems: keyItems };
}

function lensChangeNode(node) {
  if (node.delta === 'ADDED') {
    return lensNodeEncoding({ stroke: 'ok', fill: 'ok-tint', badge: lensBadge('Added', 'ok') });
  }
  if (node.delta === 'CHANGED') {
    return lensNodeEncoding({ stroke: 'warn', badge: lensBadge('Changed', 'warn') });
  }
  if (node.delta === 'REMOVED') {
    return lensNodeEncoding({ stroke: 'risk', strokeStyle: 'dashed', strike: true, badge: lensBadge('Removed', 'risk') });
  }
  if (node.delta === 'MOVED') {
    const text = node.previousBoundary ? `Moved from ${node.previousBoundary}` : 'Moved';
    return lensNodeEncoding({ badge: lensBadge(text, 'neutral') });
  }
  return lensNodeEncoding({ fill: 'surface-2', mutedText: true });
}

function lensChangeEdge(edge) {
  if (edge.delta === 'ADDED') return lensEdgeEncoding('ok', 'solid');
  if (edge.delta === 'REMOVED') return lensEdgeEncoding('risk', 'dashed');
  return lensEdgeEncoding('edge', edge.communication !== 'async' ? 'solid' : 'dashed');
}

function lensChange(spec) {
  const parts = lensParts(spec);
  const nodes = Object.create(null);
  const present = {};
  parts.nodes.forEach((node) => {
    if (!node || node.id == null) return;
    nodes[node.id] = lensChangeNode(node);
    present[node.delta || 'UNCHANGED'] = true;
  });
  const edges = Object.create(null);
  parts.edges.forEach((edge) => {
    if (!edge || edge.id == null) return;
    edges[edge.id] = lensChangeEdge(edge);
    if (edge.delta) present[edge.delta] = true;
  });
  const keyItems = [];
  LENS_DELTA_ORDER.forEach((delta) => {
    if (!present[delta]) return;
    const base = LENS_DELTA_KEY[delta];
    keyItems.push(lensKeyItem(delta.toLowerCase(), base.label, base.stroke, base.strokeStyle));
  });
  return { nodes: nodes, edges: edges, ghosts: [], keyItems: keyItems };
}

function lensFirstFinding(findings, key, id) {
  let found = null;
  findings.forEach((finding) => {
    if (found || !finding) return;
    if (lensArray(finding[key]).indexOf(id) !== -1) found = finding;
  });
  return found;
}

function lensPolicyIdsWithFindings(findings) {
  const found = Object.create(null);
  findings.forEach((finding) => {
    if (finding && finding.policyId != null) found[finding.policyId] = true;
  });
  return found;
}

function lensPolicyMap(parts) {
  const byId = Object.create(null);
  parts.policies.forEach((policy) => {
    if (policy && policy.id != null) byId[policy.id] = policy;
  });
  return byId;
}

// A finding answers to a policy only when that policy is declared; built-in evidence findings
// (evidence.*) and unknown ids stay generic.
function lensFindingKind(byId, finding) {
  if (!finding || finding.policyId == null) return null;
  const policy = byId[finding.policyId];
  return policy && policy.kind ? policy.kind : null;
}

function lensNodeFindings(findings, nodeId) {
  return findings.filter((finding) => finding && lensArray(finding.nodeIds).indexOf(nodeId) !== -1);
}

function lensRiskNodeCounts(parts, nodeId, key) {
  return parts.edges.filter((edge) => edge && edge[key] === nodeId).length;
}

function lensRiskNodes(parts, options) {
  const byId = lensPolicyMap(parts);
  const nodes = Object.create(null);
  let hasFailure = false;
  let hasViolation = false;
  let hasFanLimit = false;
  let hasRequiredEvidence = false;
  parts.nodes.forEach((node) => {
    if (!node || node.id == null) return;
    const findings = lensNodeFindings(parts.findings, node.id);
    let generic = null;
    let fan = null;
    let missingEvidence = false;
    findings.forEach((finding) => {
      if (!finding) return;
      hasViolation = true;
      const kind = lensFindingKind(byId, finding);
      if (kind === 'fan_in' || kind === 'fan_out') {
        if (!fan) fan = { finding: finding, kind: kind, policy: byId[finding.policyId] };
        return;
      }
      if (kind === 'required_evidence') {
        missingEvidence = true;
        return;
      }
      if (!generic) generic = finding;
    });
    const modes = lensArray(lensObject(node.details).failureModes);
    let stroke = 'line';
    let badge = null;
    let marker = null;
    if (generic) {
      stroke = 'risk';
      badge = lensBadge(generic.policyId != null ? String(generic.policyId) : 'Violation', 'risk');
    } else if (fan) {
      hasFanLimit = true;
      stroke = 'risk';
      const counted = fan.kind === 'fan_out' ? 'source' : 'target';
      const actual = lensRiskNodeCounts(parts, node.id, counted);
      const limit = fan.policy && typeof fan.policy.max === 'number' ? fan.policy.max : 0;
      const label = fan.kind === 'fan_out' ? 'fan-out' : 'fan-in';
      badge = lensBadge(`${label} ${actual} / max ${limit}`, 'risk');
    } else if (modes.length > 0) {
      hasFailure = true;
      stroke = 'warn';
      badge = lensBadge(`${modes.length} failure mode${modes.length === 1 ? '' : 's'}`, 'warn');
    }
    if (missingEvidence) {
      hasRequiredEvidence = true;
      marker = 'evidence-missing';
    }
    nodes[node.id] = lensNodeEncoding({ stroke: stroke, badge: badge, marker: marker });
  });
  return {
    nodes: nodes,
    hasFailure: hasFailure,
    hasViolation: hasViolation,
    hasFanLimit: hasFanLimit,
    hasRequiredEvidence: hasRequiredEvidence,
  };
}

// Layer-direction edges point against the layer order; cycle edges carry their position in the loop.
// Both are addressed by the finding that names them, so the canvas needs no policy knowledge.
function lensRiskEdgeMarks(parts) {
  const byId = lensPolicyMap(parts);
  const marks = Object.create(null);
  parts.findings.forEach((finding) => {
    if (!finding) return;
    const kind = lensFindingKind(byId, finding);
    const edgeIds = lensArray(finding.edgeIds);
    if (kind === 'layer_direction') {
      edgeIds.forEach((edgeId) => {
        if (edgeId == null) return;
        if (!marks[edgeId]) marks[edgeId] = {};
        marks[edgeId].marker = 'against-flow';
      });
      return;
    }
    if (kind !== 'cycle') return;
    const cycleNodes = lensArray(finding.nodeIds);
    const order = Object.create(null);
    cycleNodes.forEach((from, index) => {
      const to = cycleNodes[(index + 1) % cycleNodes.length];
      order[`${from}->${to}`] = index + 1;
    });
    parts.edges.forEach((edge) => {
      if (!edge || edge.id == null || edgeIds.indexOf(edge.id) === -1) return;
      const index = order[`${edge.source}->${edge.target}`];
      if (index == null) return;
      if (!marks[edge.id]) marks[edge.id] = {};
      if (marks[edge.id].cycleIndex == null) marks[edge.id].cycleIndex = index;
    });
  });
  return marks;
}

function lensRiskEdges(parts) {
  const edges = Object.create(null);
  const select = (policy, side) => parts.nodes.filter(node =>
    Boolean(policy[side] || policy[`${side}Type`] || policy[`${side}Boundary`]) &&
    (!policy[side] || node.id === policy[side]) &&
    (!policy[`${side}Type`] || node.type === policy[`${side}Type`]) &&
    (!policy[`${side}Boundary`] || node.boundary === policy[`${side}Boundary`])).map(node => node.id);
  const required = parts.policies.filter(policy => policy && policy.kind === 'required_dependency')
    .map(policy => ({ from: select(policy, 'from'), to: select(policy, 'to') }));
  const marks = lensRiskEdgeMarks(parts);
  let hasRequired = false;
  let hasViolation = false;
  let hasAgainstFlow = false;
  let hasCycle = false;
  parts.edges.forEach((edge) => {
    if (!edge || edge.id == null) return;
    const mark = marks[edge.id];
    if (mark && mark.marker === 'against-flow') hasAgainstFlow = true;
    if (mark && mark.cycleIndex != null) hasCycle = true;
    if (lensFirstFinding(parts.findings, 'edgeIds', edge.id)) {
      hasViolation = true;
      edges[edge.id] = Object.assign(lensEdgeEncoding('risk', 'solid'), mark || {});
      return;
    }
    const satisfies = required.some((policy) => policy.from.includes(edge.source) && policy.to.includes(edge.target));
    if (satisfies) {
      hasRequired = true;
      edges[edge.id] = lensEdgeEncoding('ok', 'solid');
      return;
    }
    edges[edge.id] = lensEdgeEncoding('edge', edge.communication !== 'async' ? 'solid' : 'dashed');
  });
  return {
    edges: edges,
    hasRequired: hasRequired,
    hasViolation: hasViolation,
    hasAgainstFlow: hasAgainstFlow,
    hasCycle: hasCycle,
  };
}

function lensRiskGhosts(parts, options) {
  const found = lensPolicyIdsWithFindings(parts.findings);
  const selected = options && options.selectedPolicyId;
  const absentForbidden = parts.policies.filter(
    (policy) => policy && policy.kind === 'forbidden_dependency' && (policy.id == null || !found[policy.id])
  );
  // Bound the default preview; an explicit selection isolates the requested policy.
  const drawn = absentForbidden.length <= 3 ? absentForbidden : selected == null
    ? absentForbidden.slice(0, 3) : absentForbidden.filter((policy) => policy.id === selected);
  const ghosts = drawn.map((policy) => ({
    from: policy.from,
    to: policy.to,
    fromType: policy.fromType, toType: policy.toType,
    fromBoundary: policy.fromBoundary, toBoundary: policy.toBoundary,
    label: 'Forbidden · absent',
    policyId: policy.id,
  }));
  let hasRequired = false;
  parts.policies.forEach((policy) => {
    if (!policy || policy.kind !== 'required_dependency') return;
    if (policy.id == null || !found[policy.id]) return;
    hasRequired = true;
    ghosts.push({ from: policy.from, to: policy.to, fromType: policy.fromType, toType: policy.toType,
      fromBoundary: policy.fromBoundary, toBoundary: policy.toBoundary, label: 'Required · missing', policyId: policy.id });
  });
  return { ghosts: ghosts, hasRequired: hasRequired, forbiddenCount: drawn.length };
}

function lensRisk(spec, options) {
  const parts = lensParts(spec);
  const nodeResult = lensRiskNodes(parts, options);
  const edgeResult = lensRiskEdges(parts);
  const ghostResult = lensRiskGhosts(parts, options);
  const keyItems = [];
  if (edgeResult.hasRequired || ghostResult.hasRequired) {
    keyItems.push(lensKeyItem('required', 'Required', 'ok', 'solid'));
  }
  if (ghostResult.forbiddenCount > 0) {
    keyItems.push(lensKeyItem('forbidden', 'Forbidden', 'risk', 'dashed'));
  }
  if (nodeResult.hasViolation || edgeResult.hasViolation) {
    keyItems.push(lensKeyItem('violation', 'Violation', 'risk', 'solid'));
  }
  if (edgeResult.hasAgainstFlow) {
    keyItems.push(lensKeyItem('against-layer-order', 'Against the layer order', 'risk', 'solid'));
  }
  if (edgeResult.hasCycle) {
    keyItems.push(lensKeyItem('cycle', 'Cycle', 'risk', 'solid'));
  }
  if (nodeResult.hasFanLimit) {
    keyItems.push(lensKeyItem('fan-limit', 'Over its fan-in or fan-out limit', 'risk', 'solid'));
  }
  if (nodeResult.hasRequiredEvidence) {
    keyItems.push(lensKeyItem('required-evidence', 'Missing required evidence', 'risk', 'solid'));
  }
  if (nodeResult.hasFailure) {
    keyItems.push(lensKeyItem('failure-modes', 'Failure modes', 'warn', 'solid'));
  }
  return { nodes: nodeResult.nodes, edges: edgeResult.edges, ghosts: ghostResult.ghosts, keyItems: keyItems };
}

function lensEncoding(lens, spec, options) {
  if (lens === 'evidence') return lensEvidence(spec);
  if (lens === 'change') return lensChange(spec, options);
  if (lens === 'risk') return lensRisk(spec, options);
  return lensStructure(spec);
}

function suggestedLens(chapter) {
  if (chapter === 'evidence') return 'evidence';
  if (chapter === 'changes' || chapter === 'plan') return 'change';
  if (chapter === 'review') return 'risk';
  return 'structure';
}
