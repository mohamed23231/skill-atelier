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
  state.focusMode = state.focusMode === mode ? null : mode;
  applyFocusMode();
  updateUrlState();
}

function setPresentation(enabled) {
  state.presentation = enabled;
  document.body.setAttribute('data-presentation', String(enabled));
  document.getElementById('btn-presentation').setAttribute('aria-pressed', String(enabled));
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

function updateUrlState() {
  if (restoringViewState || !viewStateReady) return;
  const params = new URLSearchParams();
  params.set('view', state.currentView);
  if (state.selectedNodeId) params.set('node', state.selectedNodeId);
  if (state.selectedEdgeId) params.set('edge', state.selectedEdgeId);
  if (state.activeFilter !== 'all') params.set('filter', state.activeFilter);
  if (state.sequenceIndex) params.set('step', String(state.sequenceIndex));
  if (state.scenarioActive && state.scenarioId) {
    params.set('scenario', state.scenarioId);
    if (state.scenarioStage) params.set('stage', String(state.scenarioStage));
  }
  if (state.focusMode) params.set('focus', state.focusMode);
  if (state.presentation) params.set('present', '1');
  params.set('z', String(Math.round(state.zoom * 1000) / 1000));
  params.set('x', String(Math.round(state.panX * 10) / 10));
  params.set('y', String(Math.round(state.panY * 10) / 10));
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${params}`);
}

function restoreUrlState() {
  restoringViewState = true;
  try {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const view = params.get('view');
    if (Object.values(VIEWS).includes(view)) switchView(view);
    const filter = params.get('filter');
    if (filter && document.querySelector(`[data-filter="${CSS.escape(filter)}"]`)) {
      state.activeFilter = filter;
      document.querySelectorAll('.filter-chip').forEach(chip => chip.classList.toggle('active', chip.dataset.filter === filter));
      applyVisibility();
    }
    const node = params.get('node');
    const edge = params.get('edge');
    if (nodeById.has(node)) openInspectorForNode(node);
    else if (edgeById.has(edge)) openInspectorForEdge(edge);
    const scenario = params.get('scenario');
    if ((ARCH_SPEC.scenarios || []).some(item => item.id === scenario)) {
      state.scenarioId = scenario;
      const scenarioStage = Number.parseInt(params.get('stage'), 10);
      state.scenarioStage = Number.isInteger(scenarioStage) && scenarioStage >= 0 ? scenarioStage : 0;
      state.scenarioActive = true;
      renderScenarioNavigator();
    }
    const focus = params.get('focus');
    if (Object.values(FOCUS_MODES).includes(focus)) {
      state.focusMode = focus;
      applyFocusMode();
    }
    const step = Number.parseInt(params.get('step'), 10);
    if (Number.isInteger(step) && step >= 0) goToSequenceStep(step);
    if (params.get('present') === '1') setPresentation(true);
    // Number(null) is 0, so a missing parameter must stay NaN rather than read as "pan to the origin".
    const numberParam = name => (params.has(name) ? Number(params.get(name)) : NaN);
    const zoom = numberParam('z');
    const panX = numberParam('x');
    const panY = numberParam('y');
    if (Number.isFinite(zoom) && zoom >= 0.15 && zoom <= 4) state.zoom = zoom;
    if (Number.isFinite(panX)) state.panX = panX;
    if (Number.isFinite(panY)) state.panY = panY;
    if (Number.isFinite(zoom) || Number.isFinite(panX) || Number.isFinite(panY)) {
      state.userMovedView = true;
      updateTransform();
    }
  } catch (error) {
    return;
  } finally {
    restoringViewState = false;
  }
}

function announceStatus(message) {
  const target = document.getElementById('workbench-status');
  target.textContent = '';
  window.requestAnimationFrame(() => { target.textContent = message; });
}
