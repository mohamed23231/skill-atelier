// Lens selection is independent of the Data Flow and Sequence canvas views.
function selectLens(lens, { explicit = true } = {}) {
  if (!LENSES.includes(lens)) return;
  actions.setLens(lens, explicit);
  document.querySelectorAll('.lens-switcher [data-lens]').forEach(button => {
    const selected = button.dataset.lens === lens;
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  const select = document.querySelector('.lens-select');
  if (select) select.value = lens;
  document.body.dataset.lens = lens;
  const scenarioActive = state.scenarioActive;
  if (lens === 'change') switchView(VIEWS.BEFORE_AFTER);
  else if (state.currentView === VIEWS.BEFORE_AFTER) switchView(VIEWS.ARCHITECTURE);
  if (scenarioActive && state.walkCursor) walkTo(state.walkCursor);
  applyLens();
  announceStatus(`${lens.charAt(0).toUpperCase() + lens.slice(1)} lens`);
  updateUrlState();
}

const FOCUS_MODES = { NEIGHBORS: 'neighbors', AFFECTED: 'affected' };
let restoringViewState = false;
// Until init has read the incoming hash, nothing may write one: an early write would replace a shared
// deep link (and the fitted camera) with the half-initialised default state.
let viewStateReady = false;
let urlStateTimer = null;

function modelIdentity() {
  return String(ARCH_SPEC.meta?.id || ARCH_SPEC.meta?.title || 'architecture').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function layoutStorageKey() {
  return `arch-viz-layout:${modelIdentity()}`;
}

function persistLayoutOverrides() {
  try {
    const layout = {
      nodes: Object.fromEntries((LAYOUT_DATA.nodes || []).map(node => [node.id, { x: node.x, y: node.y }])),
      boundaries: Object.fromEntries((LAYOUT_DATA.boundaries || []).map(boundary => [boundary.id, { x: boundary.x, y: boundary.y }]))
    };
    window.localStorage.setItem(layoutStorageKey(), JSON.stringify(layout));
  } catch (error) {
    return;
  }
}

function restorePersistedLayout() {
  try {
    const raw = window.localStorage.getItem(layoutStorageKey());
    if (!raw) return;
    const saved = JSON.parse(raw);
    (LAYOUT_DATA.nodes || []).forEach(node => {
      const point = saved?.nodes?.[node.id];
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
        node.x = point.x;
        node.y = point.y;
      }
    });
    (LAYOUT_DATA.boundaries || []).forEach(boundary => {
      const point = saved?.boundaries?.[boundary.id];
      if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
        boundary.x = point.x;
        boundary.y = point.y;
      }
    });
    recomputeAllEdges();
  } catch (error) {
    return;
  }
}

function focusMembers(mode) {
  if (!state.selectedNodeId || !nodeById.has(state.selectedNodeId)) return new Set();
  const members = new Set([state.selectedNodeId]);
  if (mode === FOCUS_MODES.NEIGHBORS) {
    (LAYOUT_DATA.edges || []).forEach(edge => {
      if (edge.source === state.selectedNodeId || edge.target === state.selectedNodeId) {
        members.add(edge.source);
        members.add(edge.target);
      }
    });
    return members;
  }
  const queue = [state.selectedNodeId];
  while (queue.length) {
    const source = queue.shift();
    (LAYOUT_DATA.edges || []).forEach(edge => {
      if (edge.source === source && !members.has(edge.target)) {
        members.add(edge.target);
        queue.push(edge.target);
      }
    });
  }
  return members;
}

function applyFocusMode() {
  const members = state.focusMode ? focusMembers(state.focusMode) : null;
  document.body.toggleAttribute('data-focus-mode', Boolean(state.focusMode));
  if (state.focusMode) document.body.setAttribute('data-focus-mode', state.focusMode);
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const item = document.getElementById(`node-${node.id}`);
    if (item) item.setAttribute('data-focus-member', members ? String(members.has(node.id)) : 'true');
  });
  (LAYOUT_DATA.edges || []).forEach(edge => {
    const item = document.getElementById(`path-${edge.id}`);
    if (item) item.setAttribute('data-focus-member', members ? String(members.has(edge.source) && members.has(edge.target)) : 'true');
  });
  const neighbors = document.getElementById('btn-focus-neighbors');
  const affected = document.getElementById('btn-focus-affected');
  neighbors.setAttribute('aria-pressed', String(state.focusMode === FOCUS_MODES.NEIGHBORS));
  affected.setAttribute('aria-pressed', String(state.focusMode === FOCUS_MODES.AFFECTED));
}

