const PANEL_BREAKPOINT = 1100;
let activeDrawer = null;
let drawerReturnFocus = null;
let panelReflowTimer = null;

function isOverlayPanels() {
  return window.innerWidth < PANEL_BREAKPOINT;
}

function refreshViewportForPanelChange() {
  window.clearTimeout(panelReflowTimer);
  panelReflowTimer = window.setTimeout(() => {
    updateMinimapViewport();
  }, 220);
}

function drawerTabbables(region) {
  return Array.from(region.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')).filter(item => {
    if (item.disabled || item.getAttribute('aria-hidden') === 'true') return false;
    const tabindex = item.getAttribute('tabindex');
    return tabindex === null || Number(tabindex) >= 0;
  });
}

function setDrawerOpen(kind, open, opener) {
  const region = document.querySelector(`[data-region="${kind}"]`);
  if (!region) return;
  const overlay = isOverlayPanels();
  const wasOpen = region.getAttribute('data-open') === 'true';
  if (open && overlay) {
    activeDrawer = kind;
    drawerReturnFocus = opener || document.activeElement;
  }
  region.setAttribute('data-open', open ? 'true' : 'false');
  region.setAttribute('aria-modal', overlay && open ? 'true' : 'false');
  if (open && overlay) {
    window.requestAnimationFrame(() => drawerTabbables(region)[0]?.focus());
  }
  if (!open && activeDrawer === kind) {
    const target = drawerReturnFocus;
    activeDrawer = null;
    drawerReturnFocus = null;
    if (overlay) {
      target?.focus();
      window.requestAnimationFrame(() => target?.focus());
    }
  }
  if (wasOpen !== open) refreshViewportForPanelChange();
}

function toggleDrawer(kind, opener) {
  const region = document.querySelector(`[data-region="${kind}"]`);
  if (!region) return;
  setDrawerOpen(kind, region.getAttribute('data-open') !== 'true', opener);
}

function closeActiveDrawer() {
  if (activeDrawer) setDrawerOpen(activeDrawer, false);
}

function trapDrawerFocus(event) {
  if (event.key !== 'Tab' || !isOverlayPanels() || !activeDrawer) return;
  const region = document.querySelector(`[data-region="${activeDrawer}"]`);
  const items = drawerTabbables(region);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function focusModelPoint(x, y) {
  const rect = svg.getBoundingClientRect();
  const zoom = clampZoom(Math.max(state.zoom * 1.08, 0.85));
  actions.setCamera({
    zoom,
    panX: rect.width / 2 - x * zoom,
    panY: rect.height / 2 - y * zoom,
    userMoved: true
  });
  updateTransform();
}

function openInspectorForNode(nodeId) {
  showNodeInspector();
  actions.selectEdge(null);
  document.querySelectorAll('[data-selected="true"]').forEach(item => item.removeAttribute('data-selected'));
  selectNode(nodeId);
  const node = nodeById.get(nodeId);
  const nodeElement = document.getElementById(`node-${nodeId}`);
  if (nodeElement) nodeElement.setAttribute('data-selected', 'true');
  showSheet('node');
  if (node) focusModelPoint(node.x + node.width / 2, node.y + node.height / 2);
  applyFocusMode();
  updateUrlState();
}

function openInspectorForEdge(edgeId) {
  showNodeInspector();
  const edge = edgeById.get(edgeId);
  if (!edge) return;
  actions.selectEdge(edgeId);
  document.querySelectorAll('[data-selected="true"]').forEach(item => item.removeAttribute('data-selected'));
  document.querySelectorAll('.node-group').forEach(item => item.classList.remove('selected'));
  const path = document.getElementById(`path-${edgeId}`);
  if (path) path.setAttribute('data-selected', 'true');
  actions.selectNode(null);
  showSheet('edge');
  document.getElementById('ins-title').textContent = edge.label || edge.packetLabel || edge.id;
  document.getElementById('ins-tech').textContent = `${edge.communication || 'sync'} relationship`;
  document.getElementById('ins-description').textContent = `${nodeById.get(edge.source)?.label || edge.source} to ${nodeById.get(edge.target)?.label || edge.target}`;
  const x = edge.labelAnchor?.x ?? edge.labelX ?? ((edge.points?.x1 || 0) + (edge.points?.x2 || 0)) / 2;
  const y = edge.labelAnchor?.y ?? edge.labelY ?? ((edge.points?.y1 || 0) + (edge.points?.y2 || 0)) / 2;
  focusModelPoint(x, y);
  applyFocusMode();
  updateUrlState();
}
