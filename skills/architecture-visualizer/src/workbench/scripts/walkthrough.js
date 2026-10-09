// Pure, DOM-free core of the scenario walkthrough. It turns a scenario plus the reader's branch
// choices into one linear path of steps, decisions and ends, and says what each entry puts in focus.
// Nothing here touches the document, so the same functions run under Node in the tests.

// A stage's hops are its interactions; a parallel stage may instead carry them on nested stages.
function walkInteractions(stage) {
  if (!stage || typeof stage !== 'object') return [];
  if (Array.isArray(stage.interactions)) return stage.interactions;
  if (Array.isArray(stage.stages)) {
    return stage.stages.reduce((hops, child) => hops.concat(walkInteractions(child)), []);
  }
  if (Array.isArray(stage.branches)) {
    return stage.branches.reduce((hops, branch) => hops.concat(walkInteractions(branch)), []);
  }
  return [];
}

function walkBranches(stage) {
  return stage && Array.isArray(stage.branches) ? stage.branches : [];
}

// The branch a decision starts on when the reader has not picked: the one flagged default, else the first.
function defaultBranchIndex(branchStage) {
  const branches = walkBranches(branchStage);
  const flagged = branches.findIndex((branch) => branch && branch.default === true);
  return flagged === -1 ? 0 : flagged;
}

// A choice is honoured only when it is an existing branch index; anything else falls back to the default.
function walkChosenIndex(stage, choices) {
  const branches = walkBranches(stage);
  const requested = choices && typeof choices === 'object' ? choices[stage.id] : undefined;
  if (Number.isInteger(requested) && requested >= 0 && requested < branches.length) return requested;
  return defaultBranchIndex(stage);
}

function walkStages(stages, choices, entries, counter) {
  (Array.isArray(stages) ? stages : []).forEach((stage) => {
    if (!stage || typeof stage !== 'object') return;
    if (stage.kind === 'branch') {
      walkBranch(stage, choices, entries, counter);
      return;
    }
    entries.push({
      kind: 'step',
      id: stage.id,
      stage,
      number: counter.next,
      interactions: walkInteractions(stage),
      parallel: stage.kind === 'parallel',
    });
    counter.next += 1;
  });
}

function walkStageIds(scenario) {
  const ids = new Set();
  const visit = stages => (Array.isArray(stages) ? stages : []).forEach(stage => {
    if (!stage || typeof stage !== 'object') return;
    ids.add(stage.id);
    visit(stage.stages);
    walkBranches(stage).forEach(branch => visit(branch.stages));
  });
  visit(scenario?.stages);
  return ids;
}

function walkEndId(decisionId, counter) {
  let id = `end:${decisionId}`;
  while (counter.ids?.has(id)) id = `end:${id}`;
  counter.ids?.add(id);
  return id;
}

// Expand every decision, including nested and later decisions, for component participation.
function walkScenarioPaths(scenario) {
  const paths = [];
  const expand = choices => {
    const entries = linearizeScenario(scenario, choices);
    const decision = entries.find(entry => entry.kind === 'decision' && !Object.hasOwn(choices, entry.id));
    if (!decision) { paths.push({ choices, entries }); return; }
    if (!decision.branches.length) { expand({ ...choices, [decision.id]: 0 }); return; }
    decision.branches.forEach((branch, index) => expand({ ...choices, [decision.id]: index }));
  };
  expand({});
  return paths;
}

function walkBranch(stage, choices, entries, counter) {
  const branches = walkBranches(stage);
  const chosen = walkChosenIndex(stage, choices);
  entries.push({ kind: 'decision', id: stage.id, stage, branches, chosen });
  const branch = branches[chosen];
  walkStages(branch && branch.stages, choices, entries, counter);
  if (!branch || !Array.isArray(branch.stages) || branch.stages.length === 0) {
    entries.push({ kind: 'end', id: walkEndId(stage.id, counter), decisionId: stage.id, branch });
  }
}

function linearizeScenario(scenario, choices) {
  const entries = [];
  const counter = { next: 1, ids: walkStageIds(scenario) };
  if (scenario && typeof scenario === 'object') walkStages(scenario.stages, choices, entries, counter);
  return entries;
}

function walkthroughTotal(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => entry && entry.kind === 'step').length;
}

// Stable de-duplication for the focus lists.
function walkPushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

// A hop names its edge, or one is found by matching endpoints; the reverse direction also counts.
function walkEdgeId(hop, edges) {
  if (hop && hop.edgeId) return hop.edgeId;
  if (!hop) return null;
  const list = Array.isArray(edges) ? edges : [];
  const directed = list.find((edge) => edge && edge.source === hop.from && edge.target === hop.to);
  if (directed && directed.id) return directed.id;
  const reverse = list.find((edge) => edge && edge.source === hop.to && edge.target === hop.from);
  return reverse && reverse.id ? reverse.id : null;
}

function walkFocusStep(entry, edges) {
  const primaryNodes = [];
  const primaryEdges = [];
  const ghosts = [];
  const seenGhosts = [];
  const hops = Array.isArray(entry.interactions) ? entry.interactions : [];
  hops.forEach((hop) => {
    if (!hop || typeof hop !== 'object') return;
    walkPushUnique(primaryNodes, hop.from);
    walkPushUnique(primaryNodes, hop.to);
    const edgeId = walkEdgeId(hop, edges);
    if (edgeId) {
      walkPushUnique(primaryEdges, edgeId);
      return;
    }
    const key = `${hop.from}->${hop.to}`;
    if (!seenGhosts.includes(key)) {
      seenGhosts.push(key);
      ghosts.push({ from: hop.from, to: hop.to });
    }
  });
  const markers = entry.parallel
    ? hops.map((hop, index) => ({
      edgeId: walkEdgeId(hop, edges),
      from: hop ? hop.from : undefined,
      to: hop ? hop.to : undefined,
      n: index + 1,
    }))
    : [];
  return { primaryNodes, primaryEdges, ghosts, markers };
}

// A decision centres on its decider, or on where the path arrived when none is named.
function walkDecisionNodes(entries, index) {
  const stage = entries[index] && entries[index].stage;
  if (stage && stage.decidedBy) return [stage.decidedBy];
  for (let i = index - 1; i >= 0; i -= 1) {
    const previous = entries[i];
    if (!previous || previous.kind !== 'step') continue;
    const hops = Array.isArray(previous.interactions) ? previous.interactions : [];
    const last = hops[hops.length - 1];
    return last && last.to ? [last.to] : [];
  }
  return [];
}

function walkEndNodes(entries, index) {
  const decisionId = entries[index] && entries[index].decisionId;
  const decisionIndex = entries.findIndex((entry) => entry && entry.kind === 'decision' && entry.id === decisionId);
  return decisionIndex === -1 ? [] : walkDecisionNodes(entries, decisionIndex);
}

function focusOfEntry(entries, index, edges) {
  const list = Array.isArray(entries) ? entries : [];
  const entry = list[index];
  if (!entry || typeof entry !== 'object') {
    return { primaryNodes: [], primaryEdges: [], ghosts: [], markers: [] };
  }
  if (entry.kind === 'step') return walkFocusStep(entry, edges);
  if (entry.kind === 'decision') {
    return { primaryNodes: walkDecisionNodes(list, index), primaryEdges: [], ghosts: [], markers: [] };
  }
  if (entry.kind === 'end') {
    return { primaryNodes: walkEndNodes(list, index), primaryEdges: [], ghosts: [], markers: [] };
  }
  return { primaryNodes: [], primaryEdges: [], ghosts: [], markers: [] };
}