function setFocusMode(mode) {
  actions.setFocusMode(state.focusMode === mode ? null : mode);
  applyFocusMode();
  updateUrlState();
}

function setPresentation(enabled) {
  actions.setPresentation(enabled);
  document.body.setAttribute('data-presentation', String(enabled));
  window.requestAnimationFrame(() => {
    if (!state.userMovedView) fitToScreen();
    else updateTransform();
  });
  updateUrlState();
}

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen?.();
    return;
  }
  const request = document.documentElement.requestFullscreen?.();
  if (request?.catch) request.catch(() => document.body.setAttribute('data-fullscreen', 'true'));
  else document.body.setAttribute('data-fullscreen', 'true');
}

function scheduleUrlState() {
  if (restoringViewState || !viewStateReady) return;
  window.clearTimeout(urlStateTimer);
  urlStateTimer = window.setTimeout(updateUrlState, 60);
}

function canvasSize() {
  const rect = svg.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

function canvasCameraWorld() {
  const safe = canvasSafeArea();
  return cameraToWorld({ ...state, panX: state.panX - safe.left, panY: state.panY - safe.top }, safe);
}

// A linked camera is a world region, so it is re-framed whenever the canvas changes size (the window
// settling after load, a panel docking) until the reader moves the camera themselves.
let linkedCamera = null;

function applyLinkedCamera() {
  const size = canvasSafeArea();
  const { x, y } = linkedCamera.world;
  // Keep the linked centre; a zoom past the limits on this screen is clamped around it.
  const zoom = clampZoom(worldToCamera(linkedCamera.world, size).zoom);
  actions.setCamera({ zoom, panX: size.left + size.width / 2 - x * zoom, panY: size.top + size.height / 2 - y * zoom, userMoved: true });
  linkedCamera.applied = { zoom: state.zoom, panX: state.panX, panY: state.panY };
  updateTransform();
}

function holdsLinkedCamera() {
  return Boolean(linkedCamera?.applied) && ['zoom', 'panX', 'panY'].every(key => state[key] === linkedCamera.applied[key]);
}

// The share link is version 2 and names things by stable id. The camera is written in world space,
// so a link frames the same region on any screen, and only once the reader has moved it: an untouched
// view refits wherever it opens. A link to a scenario stage carries no camera for the same reason.
function viewSnapshot() {
  const snapshot = {
    chapter: state.chapter,
    lens: state.lens,
    view: state.currentView,
    node: state.selectedNodeId,
    edge: state.selectedEdgeId,
    filter: state.activeFilter !== 'all' ? state.activeFilter : null,
    focus: state.focusMode,
    present: state.presentation
  };
  if (state.sequenceIndex) {
    const step = sequenceSteps()[state.sequenceIndex];
    snapshot.step = Number.isInteger(step?.step) ? step.step : state.sequenceIndex + 1;
  }
  if (state.scenarioActive && state.scenarioId) {
    snapshot.scenario = state.scenarioId;
    if (state.walkCursor) snapshot.stage = state.walkCursor;
    const outcomes = {};
    linearizeScenario(selectedScenario(), state.walkChoices).forEach((entry) => {
      if (entry && entry.kind === 'decision' && entry.chosen !== defaultBranchIndex(entry.stage)) {
        outcomes[entry.id] = entry.chosen;
      }
    });
    if (Object.keys(outcomes).length) snapshot.outcomes = outcomes;
  }
  if (state.userMovedView && !snapshot.scenario) snapshot.camera = canvasCameraWorld();
  return snapshot;
}

function updateUrlState() {
  if (restoringViewState || !viewStateReady) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${encodeViewHash(viewSnapshot())}`);
}

// Sequence steps are linked by their authored number; a model without numbers falls back to position.
function sequenceIndexForStep(number) {
  const steps = sequenceSteps();
  if (!steps.some(step => Number.isInteger(step.step))) return number >= 1 && number <= steps.length ? number - 1 : -1;
  return steps.findIndex(step => step.step === number);
}

// Reads version 1 and version 2 links. Anything the model no longer has is dropped, and the returned
// notices say what was dropped, one sentence each.
function restoreUrlState() {
  restoringViewState = true;
  const notices = [];
  linkedCamera = null;
  try {
    const link = parseViewHash(window.location.hash);
    if (link.unsupported) {
      notices.push(`This link uses a newer format (version ${link.version}); showing the default view.`);
      return notices;
    }
    if (link.chapter !== undefined) {
      const available = typeof availableChapters === 'function' ? availableChapters().map(c => c.id) : ['overview', 'walkthrough', 'changes', 'review', 'evidence', 'data', 'plan'];
      if (available.includes(link.chapter)) {
        openChapter(link.chapter);
      } else {
        notices.push(`Chapter ${link.chapter} does not exist; showing the overview.`);
        openChapter('overview');
      }
    }
    if (link.view !== undefined) {
      if (link.view === 'database_er') {
        openChapter('data');
        switchView('architecture');
      } else if (link.view === 'implementation_plan') {
        openChapter('plan');
        switchView('architecture');
      } else if (link.view === VIEWS.BEFORE_AFTER || link.view === VIEWS.ARCHITECTURE) {
        selectLens(link.view === VIEWS.BEFORE_AFTER ? 'change' : 'structure', { explicit: true });
      } else if (Object.values(VIEWS).includes(link.view)) {
        switchView(link.view);
      } else {
        notices.push(`View ${link.view} does not exist; showing the architecture.`);
      }
    }
    if (link.lens !== undefined) {
      if (LENSES.includes(link.lens)) selectLens(link.lens, { explicit: true });
      else notices.push(`Lens ${link.lens} does not exist; keeping the suggested lens.`);
    }
    if (link.filter !== undefined) {
      if (LAYER_FILTERS.includes(link.filter)) {
        actions.setFilter(link.filter);
        applyVisibility();
      } else {
        notices.push(`Filter ${link.filter} does not exist; showing everything.`);
      }
    }
    if (nodeById.has(link.node)) openInspectorForNode(link.node);
    else if (edgeById.has(link.edge)) openInspectorForEdge(link.edge);
    else if (link.node !== undefined) notices.push(`Component ${link.node} no longer exists.`);
    else if (link.edge !== undefined) notices.push(`Connection ${link.edge} no longer exists.`);
    if (link.scenario !== undefined) {
      const scenario = (ARCH_SPEC.scenarios || []).find(item => item.id === link.scenario);
      if (!scenario) {
        notices.push(`Scenario ${link.scenario} no longer exists.`);
      } else {
        const choices = link.outcomes && typeof link.outcomes === 'object' ? { ...link.outcomes } : {};
        actions.setScenario(scenario.id);
        actions.setWalkChoices(choices);
        const entries = linearizeScenario(scenario, choices);
        let entryId = entries.length ? entries[0].id : null;
        if (link.stage !== undefined) {
          const exact = entries.find(entry => entry.id === link.stage);
          if (exact) {
            entryId = exact.id;
          } else {
            notices.push(`Step ${link.stage} no longer exists; showing the walkthrough start.`);
          }
        } else if (link.stageIndex !== undefined) {
          const flatStage = flattenScenarioStages(scenario.stages)[link.stageIndex];
          const mapped = flatStage ? entries.find(entry => entry.id === flatStage.id) : null;
          if (mapped) entryId = mapped.id;
        }
        if (entryId) walkTo(entryId);
      }
    }
    if (link.focus !== undefined) {
      if (Object.values(FOCUS_MODES).includes(link.focus)) {
        actions.setFocusMode(link.focus);
        applyFocusMode();
      } else {
        notices.push(`Focus ${link.focus} does not exist.`);
      }
    }
    if (link.stepIndex !== undefined) goToSequenceStep(link.stepIndex);
    if (link.step !== undefined) {
      const index = sequenceIndexForStep(link.step);
      if (index >= 0) goToSequenceStep(index);
      else notices.push(`Sequence step ${link.step} no longer exists.`);
    }
    if (link.present) setPresentation(true);
    if (link.screenCamera) {
      const { zoom, panX, panY } = link.screenCamera;
      if (Number.isFinite(zoom) && zoom >= 0.15 && zoom <= 4) actions.setCamera({ zoom });
      if (Number.isFinite(panX)) actions.setCamera({ panX });
      if (Number.isFinite(panY)) actions.setCamera({ panY });
      actions.setCamera({ userMoved: true });
      updateTransform();
    }
    if (link.camera) {
      linkedCamera = { world: link.camera };
      applyLinkedCamera();
    }
  } catch (error) {
    return notices;
  } finally {
    restoringViewState = false;
  }
  return notices;
}

function announceStatus(message) {
  const target = document.getElementById('workbench-status');
  target.textContent = '';
  window.requestAnimationFrame(() => { target.textContent = message; });
}
