const PANEL_BREAKPOINT = 900;
let panelReflowTimer = null;

// From the breakpoint up the rail docks beside the canvas and can be closed. Below it the page
// stacks: canvas and track first, then the rail as a section of the page that is always open.
function isStackedLayout() {
  return window.innerWidth < PANEL_BREAKPOINT;
}

function refreshViewportForPanelChange() {
  window.clearTimeout(panelReflowTimer);
  panelReflowTimer = window.setTimeout(() => {
    updateMinimapViewport();
  }, 220);
}

function setDrawerOpen(kind, open) {
  const region = document.querySelector(`[data-region="${kind}"]`);
  if (!region) return;
  const stacked = isStackedLayout();
  const wasOpen = region.getAttribute('data-open') === 'true';
  const next = stacked || open;
  region.setAttribute('data-open', next ? 'true' : 'false');
  // A stacked rail opened by the reader (a card, a trust pill) scrolls into view; a link restoring
  // a selection on load leaves the page at the top.
  if (stacked && open && viewStateReady) {
    region.scrollIntoView({ block: 'start', behavior: state.prefersReducedMotion ? 'auto' : 'smooth' });
  }
  if (wasOpen !== next) refreshViewportForPanelChange();
}

function toggleDrawer(kind) {
  const region = document.querySelector(`[data-region="${kind}"]`);
  if (!region) return;
  setDrawerOpen(kind, region.getAttribute('data-open') !== 'true');
}

function selectionNeighbourhood(nodeId) {
  const nodes = new Set([nodeId]);
  const edges = new Set();
  (LAYOUT_DATA.edges || []).forEach(edge => {
    if (edge.source !== nodeId && edge.target !== nodeId) return;
    nodes.add(edge.source);
    nodes.add(edge.target);
    edges.add(edge.id);
  });
  return { nodes, edges };
}

// A selected component and its neighbours stay at full strength, its connections darken, the rest
// recedes. A running walkthrough keeps its own spotlight.
function applySelectionSpotlight(nodeId, neighbourhood) {
  const walking = typeof walkIsActive === 'function' && walkIsActive();
  const active = walking ? null : neighbourhood || (nodeId ? selectionNeighbourhood(nodeId) : null);
  document.querySelectorAll('.node-group').forEach(group => {
    group.classList.toggle('context-dim', Boolean(active) && !active.nodes.has(group.id.replace('node-', '')));
  });
  document.querySelectorAll('.edge-group').forEach(group => {
    const id = group.id.replace('edge-', '');
    group.classList.toggle('context-dim', Boolean(active) && !active.edges.has(id));
    group.classList.toggle('context-focus', Boolean(active) && active.edges.has(id));
  });
}

// Hovering a card darkens its connections, as a preview of selecting it. A selection or a
// walkthrough already holds the spotlight, so hover then does nothing.
let hoverNodeId = null;
function setHoverFocus(nodeId) {
  if (hoverNodeId === nodeId) return;
  hoverNodeId = nodeId;
  const busy = (typeof walkIsActive === 'function' && walkIsActive()) || !document.getElementById('component-sheet')?.hidden;
  document.querySelectorAll('.edge-group').forEach(group => {
    const edge = edgeById.get(group.id.replace('edge-', ''));
    group.classList.toggle('hover-focus', Boolean(nodeId) && !busy && Boolean(edge) && (edge.source === nodeId || edge.target === nodeId));
  });
}

function focusModelPoint(x, y) {
  const safe = canvasSafeArea();
  const zoom = clampZoom(Math.max(state.zoom * 1.08, 0.85));
  actions.setCamera({
    zoom,
    panX: safe.left + safe.width / 2 - x * zoom,
    panY: safe.top + safe.height / 2 - y * zoom,
    userMoved: true
  });
  updateTransform();
}

// Choosing a component or connection on the canvas leaves a running walkthrough, as in the
// prototype: the reader has moved on to something else.
function leaveWalkthroughForSelection() {
  if (typeof walkIsActive === 'function' && walkIsActive() && !restoringViewState) endWalkthrough();
}

function openInspectorForNode(nodeId) {
  leaveWalkthroughForSelection();
  showNodeInspector();
  actions.selectEdge(null);
  document.querySelectorAll('[data-selected="true"]').forEach(item => item.removeAttribute('data-selected'));
  selectNode(nodeId);
  const node = nodeById.get(nodeId);
  const nodeElement = document.getElementById(`node-${nodeId}`);
  if (nodeElement) nodeElement.setAttribute('data-selected', 'true');
  document.getElementById('node-inspector-body').dataset.kind = 'node';
  showSheet('node');
  // Like a walkthrough step: the component and its neighbours in view, everything else quiet.
  const near = selectionNeighbourhood(nodeId);
  if (node) frameModelNodes([...near.nodes], [...near.edges]);
  applySelectionSpotlight(nodeId);
  applyFocusMode();
  updateUrlState();
}

function openInspectorForEdge(edgeId) {
  leaveWalkthroughForSelection();
  showNodeInspector();
  const edge = edgeById.get(edgeId);
  if (!edge) return;
  actions.selectEdge(edgeId);
  document.querySelectorAll('[data-selected="true"]').forEach(item => item.removeAttribute('data-selected'));
  document.querySelectorAll('.node-group').forEach(item => item.classList.remove('selected'));
  const path = document.getElementById(`path-${edgeId}`);
  if (path) path.setAttribute('data-selected', 'true');
  actions.selectNode(null);
  document.getElementById('node-inspector-body').dataset.kind = 'edge';
  // A connection frames both of its ends, with the connection itself in focus.
  const ends = { nodes: new Set([edge.source, edge.target]), edges: new Set([edgeId]) };
  applySelectionSpotlight(null, ends);
  showSheet('edge');
  document.getElementById('ins-title').textContent = edge.label || edge.packetLabel || edge.id;
  document.getElementById('ins-tech').textContent = `${edge.communication || 'sync'} relationship`;
  document.getElementById('ins-description').textContent = `${nodeById.get(edge.source)?.label || edge.source} to ${nodeById.get(edge.target)?.label || edge.target}`;
  frameModelNodes([...ends.nodes], [edgeId]);
  applyFocusMode();
  updateUrlState();
}
