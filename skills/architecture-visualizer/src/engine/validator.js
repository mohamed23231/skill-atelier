const { RepoInspector, resolveRepoPath, EVIDENCE_TYPE, EVIDENCE_VERIFICATION, EVIDENCE_ORIGIN } = require('../utils/repo-inspector.js');

const VALID_NODE_TYPES = new Set(['actor', 'frontend', 'mobile', 'api_gateway', 'service', 'worker', 'database', 'cache', 'queue', 'topic', 'storage', 'external', 'cloud_function', 'boundary_group']);

const VALID_STATUSES = new Set(['VERIFIED', 'INFERRED', 'ASSUMED', 'UNKNOWN']);
const VALID_DELTAS = new Set(['UNCHANGED', 'ADDED', 'CHANGED', 'REMOVED', 'MOVED']);
const VALID_COMMUNICATIONS = new Set(['sync', 'async']);
const VALID_PATH_TYPES = new Set(['request', 'response', 'read', 'write', 'event', 'replication', 'control']);

const GATE_STATUS = {
  PASS: 'PASS',
  WARN: 'WARN',
  SKIP: 'SKIP',
};

const LIMITS = {
  nodeLabelChars: 22,
  technologyChars: 28,
  edgeLabelChars: 32,
  maxNodesForGlance: 25,
  maxBoundaries: 8,
  maxNodesPerBoundary: 6,
  maxEdgeToNodeRatio: 3,
  maxEdgeCardCrossingRatio: 0.15,
};

const SCHEMA_VERSION = {
  LEGACY: 1,
  CURRENT: 2,
};

function cloneSpec(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceSchemaVersion(spec) {
  if (spec && Number.isInteger(spec.schemaVersion)) {
    return spec.schemaVersion;
  }
  return SCHEMA_VERSION.LEGACY;
}

function asClonedArray(value) {
  return Array.isArray(value) ? value.map((entry) => cloneSpec(entry)) : [];
}

const FINDING_SEVERITY = {
  ERROR: 'error',
  WARN: 'warn',
  INFO: 'info',
};

const BUILTIN_POLICY = {
  EVIDENCE_REQUIRED: 'evidence.required',
  EVIDENCE_MISSING: 'evidence.missing',
  EVIDENCE_STALE: 'evidence.stale',
  EVIDENCE_UNRESOLVED_REF: 'evidence.unresolved_reference',
  EVIDENCE_OUTSIDE_REPO: 'evidence.outside_repo',
};

const POLICY_KIND = {
  FORBIDDEN_DEPENDENCY: 'forbidden_dependency',
  REQUIRED_DEPENDENCY: 'required_dependency',
  LAYER_DIRECTION: 'layer_direction',
  CYCLE: 'cycle',
  REQUIRED_EVIDENCE: 'required_evidence',
  FAN_IN: 'fan_in',
  FAN_OUT: 'fan_out',
};

const STAGE_KIND = {
  INTERACTION: 'interaction',
  PARALLEL: 'parallel',
  BRANCH: 'branch',
};

const SCENARIO_ORIGIN = {
  LEGACY_SEQUENCE: 'legacy-sequence',
  AUTHOR: 'author',
};

function uniqueIds(ids) {
  return [...new Set((ids || []).filter(Boolean))];
}

function slugId(parts) {
  return (
    parts
      .filter((part) => part != null && String(part) !== '')
      .join('_')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || 'item'
  );
}

function locatorFingerprint(type, locator = {}) {
  if (type === EVIDENCE_TYPE.FILE || type === EVIDENCE_TYPE.SYMBOL || type === EVIDENCE_TYPE.DOCUMENT) {
    return [type, locator.path || locator.document || '', locator.symbol || '', locator.startLine || '', locator.endLine || ''].join('|');
  }
  if (type === EVIDENCE_TYPE.API) {
    return [type, locator.method || '', locator.path || locator.apiPath || ''].join('|');
  }
  if (type === EVIDENCE_TYPE.TABLE) {
    return [type, locator.table || locator.name || ''].join('|');
  }
  if (type === EVIDENCE_TYPE.ASSERTION) {
    return [type, locator.assertion || ''].join('|');
  }
  if (type === EVIDENCE_TYPE.COMMAND) {
    return [type, locator.command || ''].join('|');
  }
  return [type, JSON.stringify(locator)].join('|');
}

function hasUncheckedLocator(record) {
  const locator = record.locator || {};
  return Boolean(record.type === EVIDENCE_TYPE.SYMBOL || locator.symbol || locator.startLine != null || locator.endLine != null);
}

function nodeHasEvidence(node, evidenceById) {
  const details = node.details || {};
  if ((details.files && details.files.length) || (details.apis && details.apis.length) || (details.tables && details.tables.length)) {
    return true;
  }
  if (!Array.isArray(node.evidenceIds) || !evidenceById) {
    return false;
  }
  return node.evidenceIds.some((id) => evidenceById.has(id));
}

function allocateEvidenceId(ids, parts) {
  let id = `ev_${slugId(parts)}`;
  let suffix = 2;
  while (ids.has(id)) {
    id = `ev_${slugId(parts)}_${suffix++}`;
  }
  return id;
}

function liftLegacyEvidence(model) {
  const evidence = Array.isArray(model.evidence) ? model.evidence.slice() : [];
  const ids = new Set(evidence.map((entry) => entry.id).filter(Boolean));

  function addEvidence(record, node) {
    const fingerprint = locatorFingerprint(record.type, record.locator);
    const existing = evidence.find((entry) => locatorFingerprint(entry.type, entry.locator) === fingerprint);
    if (existing) {
      node.evidenceIds = uniqueIds([...(node.evidenceIds || []), existing.id]);
      return;
    }
    if (!record.id || ids.has(record.id)) {
      record.id = allocateEvidenceId(ids, [record.origin, record.type, node.id, record.locator.path || record.locator.table || record.locator.method || record.locator.apiPath]);
    }
    ids.add(record.id);
    evidence.push(record);
    node.evidenceIds = uniqueIds([...(node.evidenceIds || []), record.id]);
  }

  (model.nodes || []).forEach((node) => {
    const details = node.details || {};
    (details.files || []).forEach((entry) => {
      const filePath = typeof entry === 'string' ? entry : entry && entry.path;
      if (!filePath) return;
      addEvidence(
        {
          type: EVIDENCE_TYPE.FILE,
          locator: { path: filePath },
          verification: EVIDENCE_VERIFICATION.COMPATIBILITY,
          origin: EVIDENCE_ORIGIN.LEGACY_FILES,
        },
        node
      );
    });
    (details.apis || []).forEach((entry) => {
      if (!entry || typeof entry !== 'object' || !entry.path) return;
      addEvidence(
        {
          type: EVIDENCE_TYPE.API,
          locator: { method: entry.method || 'GET', path: entry.path },
          verification: EVIDENCE_VERIFICATION.COMPATIBILITY,
          origin: EVIDENCE_ORIGIN.LEGACY_APIS,
        },
        node
      );
    });
    (details.tables || []).forEach((entry) => {
      const table = typeof entry === 'string' ? entry : entry && (entry.name || entry.table);
      if (!table) return;
      addEvidence(
        {
          type: EVIDENCE_TYPE.TABLE,
          locator: { table },
          verification: EVIDENCE_VERIFICATION.COMPATIBILITY,
          origin: EVIDENCE_ORIGIN.LEGACY_TABLES,
        },
        node
      );
    });
  });

  model.evidence = evidence;
}

function resolveModelEvidence(model, options) {
  const inspector = new RepoInspector(options.repoRoot);
  const verify = options.verifyFiles;
  model.evidence = (model.evidence || []).map((record) => {
    const cloned = cloneSpec(record);
    if (cloned.type === EVIDENCE_TYPE.ASSERTION) {
      cloned.verification = EVIDENCE_VERIFICATION.ASSERTED;
      return cloned;
    }
    if (!verify) {
      if (hasUncheckedLocator(cloned) && cloned.verification === EVIDENCE_VERIFICATION.VERIFIED) {
        cloned.verification = EVIDENCE_VERIFICATION.ASSERTED;
      }
      return cloned;
    }
    const inspected = inspector.inspectEvidence(cloned);
    cloned.verification = inspected.verification;
    if (Object.prototype.hasOwnProperty.call(inspected, 'exists')) {
      cloned.exists = inspected.exists;
    }
    delete cloned.absolutePath;
    delete cloned.resolvedPath;
    delete cloned.outsideRepo;
    if (inspected.resolvedPath) {
      cloned.resolvedPath = inspected.resolvedPath;
    }
    if (inspected.outsideRepo) {
      cloned.outsideRepo = true;
    }
    if (Object.prototype.hasOwnProperty.call(inspected, 'lineCount')) {
      cloned.lineCount = inspected.lineCount;
    }
    if (Object.prototype.hasOwnProperty.call(inspected, 'symbolFound')) {
      cloned.symbolFound = inspected.symbolFound;
    }
    return cloned;
  });
}

function collectEvidenceFindings(model, { verifyFilesOnDisk }) {
  if (!verifyFilesOnDisk) {
    return [];
  }

  const findings = [];
  const evidenceById = new Map((model.evidence || []).map((entry) => [entry.id, entry]));

  (model.nodes || []).forEach((node) => {
    if (node.status !== 'VERIFIED') {
      return;
    }
    if (!nodeHasEvidence(node, evidenceById)) {
      findings.push({
        id: `finding_evidence_required_${node.id}`,
        severity: FINDING_SEVERITY.WARN,
        message: `VERIFIED node "${node.id}" has no resolvable evidence.`,
        nodeIds: [node.id],
        edgeIds: [],
        policyId: BUILTIN_POLICY.EVIDENCE_REQUIRED,
        evidenceIds: [],
      });
    }
    (node.evidenceIds || []).forEach((id) => {
      const record = evidenceById.get(id);
      if (!record) {
        findings.push({
          id: `finding_evidence_unresolved_ref_${node.id}_${id}`,
          severity: FINDING_SEVERITY.WARN,
          message: `Node "${node.id}" references missing evidence "${id}".`,
          nodeIds: [node.id],
          edgeIds: [],
          policyId: BUILTIN_POLICY.EVIDENCE_UNRESOLVED_REF,
          evidenceIds: [id],
        });
        return;
      }
      if (record.outsideRepo) {
        findings.push({
          id: `finding_evidence_outside_repo_${record.id}`,
          severity: FINDING_SEVERITY.WARN,
          message: `Evidence "${record.id}" for node "${node.id}" does not point to a path under the repository root.`,
          nodeIds: [node.id],
          edgeIds: [],
          policyId: BUILTIN_POLICY.EVIDENCE_OUTSIDE_REPO,
          evidenceIds: [record.id],
        });
      } else if (record.verification === EVIDENCE_VERIFICATION.UNRESOLVED) {
        findings.push({
          id: `finding_evidence_missing_${record.id}`,
          severity: FINDING_SEVERITY.WARN,
          message: `Evidence "${record.id}" is unresolved for node "${node.id}".`,
          nodeIds: [node.id],
          edgeIds: [],
          policyId: BUILTIN_POLICY.EVIDENCE_MISSING,
          evidenceIds: [record.id],
        });
      }
      if (record.verification === EVIDENCE_VERIFICATION.STALE) {
        findings.push({
          id: `finding_evidence_stale_${record.id}`,
          severity: FINDING_SEVERITY.WARN,
          message: `Evidence "${record.id}" is stale for node "${node.id}".`,
          nodeIds: [node.id],
          edgeIds: [],
          policyId: BUILTIN_POLICY.EVIDENCE_STALE,
          evidenceIds: [record.id],
        });
      }
    });
  });

  findings.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return findings;
}

function appendUnresolvedEvidence(missingFiles, model) {
  const seen = new Set(missingFiles.map((entry) => `${entry.nodeId}:${entry.filePath}`));
  const evidenceById = new Map((model.evidence || []).map((entry) => [entry.id, entry]));
  (model.nodes || []).forEach((node) => {
    if (node.status !== 'VERIFIED') return;
    (node.evidenceIds || []).forEach((id) => {
      const record = evidenceById.get(id);
      if (!record || record.verification !== EVIDENCE_VERIFICATION.UNRESOLVED) return;
      const filePath = record.locator && record.locator.path;
      if (!filePath) return;
      const key = `${node.id}:${filePath}`;
      if (seen.has(key)) return;
      seen.add(key);
      missingFiles.push({
        nodeId: node.id,
        filePath,
        outsideRepo: Boolean(record.outsideRepo),
      });
    });
  });
}

function findEdgeId(edges, from, to) {
  const directed = (edges || []).find((edge) => edge.source === from && edge.target === to);
  if (directed) return directed.id || null;
  const undirected = (edges || []).find((edge) => edge.source === to && edge.target === from);
  return undirected ? undirected.id || null : null;
}

function normalizeScenarios(model) {
  if (Array.isArray(model.scenarios) && model.scenarios.length > 0) {
    model.scenarios.forEach((scenario) => {
      if (!scenario.origin) scenario.origin = SCENARIO_ORIGIN.AUTHOR;
    });
    return;
  }

  const steps = model.views && model.views.sequence && Array.isArray(model.views.sequence.steps) ? model.views.sequence.steps : [];
  if (steps.length === 0) {
    model.scenarios = [];
    return;
  }

  model.scenarios = [
    {
      id: 'scenario_sequence',
      name: (model.views.sequence && model.views.sequence.title) || 'Sequence',
      origin: SCENARIO_ORIGIN.LEGACY_SEQUENCE,
      stages: steps.map((step, index) => {
        const interaction = {
          id: `interaction_${index + 1}`,
          from: step.from,
          to: step.to,
          label: step.label,
        };
        const edgeId = findEdgeId(model.edges, step.from, step.to);
        if (edgeId) interaction.edgeId = edgeId;
        if (step.sync != null) interaction.sync = step.sync;
        return {
          id: `stage_${index + 1}`,
          kind: STAGE_KIND.INTERACTION,
          interactions: [interaction],
        };
      }),
    },
  ];
}

function walkStages(stages, visit) {
  (stages || []).forEach((stage) => {
    visit(stage);
    if (stage && stage.kind === STAGE_KIND.BRANCH) {
      (stage.branches || []).forEach((branch) => walkStages(branch.stages, visit));
    }
  });
}

function validateScenarios(model, nodeIds, edgeKeySet, errors, warnings) {
  (model.scenarios || []).forEach((scenario) => {
    walkStages(scenario.stages, (stage) => {
      if (stage.kind && ![STAGE_KIND.INTERACTION, STAGE_KIND.PARALLEL, STAGE_KIND.BRANCH].includes(stage.kind)) {
        warnings.push(`Unknown scenario stage kind "${stage.kind}" in scenario "${scenario.id}".`);
      }
      (stage.interactions || []).forEach((interaction, index) => {
        if (interaction.from && !nodeIds.has(interaction.from)) {
          errors.push(`Scenario "${scenario.id}" interaction ${index + 1} references invalid "from" node "${interaction.from}".`);
        }
        if (interaction.to && !nodeIds.has(interaction.to)) {
          errors.push(`Scenario "${scenario.id}" interaction ${index + 1} references invalid "to" node "${interaction.to}".`);
        }
        if (scenario.origin === SCENARIO_ORIGIN.LEGACY_SEQUENCE) return;
        if (interaction.from && interaction.to && !edgeKeySet.has(`${interaction.from}->${interaction.to}`) && !edgeKeySet.has(`${interaction.to}->${interaction.from}`)) {
          warnings.push(`Scenario "${scenario.id}" interaction "${interaction.label || interaction.id || index + 1}" has no matching edge between "${interaction.from}" and "${interaction.to}".`);
        }
      });
    });
  });
}

function policySeverity(policy) {
  return policy.severity || FINDING_SEVERITY.WARN;
}

function makePolicyFinding(policy, message, nodeIds, edgeIds, evidenceIds) {
  const nodes = uniqueIds(nodeIds).sort();
  const edges = uniqueIds(edgeIds).sort();
  const evidence = uniqueIds(evidenceIds || policy.evidenceIds || []).sort();
  return {
    id: `finding_policy_${slugId([policy.id, ...nodes, ...edges])}`,
    severity: policySeverity(policy),
    message,
    nodeIds: nodes,
    edgeIds: edges,
    policyId: policy.id,
    evidenceIds: evidence,
  };
}

function selectPolicyNodes(nodeMap, policy, side) {
  const id = policy[side];
  const type = policy[`${side}Type`];
  const boundary = policy[`${side}Boundary`];
  return [...nodeMap.values()].filter((node) => {
    if (id && node.id !== id) return false;
    if (type && node.type !== type) return false;
    if (boundary && node.boundary !== boundary) return false;
    return Boolean(id || type || boundary);
  });
}

function nodeHasEvidenceType(node, evidenceById, types) {
  if (!Array.isArray(types) || types.length === 0) {
    return nodeHasEvidence(node, evidenceById);
  }
  const details = node.details || {};
  if (types.includes(EVIDENCE_TYPE.FILE) && details.files && details.files.length) return true;
  if (types.includes(EVIDENCE_TYPE.API) && details.apis && details.apis.length) return true;
  if (types.includes(EVIDENCE_TYPE.TABLE) && details.tables && details.tables.length) return true;
  return (node.evidenceIds || []).some((id) => {
    const record = evidenceById.get(id);
    return record && types.includes(record.type);
  });
}

function findDirectedCycles(edges, nodeIds) {
  const graph = new Map();
  nodeIds.forEach((id) => graph.set(id, []));
  (edges || []).forEach((edge) => {
    if (!graph.has(edge.source) || !graph.has(edge.target)) return;
    graph.get(edge.source).push(edge.target);
  });

  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function dfs(node) {
    visiting.add(node);
    stack.push(node);
    (graph.get(node) || []).forEach((next) => {
      if (visiting.has(next)) {
        const start = stack.indexOf(next);
        if (start !== -1) cycles.push(stack.slice(start));
        return;
      }
      if (!visited.has(next)) dfs(next);
    });
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }

  [...nodeIds].sort().forEach((id) => {
    if (!visited.has(id)) dfs(id);
  });

  const unique = [];
  const seen = new Set();
  cycles.forEach((cycle) => {
    const key = [...cycle].sort().join('>');
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(cycle);
  });
  return unique;
}

function cycleEdgeIds(cycleNodes, edges) {
  const pairs = new Set();
  cycleNodes.forEach((from, index) => {
    const to = cycleNodes[(index + 1) % cycleNodes.length];
    pairs.add(`${from}->${to}`);
  });
  return (edges || []).filter((edge) => pairs.has(`${edge.source}->${edge.target}`)).map((edge) => edge.id || `${edge.source}->${edge.target}`);
}

function evaluatePolicies(model, { nodeMap, edges, nodeConnections, evidenceById }) {
  const findings = [];
  const warnings = [];

  (model.policies || []).forEach((policy) => {
    if (!policy || !policy.id) {
      warnings.push('Policy is missing a stable id and was skipped.');
      return;
    }

    const kind = policy.kind;
    if (kind === POLICY_KIND.FORBIDDEN_DEPENDENCY) {
      const fromNodes = selectPolicyNodes(nodeMap, policy, 'from');
      const toNodes = selectPolicyNodes(nodeMap, policy, 'to');
      const fromIds = new Set(fromNodes.map((node) => node.id));
      const toIds = new Set(toNodes.map((node) => node.id));
      (edges || []).forEach((edge) => {
        if (!fromIds.has(edge.source) || !toIds.has(edge.target)) return;
        findings.push(makePolicyFinding(policy, `Forbidden dependency from "${edge.source}" to "${edge.target}".`, [edge.source, edge.target], [edge.id], policy.evidenceIds));
      });
      return;
    }

    if (kind === POLICY_KIND.REQUIRED_DEPENDENCY) {
      const fromNodes = selectPolicyNodes(nodeMap, policy, 'from');
      const toNodes = selectPolicyNodes(nodeMap, policy, 'to');
      const fromIds = fromNodes.map((node) => node.id);
      const toIds = toNodes.map((node) => node.id);
      const satisfied = (edges || []).some((edge) => fromIds.includes(edge.source) && toIds.includes(edge.target));
      if (!satisfied) {
        findings.push(makePolicyFinding(policy, `Required dependency from "${fromIds.join(', ')}" to "${toIds.join(', ')}" is missing.`, [...fromIds, ...toIds], [], policy.evidenceIds));
      }
      return;
    }

    if (kind === POLICY_KIND.LAYER_DIRECTION) {
      const layers = Array.isArray(policy.layers) ? policy.layers : [];
      const indexByBoundary = new Map(layers.map((id, index) => [id, index]));
      (edges || []).forEach((edge) => {
        const source = nodeMap.get(edge.source);
        const target = nodeMap.get(edge.target);
        if (!source || !target) return;
        if (!indexByBoundary.has(source.boundary) || !indexByBoundary.has(target.boundary)) return;
        const fromIndex = indexByBoundary.get(source.boundary);
        const toIndex = indexByBoundary.get(target.boundary);
        if (toIndex < fromIndex) {
          findings.push(
            makePolicyFinding(
              policy,
              `Layer-direction violation: "${edge.source}" (${source.boundary}) depends on "${edge.target}" (${target.boundary}).`,
              [edge.source, edge.target],
              [edge.id],
              policy.evidenceIds
            )
          );
        }
      });
      return;
    }

    if (kind === POLICY_KIND.CYCLE) {
      const cycles = findDirectedCycles(edges, [...nodeMap.keys()]);
      cycles.forEach((cycleNodes) => {
        findings.push(makePolicyFinding(policy, `Cycle detected: ${cycleNodes.join(' → ')} → ${cycleNodes[0]}.`, cycleNodes, cycleEdgeIds(cycleNodes, edges), policy.evidenceIds));
      });
      return;
    }

    if (kind === POLICY_KIND.REQUIRED_EVIDENCE) {
      const status = policy.status || 'VERIFIED';
      const types = policy.evidenceTypes;
      [...nodeMap.values()].forEach((node) => {
        if (policy.componentType && node.type !== policy.componentType) return;
        if (node.status !== status) return;
        if (nodeHasEvidenceType(node, evidenceById, types)) return;
        findings.push(makePolicyFinding(policy, `Node "${node.id}" with status ${status} is missing required evidence.`, [node.id], [], node.evidenceIds));
      });
      return;
    }

    if (kind === POLICY_KIND.FAN_OUT) {
      if (typeof policy.max !== 'number') return;
      [...nodeConnections.entries()].forEach(([nodeId, counts]) => {
        const node = nodeMap.get(nodeId);
        if (policy.nodeType && node && node.type !== policy.nodeType) return;
        if (counts.out > policy.max) {
          findings.push(makePolicyFinding(policy, `Node "${nodeId}" fan-out ${counts.out} exceeds ${policy.max}.`, [nodeId], [], policy.evidenceIds));
        }
      });
      return;
    }

    if (kind === POLICY_KIND.FAN_IN) {
      if (typeof policy.max !== 'number') return;
      [...nodeConnections.entries()].forEach(([nodeId, counts]) => {
        const node = nodeMap.get(nodeId);
        if (policy.nodeType && node && node.type !== policy.nodeType) return;
        if (counts.in > policy.max) {
          findings.push(makePolicyFinding(policy, `Node "${nodeId}" fan-in ${counts.in} exceeds ${policy.max}.`, [nodeId], [], policy.evidenceIds));
        }
      });
      return;
    }

    const message = `Unknown policy kind "${kind}" on policy "${policy.id}".`;
    warnings.push(message);
    findings.push(makePolicyFinding(policy, message, [], [], policy.evidenceIds));
  });

  findings.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return { findings, warnings };
}

function reachableIds(start, adjacency) {
  const seen = new Set();
  const stack = [...(adjacency.get(start) || [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id) || id === start) continue;
    seen.add(id);
    (adjacency.get(id) || []).forEach((next) => stack.push(next));
  }
  return [...seen].sort();
}

function deriveReview(model, { findings, plannedComponents, nodeMap, edges }) {
  const changedComponents = [...nodeMap.values()]
    .filter((node) => node.delta && node.delta !== 'UNCHANGED')
    .map((node) => ({ id: node.id, label: node.label, delta: node.delta }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const adjacencyOut = new Map();
  const adjacencyIn = new Map();
  nodeMap.forEach((_node, id) => {
    adjacencyOut.set(id, []);
    adjacencyIn.set(id, []);
  });
  (edges || []).forEach((edge) => {
    if (!adjacencyOut.has(edge.source) || !adjacencyIn.has(edge.target)) return;
    adjacencyOut.get(edge.source).push(edge.target);
    adjacencyIn.get(edge.target).push(edge.source);
  });

  const blastRadius = changedComponents.map((entry) => ({
    nodeId: entry.id,
    delta: entry.delta,
    upstream: reachableIds(entry.id, adjacencyIn),
    downstream: reachableIds(entry.id, adjacencyOut),
  }));

  const assumptions = [];
  (model.meta && Array.isArray(model.meta.assumptions) ? model.meta.assumptions : []).forEach((text) => {
    assumptions.push({ source: 'meta', text });
  });
  [...nodeMap.values()]
    .filter((node) => node.status === 'ASSUMED')
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((node) => {
      assumptions.push({ source: 'node', nodeId: node.id, text: node.description || node.label });
    });

  const unresolvedQuestions = [];
  const metaQuestions =
    (model.meta && Array.isArray(model.meta.unresolvedQuestions) && model.meta.unresolvedQuestions) || (model.meta && Array.isArray(model.meta.questions) && model.meta.questions) || [];
  metaQuestions.forEach((text) => unresolvedQuestions.push({ source: 'meta', text }));
  [...nodeMap.values()]
    .filter((node) => node.status === 'UNKNOWN')
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((node) => {
      unresolvedQuestions.push({ source: 'node', nodeId: node.id, text: node.description || `UNKNOWN component "${node.id}"` });
    });

  const policyFindings = (findings || []).filter((finding) => finding.policyId && !String(finding.policyId).startsWith('evidence.'));

  const evidenceManifest = (model.evidence || []).map((entry) => ({
    id: entry.id,
    type: entry.type,
    verification: entry.verification,
    locator: entry.locator,
    origin: entry.origin,
  }));

  const changeNodes = [...nodeMap.values()].filter((node) => node.delta === 'ADDED' || node.delta === 'CHANGED' || node.delta === 'REMOVED');
  const traceability = {
    changed: changeNodes.map((node) => node.id).sort(),
    mapped: changeNodes
      .filter((node) => plannedComponents.has(node.id))
      .map((node) => node.id)
      .sort(),
    gaps: changeNodes
      .filter((node) => !plannedComponents.has(node.id))
      .map((node) => node.id)
      .sort(),
  };

  return {
    changedComponents,
    blastRadius,
    assumptions,
    unresolvedQuestions,
    policyFindings,
    evidenceManifest,
    traceability,
  };
}

function normalizeArchitecture(spec) {
  if (!spec || typeof spec !== 'object') {
    return spec;
  }

  const sourceVersion = sourceSchemaVersion(spec);
  const model = cloneSpec(spec);
  model.schemaVersion = SCHEMA_VERSION.CURRENT;
  model.compatibility = {
    sourceSchemaVersion: sourceVersion,
  };
  model.evidence = asClonedArray(spec.evidence);
  model.policies = asClonedArray(spec.policies);
  model.scenarios = asClonedArray(spec.scenarios);
  liftLegacyEvidence(model);
  normalizeScenarios(model);
  return model;
}

function validateArchitecture(spec, options = {}) {
  const errors = [];
  const warnings = [];
  const repoRoot = options.repoRoot || process.cwd();

  if (!spec || typeof spec !== 'object') {
    return {
      valid: false,
      errors: ['Specification must be a non-null object'],
      warnings: [],
      stats: {},
      gate: [],
      model: null,
      findings: [],
      review: deriveReview({ evidence: [], meta: {} }, { findings: [], plannedComponents: new Set(), nodeMap: new Map(), edges: [] }),
    };
  }

  const model = normalizeArchitecture(spec);

  const illustrative = spec.meta?.grounding === 'illustrative';
  const verifyFilesOnDisk = options.verifyFiles === false ? false : !illustrative;
  resolveModelEvidence(model, { repoRoot, verifyFiles: verifyFilesOnDisk });
  const findings = collectEvidenceFindings(model, { verifyFilesOnDisk });
  findings.forEach((finding) => {
    warnings.push(finding.message);
  });

  // 1. Meta validation
  if (!spec.meta || typeof spec.meta !== 'object') {
    errors.push('Missing "meta" object in architecture specification.');
  } else {
    if (!spec.meta.title || typeof spec.meta.title !== 'string') {
      errors.push('spec.meta.title is required.');
    }
    if (!spec.meta.description || typeof spec.meta.description !== 'string') {
      warnings.push('spec.meta.description is missing or empty.');
    }
  }

  // 2. Boundaries validation
  const boundaryIds = new Set();
  const boundaryParentMap = new Map();
  const boundaryMap = new Map();
  if (Array.isArray(spec.boundaries)) {
    spec.boundaries.forEach((b, index) => {
      if (!b.id || typeof b.id !== 'string') {
        errors.push(`Boundary at index ${index} must have a unique string id.`);
        return;
      }
      if (boundaryIds.has(b.id)) {
        errors.push(`Duplicate boundary ID "${b.id}".`);
      }
      boundaryIds.add(b.id);
      boundaryMap.set(b.id, b);
      if (!b.label) {
        warnings.push(`Boundary "${b.id}" has no human-readable label.`);
      }
      if (b.parent) {
        boundaryParentMap.set(b.id, b.parent);
      }
    });

    for (const [childId, parentId] of boundaryParentMap.entries()) {
      if (childId === parentId) {
        errors.push(`Boundary "${childId}" cannot be its own parent.`);
      }
      if (!boundaryIds.has(parentId)) {
        errors.push(`Boundary "${childId}" references non-existent parent "${parentId}".`);
      }
      let curr = parentId;
      const visited = new Set([childId]);
      while (curr && boundaryParentMap.has(curr)) {
        if (visited.has(curr)) {
          errors.push(`Cycle detected in boundary nesting starting at "${childId}".`);
          break;
        }
        visited.add(curr);
        curr = boundaryParentMap.get(curr);
      }
    }
  } else {
    warnings.push('spec.boundaries is not defined or not an array. Grouping into clusters is strongly recommended.');
  }

  // 3. Nodes validation
  const nodeIds = new Set();
  const nodeMap = new Map();
  const nodeConnections = new Map();
  const missingFiles = [];
  const boundaryPopulation = new Map();

  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    errors.push('spec.nodes must be a non-empty array of component nodes.');
  } else {
    spec.nodes.forEach((node, index) => {
      if (!node.id || typeof node.id !== 'string') {
        errors.push(`Node at index ${index} must have a unique string id.`);
        return;
      }
      if (nodeIds.has(node.id)) {
        errors.push(`Duplicate node ID "${node.id}".`);
      }
      nodeIds.add(node.id);
      nodeMap.set(node.id, node);
      nodeConnections.set(node.id, { in: 0, out: 0 });

      if (!node.label) {
        errors.push(`Node "${node.id}" has no label.`);
      }

      if (node.type && !VALID_NODE_TYPES.has(node.type)) {
        warnings.push(`Node "${node.id}" has unrecognized type "${node.type}". Expected one of: ${[...VALID_NODE_TYPES].join(', ')}.`);
      }

      if (node.status && !VALID_STATUSES.has(node.status)) {
        warnings.push(`Node "${node.id}" has invalid status "${node.status}". Expected VERIFIED, INFERRED, ASSUMED, or UNKNOWN.`);
      }

      if (node.delta && !VALID_DELTAS.has(node.delta)) {
        warnings.push(`Node "${node.id}" has invalid delta "${node.delta}". Expected UNCHANGED, ADDED, CHANGED, REMOVED, or MOVED.`);
      }

      if (node.boundary && !boundaryIds.has(node.boundary)) {
        errors.push(`Node "${node.id}" specifies boundary "${node.boundary}" which does not exist in spec.boundaries.`);
      }

      if (node.boundary) {
        boundaryPopulation.set(node.boundary, (boundaryPopulation.get(node.boundary) || 0) + 1);
      }

      if (Array.isArray(node.details?.failureModes)) {
        node.details.failureModes.forEach((entry, entryIndex) => {
          if (typeof entry === 'string') {
            if (entry.trim() === '') {
              errors.push(`Node "${node.id}" failureModes[${entryIndex}] is an empty string. Describe the risk or remove the entry.`);
            }
            return;
          }
          if (!entry || typeof entry !== 'object') {
            errors.push(`Node "${node.id}" failureModes[${entryIndex}] must be a string or an object, received ${typeof entry}.`);
            return;
          }
          if (!entry.failure && !entry.risk && !entry.description) {
            errors.push(`Node "${node.id}" failureModes[${entryIndex}] is an object without a "failure" field, so it would render as "undefined".`);
          }
        });
      }

      if (verifyFilesOnDisk && node.details && Array.isArray(node.details.files)) {
        node.details.files.forEach((fileEntry) => {
          const filePath = typeof fileEntry === 'string' ? fileEntry : fileEntry?.path;
          if (filePath && node.status === 'VERIFIED') {
            const resolved = resolveRepoPath(repoRoot, filePath);
            if (!resolved || !resolved.inside) {
              missingFiles.push({ nodeId: node.id, filePath, outsideRepo: true });
              warnings.push(
                `Node "${node.id}" marked VERIFIED references file "${filePath}", which is not under the repository root. Evidence must be a path inside the repository.`
              );
            } else if (!resolved.exists) {
              missingFiles.push({ nodeId: node.id, filePath, outsideRepo: false });
              warnings.push(
                `Node "${node.id}" marked VERIFIED references file "${filePath}", but it does not exist on disk under the repository root. Consider marking as ASSUMED or INFERRED if not yet created.`
              );
            }
          }
        });
      }
    });
  }

  if (verifyFilesOnDisk) {
    appendUnresolvedEvidence(missingFiles, model);
  }

  // 4. Edges validation
  const edgeIds = new Set();
  const unlabeledEdges = [];
  const edges = Array.isArray(spec.edges) ? spec.edges : [];
  const edgeKeySet = new Set();

  edges.forEach((edge, index) => {
    const edgeId = edge.id || `edge_${edge.source}_${edge.target}_${index}`;
    if (edgeIds.has(edgeId)) {
      warnings.push(`Duplicate edge id "${edgeId}".`);
    }
    edgeIds.add(edgeId);
    edgeKeySet.add(`${edge.source}->${edge.target}`);

    if (!edge.source || !nodeIds.has(edge.source)) {
      errors.push(`Edge at index ${index} references non-existent source node "${edge.source}".`);
    } else {
      nodeConnections.get(edge.source).out += 1;
    }

    if (!edge.target || !nodeIds.has(edge.target)) {
      errors.push(`Edge at index ${index} references non-existent target node "${edge.target}".`);
    } else {
      nodeConnections.get(edge.target).in += 1;
    }

    if (edge.communication && !VALID_COMMUNICATIONS.has(edge.communication)) {
      warnings.push(`Edge "${edgeId}" has unknown communication mode "${edge.communication}". Use "sync" or "async".`);
    }

    if (edge.pathType && !VALID_PATH_TYPES.has(edge.pathType)) {
      warnings.push(`Edge "${edgeId}" has unknown pathType "${edge.pathType}". Expected one of: ${[...VALID_PATH_TYPES].join(', ')}.`);
    }

    if (!edge.label && !edge.packetLabel) {
      unlabeledEdges.push(edgeId);
      warnings.push(`Edge between "${edge.source}" and "${edge.target}" has no label or protocol. Every relationship should describe its purpose or protocol.`);
    }
  });

  const isolatedNodes = [];
  for (const [nodeId, counts] of nodeConnections.entries()) {
    const node = nodeMap.get(nodeId);
    if (counts.in === 0 && counts.out === 0 && node && node.type !== 'actor') {
      isolatedNodes.push(nodeId);
      warnings.push(`Quality Gate Warning: Node "${nodeId}" (${node.label}) is completely isolated (0 inputs, 0 outputs). Ensure all components have clear interactions.`);
    }
  }

  // 5. Sequence view
  const sequenceSteps = Array.isArray(spec.views?.sequence?.steps) ? spec.views.sequence.steps : [];
  const unmappedSteps = [];
  sequenceSteps.forEach((step, index) => {
    if (!step.from || !nodeIds.has(step.from)) {
      errors.push(`Sequence step ${index + 1} (${step.label || 'unlabeled'}) references invalid "from" node "${step.from}".`);
    }
    if (!step.to || !nodeIds.has(step.to)) {
      errors.push(`Sequence step ${index + 1} (${step.label || 'unlabeled'}) references invalid "to" node "${step.to}".`);
    }
    if (!step.label) {
      warnings.push(`Sequence step ${index + 1} from "${step.from}" to "${step.to}" is missing a label.`);
    }
    if (step.from && step.to && !edgeKeySet.has(`${step.from}->${step.to}`) && !edgeKeySet.has(`${step.to}->${step.from}`)) {
      unmappedSteps.push(index + 1);
      warnings.push(
        `Sequence step ${index + 1} ("${step.label || 'unlabeled'}") has no matching edge between "${step.from}" and "${step.to}". The player will draw a temporary link instead of highlighting a real relationship.`
      );
    }
  });

  validateScenarios(model, nodeIds, edgeKeySet, errors, warnings);

  // 6. Database ER view
  if (spec.views && spec.views.database_er) {
    const er = spec.views.database_er;
    const tableNames = new Set();
    if (Array.isArray(er.tables)) {
      er.tables.forEach((table) => {
        if (!table.name) {
          errors.push('Database ER table must have a name.');
        } else {
          tableNames.add(table.name);
        }
      });
    }
    if (Array.isArray(er.relations)) {
      er.relations.forEach((rel, idx) => {
        if (!tableNames.has(rel.from)) {
          warnings.push(`Database relation ${idx} references table "${rel.from}" not listed in tables.`);
        }
        if (!tableNames.has(rel.to)) {
          warnings.push(`Database relation ${idx} references table "${rel.to}" not listed in tables.`);
        }
      });
    }
  }

  // 7. Implementation plan
  const plannedComponents = new Set();
  const planPhases = Array.isArray(spec.views?.implementation_plan?.phases) ? spec.views.implementation_plan.phases : [];
  planPhases.forEach((phase) => {
    (phase.tasks || []).forEach((task) => {
      if (task.componentId) {
        plannedComponents.add(task.componentId);
        if (!nodeIds.has(task.componentId)) {
          warnings.push(`Implementation task "${task.title}" references non-existent componentId "${task.componentId}".`);
        }
      }
    });
  });
  nodeMap.forEach((node, id) => {
    if (Array.isArray(node.details?.tasks) && node.details.tasks.length > 0) {
      plannedComponents.add(id);
    }
  });

  const evidenceById = new Map((model.evidence || []).map((entry) => [entry.id, entry]));
  const policyResult = evaluatePolicies(model, { nodeMap, edges, nodeConnections, evidenceById });
  policyResult.findings.forEach((finding) => {
    findings.push(finding);
    warnings.push(finding.message);
  });
  policyResult.warnings.forEach((warning) => {
    warnings.push(warning);
  });
  const review = deriveReview(model, { findings, plannedComponents, nodeMap, edges });

  const stats = {
    totalNodes: nodeIds.size,
    totalEdges: edgeIds.size,
    totalBoundaries: boundaryIds.size,
    verifiedCount: [...nodeMap.values()].filter((n) => n.status === 'VERIFIED').length,
    assumedCount: [...nodeMap.values()].filter((n) => n.status === 'ASSUMED').length,
    inferredCount: [...nodeMap.values()].filter((n) => n.status === 'INFERRED').length,
    unknownCount: [...nodeMap.values()].filter((n) => n.status === 'UNKNOWN').length,
    addedCount: [...nodeMap.values()].filter((n) => n.delta === 'ADDED').length,
    changedCount: [...nodeMap.values()].filter((n) => n.delta === 'CHANGED').length,
    removedCount: [...nodeMap.values()].filter((n) => n.delta === 'REMOVED').length,
    missingFileCount: missingFiles.length,
    grounding: illustrative ? 'illustrative' : 'repository',
    hasSequence: sequenceSteps.length > 0,
    hasER: Boolean(spec.views?.database_er?.tables?.length),
    hasImplementationPlan: planPhases.length > 0,
  };

  const gate = runQualityGate({
    spec,
    nodeMap,
    boundaryMap,
    boundaryPopulation,
    edges,
    stats,
    isolatedNodes,
    unlabeledEdges,
    unmappedSteps,
    missingFiles,
    plannedComponents,
    illustrative,
    evidence: model.evidence,
  });

  gate
    .filter((g) => g.status === GATE_STATUS.WARN)
    .forEach((g) => {
      warnings.push(`Quality Gate ${g.id}/${g.name}: ${g.detail}`);
    });

  const valid = errors.length === 0;

  return {
    valid,
    errors,
    warnings,
    stats,
    gate,
    model,
    findings,
    review,
  };
}

/**
 * Executes the 14 quality gate checks that can be decided mechanically.
 * Checks that require human judgement are reported as SKIP with guidance.
 */
/**
 * Gate 5 measures the drawing, not the model: sample each computed curve and
 * count the ones that pass through a card that is neither of its endpoints.
 */
function measureEdgeCardCrossings(spec) {
  let computeLayout;
  let cubicPointAt;
  try {
    ({ computeLayout, cubicPointAt } = require('./layout.js'));
  } catch {
    return null;
  }

  let layout;
  try {
    layout = computeLayout(spec);
  } catch {
    return null;
  }

  const SAMPLES = 100;
  const ids = [];

  layout.edges.forEach((edge) => {
    if (!edge.points || !edge.controls) return;
    const hit = layout.nodes.some((node) => {
      if (node.id === edge.source || node.id === edge.target) return false;
      for (let i = 1; i < SAMPLES; i++) {
        const p = cubicPointAt(i / SAMPLES, edge.points, edge.controls);
        if (p.x > node.x && p.x < node.x + node.width && p.y > node.y && p.y < node.y + node.height) return true;
      }
      return false;
    });
    if (hit) ids.push(edge.id);
  });

  return { count: ids.length, total: layout.edges.length, ids };
}

function runQualityGate(ctx) {
  const { spec, nodeMap, boundaryMap, boundaryPopulation, edges, stats, isolatedNodes, unlabeledEdges, unmappedSteps, missingFiles, plannedComponents, illustrative, evidence } = ctx;

  const gate = [];
  const add = (id, name, status, detail) => gate.push({ id, name, status, detail });

  // 1 - Glanceability
  if (stats.totalNodes === 0) {
    add(1, 'Glanceable', GATE_STATUS.WARN, 'No nodes to read.');
  } else if (stats.totalNodes > LIMITS.maxNodesForGlance) {
    add(1, 'Glanceable', GATE_STATUS.WARN, `${stats.totalNodes} nodes exceeds the ${LIMITS.maxNodesForGlance}-node comprehension budget. Split into subsystem views.`);
  } else {
    add(1, 'Glanceable', GATE_STATUS.PASS, `${stats.totalNodes} nodes across ${stats.totalBoundaries} boundaries.`);
  }

  // 2 - Clean boundaries
  const unassigned = [...nodeMap.values()].filter((n) => !n.boundary);
  if (stats.totalBoundaries === 0) {
    add(2, 'Clear boundaries', GATE_STATUS.WARN, 'No boundaries declared; every node lands in one generic cluster.');
  } else if (unassigned.length > 0) {
    add(2, 'Clear boundaries', GATE_STATUS.WARN, `${unassigned.length} node(s) have no boundary: ${unassigned.map((n) => n.id).join(', ')}.`);
  } else if (stats.totalBoundaries > LIMITS.maxBoundaries) {
    add(2, 'Clear boundaries', GATE_STATUS.WARN, `${stats.totalBoundaries} boundaries is above the ${LIMITS.maxBoundaries} tier budget; consider nesting.`);
  } else {
    add(2, 'Clear boundaries', GATE_STATUS.PASS, `${stats.totalBoundaries} boundaries, all nodes assigned.`);
  }

  // 3 - Visible dependencies
  if (isolatedNodes.length > 0) {
    add(3, 'Visible dependencies', GATE_STATUS.WARN, `Isolated node(s): ${isolatedNodes.join(', ')}.`);
  } else {
    add(3, 'Visible dependencies', GATE_STATUS.PASS, 'Every non-actor node participates in at least one relationship.');
  }

  // 4 - Intelligible arrows
  const edgesMissingMode = edges.filter((e) => !e.communication).map((e) => e.id || `${e.source}->${e.target}`);
  if (unlabeledEdges.length > 0 || edgesMissingMode.length > 0) {
    add(4, 'Intelligible arrows', GATE_STATUS.WARN, `${unlabeledEdges.length} edge(s) unlabeled, ${edgesMissingMode.length} missing sync/async mode.`);
  } else {
    add(4, 'Intelligible arrows', GATE_STATUS.PASS, 'Every edge declares a protocol label and a communication mode.');
  }

  // 5 - Edge routing sanity (long spans skipping tiers are the crossing generator)
  const boundaryOrder = new Map();
  [...boundaryMap.values()].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.id).localeCompare(String(b.id))).forEach((b, idx) => boundaryOrder.set(b.id, idx));
  const longSpans = edges.filter((e) => {
    const s = nodeMap.get(e.source);
    const t = nodeMap.get(e.target);
    if (!s || !t || !boundaryOrder.has(s.boundary) || !boundaryOrder.has(t.boundary)) return false;
    return Math.abs(boundaryOrder.get(t.boundary) - boundaryOrder.get(s.boundary)) > 2;
  });
  const crossing = measureEdgeCardCrossings(spec);
  if (crossing === null) {
    if (longSpans.length > Math.max(2, edges.length * 0.2)) {
      add(5, 'Clean routing', GATE_STATUS.WARN, `${longSpans.length} edge(s) skip more than two tiers, which forces long crossing curves.`);
    } else {
      add(5, 'Clean routing', GATE_STATUS.PASS, `${longSpans.length} long-span edge(s); routing stays within neighbouring tiers.`);
    }
  } else if (crossing.count > Math.max(1, crossing.total * LIMITS.maxEdgeCardCrossingRatio)) {
    add(
      5,
      'Clean routing',
      GATE_STATUS.WARN,
      `${crossing.count} of ${crossing.total} drawn edge(s) pass through a card that is not an endpoint: ${crossing.ids.slice(0, 6).join(', ')}. Re-order the boundary or split the tier.`
    );
  } else if (crossing.count > 0) {
    add(5, 'Clean routing', GATE_STATUS.PASS, `${crossing.count} of ${crossing.total} drawn edge(s) graze a non-endpoint card (${crossing.ids.join(', ')}), within tolerance.`);
  } else {
    add(5, 'Clean routing', GATE_STATUS.PASS, `No drawn edge crosses a non-endpoint card (${crossing.total} edges sampled).`);
  }

  // 6 - Readable labels
  const longLabels = [];
  nodeMap.forEach((n) => {
    if ((n.label || '').length > LIMITS.nodeLabelChars) longLabels.push(`${n.id} label`);
    if ((n.technology || '').length > LIMITS.technologyChars) longLabels.push(`${n.id} technology`);
  });
  edges.forEach((e) => {
    const label = e.label || e.packetLabel || '';
    if (label.length > LIMITS.edgeLabelChars) longLabels.push(`edge ${e.id || `${e.source}->${e.target}`}`);
  });
  if (longLabels.length > 0) {
    add(6, 'Readable labels', GATE_STATUS.WARN, `Truncated at default zoom: ${longLabels.slice(0, 5).join(', ')}${longLabels.length > 5 ? ` (+${longLabels.length - 5} more)` : ''}.`);
  } else {
    add(6, 'Readable labels', GATE_STATUS.PASS, 'All labels fit the node card at default zoom.');
  }

  // 7 - Deterministic layout (recompute and compare)
  try {
    const { computeLayout } = require('./layout.js');
    const a = JSON.stringify(computeLayout(spec));
    const b = JSON.stringify(computeLayout(spec));
    if (a === b) {
      add(7, 'Deterministic layout', GATE_STATUS.PASS, 'Two consecutive layout runs produced identical coordinates.');
    } else {
      add(7, 'Deterministic layout', GATE_STATUS.WARN, 'Layout is not reproducible across runs.');
    }
  } catch (err) {
    add(7, 'Deterministic layout', GATE_STATUS.WARN, `Layout could not be computed: ${err.message}`);
  }

  // 8 - Density
  const crowded = [...boundaryPopulation.entries()].filter(([, count]) => count > LIMITS.maxNodesPerBoundary);
  const edgeRatio = stats.totalNodes > 0 ? stats.totalEdges / stats.totalNodes : 0;
  if (crowded.length > 0) {
    add(8, 'Balanced density', GATE_STATUS.WARN, `Crowded boundaries: ${crowded.map(([id, c]) => `${id} (${c})`).join(', ')}.`);
  } else if (edgeRatio > LIMITS.maxEdgeToNodeRatio) {
    add(8, 'Balanced density', GATE_STATUS.WARN, `Edge-to-node ratio ${edgeRatio.toFixed(1)} suggests a hairball.`);
  } else {
    add(8, 'Balanced density', GATE_STATUS.PASS, `Max ${Math.max(0, ...boundaryPopulation.values())} nodes per boundary, edge ratio ${edgeRatio.toFixed(1)}.`);
  }

  // 9 - Purposeful animation
  const animated = edges.filter((e) => e.animated !== false);
  const animatedWithoutMeaning = animated.filter((e) => !e.communication && !e.pathType);
  if (animated.length === 0) {
    add(9, 'Purposeful animation', GATE_STATUS.SKIP, 'No animated edges declared.');
  } else if (animatedWithoutMeaning.length > 0) {
    add(9, 'Purposeful animation', GATE_STATUS.WARN, `${animatedWithoutMeaning.length} animated edge(s) carry neither communication mode nor pathType, so the motion says nothing.`);
  } else {
    add(9, 'Purposeful animation', GATE_STATUS.PASS, `${animated.length} animated edge(s), each typed by mode and path.`);
  }

  // 10 - Progressive disclosure
  const withoutDetail = [...nodeMap.values()].filter((n) => {
    const d = n.details || {};
    return !n.description && !d.responsibilities?.length && !d.files?.length && !d.apis?.length && !d.tables?.length;
  });
  if (withoutDetail.length > 0) {
    add(
      10,
      'Progressive disclosure',
      GATE_STATUS.WARN,
      `${withoutDetail.length} node(s) open an empty inspector: ${withoutDetail
        .slice(0, 5)
        .map((n) => n.id)
        .join(', ')}.`
    );
  } else {
    add(10, 'Progressive disclosure', GATE_STATUS.PASS, 'Every node has drill-down content in the inspector.');
  }

  // 11 - Explicit assumptions
  const unexplainedAssumptions = [...nodeMap.values()].filter((n) => (n.status === 'ASSUMED' || n.status === 'UNKNOWN') && !n.description);
  const assumptionsDeclared = Array.isArray(spec.meta?.assumptions) && spec.meta.assumptions.length > 0;
  if (unexplainedAssumptions.length > 0) {
    add(11, 'Explicit assumptions', GATE_STATUS.WARN, `ASSUMED/UNKNOWN node(s) without justification: ${unexplainedAssumptions.map((n) => n.id).join(', ')}.`);
  } else if (stats.assumedCount + stats.unknownCount > 0 && !assumptionsDeclared) {
    add(11, 'Explicit assumptions', GATE_STATUS.WARN, 'Spec contains ASSUMED/UNKNOWN nodes but meta.assumptions is empty.');
  } else {
    add(11, 'Explicit assumptions', GATE_STATUS.PASS, `${stats.assumedCount} assumed, ${stats.unknownCount} unknown, all justified.`);
  }

  // 12 - Evidence behind VERIFIED claims
  const evidenceById = new Map((evidence || []).map((entry) => [entry.id, entry]));
  const verifiedWithoutEvidence = [...nodeMap.values()].filter((n) => {
    if (n.status !== 'VERIFIED') return false;
    return !nodeHasEvidence(n, evidenceById);
  });
  if (verifiedWithoutEvidence.length > 0) {
    add(12, 'Evidence-backed claims', GATE_STATUS.WARN, `VERIFIED without any file/API/table evidence: ${verifiedWithoutEvidence.map((n) => n.id).join(', ')}.`);
  } else {
    add(12, 'Evidence-backed claims', GATE_STATUS.PASS, `${stats.verifiedCount} VERIFIED node(s) all cite evidence.`);
  }

  // 13 - Repository grounding
  if (illustrative) {
    add(13, 'Repository grounding', GATE_STATUS.SKIP, 'meta.grounding is "illustrative" — file paths are examples, disk verification skipped.');
  } else if (missingFiles.length > 0) {
    const outside = missingFiles.filter((entry) => entry.outsideRepo).length;
    const missing = missingFiles.length - outside;
    const parts = [];
    if (missing > 0) parts.push(`${missing} VERIFIED file path(s) do not exist on disk`);
    if (outside > 0) parts.push(`${outside} VERIFIED file path(s) point outside the repository root`);
    add(13, 'Repository grounding', GATE_STATUS.WARN, `${parts.join('; ')}.`);
  } else {
    add(13, 'Repository grounding', GATE_STATUS.PASS, 'Every VERIFIED file path resolves on disk under the repository root.');
  }

  // 14 - Implementation traceability
  const changeNodes = [...nodeMap.values()].filter((n) => n.delta === 'ADDED' || n.delta === 'CHANGED' || n.delta === 'REMOVED');
  const untraceable = changeNodes.filter((n) => !plannedComponents.has(n.id));
  if (changeNodes.length === 0) {
    add(14, 'Implementation traceability', GATE_STATUS.SKIP, 'No ADDED/CHANGED/REMOVED components in this model.');
  } else if (untraceable.length > 0) {
    add(14, 'Implementation traceability', GATE_STATUS.WARN, `Change without a task: ${untraceable.map((n) => n.id).join(', ')}.`);
  } else {
    add(14, 'Implementation traceability', GATE_STATUS.PASS, `All ${changeNodes.length} changed component(s) map to implementation tasks.`);
  }

  if (unmappedSteps.length > 0) {
    const g4 = gate.find((g) => g.id === 4);
    g4.status = GATE_STATUS.WARN;
    g4.detail += ` Sequence step(s) ${unmappedSteps.join(', ')} have no backing edge.`;
  }

  return gate;
}

module.exports = {
  validateArchitecture,
  normalizeArchitecture,
  runQualityGate,
  VALID_NODE_TYPES,
  VALID_STATUSES,
  VALID_DELTAS,
  VALID_COMMUNICATIONS,
  VALID_PATH_TYPES,
  GATE_STATUS,
  LIMITS,
  SCHEMA_VERSION,
  FINDING_SEVERITY,
  BUILTIN_POLICY,
  EVIDENCE_TYPE,
  EVIDENCE_VERIFICATION,
};
