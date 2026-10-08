// Pan and Zoom engine
function updateTransform() {
  viewport.setAttribute('transform', `matrix(${state.zoom} 0 0 ${state.zoom} ${state.panX} ${state.panY})`);
  updateMinimapViewport();
  scheduleUrlState();
}

function clampZoom(value) {
  return Math.min(Math.max(value, 0.15), 4.0);
}

function zoomAround(newZoom, cx, cy) {
  const clamped = clampZoom(newZoom);
  const panX = cx - (cx - state.panX) * (clamped / state.zoom);
  const panY = cy - (cy - state.panY) * (clamped / state.zoom);
  actions.setCamera({ zoom: clamped, panX, panY, userMoved: true });
  updateTransform();
}

function handleWheel(e) {
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  zoomAround(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX - rect.left, e.clientY - rect.top);
}

function zoomBy(factor) {
  const rect = svg.getBoundingClientRect();
  zoomAround(state.zoom * factor, rect.width / 2, rect.height / 2);
}

// A press becomes a pan or a drag only after it travels this far; a click with a hand's natural
// jitter stays a click, so selecting and deselecting work.
const DRAG_THRESHOLD = 4;
let pressPoint = null;
function rememberPress(e) {
  pressPoint = { x: e.clientX, y: e.clientY };
}

function handleMouseDown(e) {
  if (e.button === 0) rememberPress(e);
  if (e.button === 0 && !state.draggingNodeId && !state.draggingBoundaryId) {
    state.isDraggingCanvas = true;
    state.dragMoved = false;
    state.dragStartX = e.clientX - state.panX;
    state.dragStartY = e.clientY - state.panY;
    container.classList.add('grabbing');
  }
}

function handleMouseMove(e) {
  const pressing = state.isDraggingCanvas || state.draggingNodeId || state.draggingBoundaryId;
  if (pressing && !state.dragMoved && pressPoint && Math.hypot(e.clientX - pressPoint.x, e.clientY - pressPoint.y) < DRAG_THRESHOLD) return;
  if (state.isDraggingCanvas) {
    actions.setCamera({
      panX: e.clientX - state.dragStartX,
      panY: e.clientY - state.dragStartY,
      userMoved: true
    });
    state.dragMoved = true;
    updateTransform();
  } else if (state.draggingNodeId) {
    moveDraggedNode(e.clientX, e.clientY);
  } else if (state.draggingBoundaryId) {
    moveDraggedBoundary(e.clientX, e.clientY);
  }
}

function handleMouseUp() {
  if (state.dragMoved) {
    resolveLabelCollisions(LAYOUT_DATA.edges || [], LAYOUT_DATA.nodes || [], LAYOUT_DATA.boundaryHeaderBoxes || []);
    const totalBounds = computeTotalVisualBounds();
    LAYOUT_DATA.totalVisualBounds = totalBounds;
    LAYOUT_DATA.dimensions = {
      ...totalBounds,
      canvasWidth: totalBounds.width + 48,
      canvasHeight: totalBounds.height + 48,
    };
    renderMinimap();
  }
  if (state.dragMoved && (state.draggingNodeId || state.draggingBoundaryId)) persistLayoutOverrides();
  state.isDraggingCanvas = false;
  state.draggingNodeId = null;
  state.draggingBoundaryId = null;
  state.boundaryInitialNodes = null;
  container.classList.remove('grabbing');
  pressPoint = null;
  window.setTimeout(() => { state.dragMoved = false; }, 0);
}

// One finger pans once it travels past the threshold (so a tap still selects); two fingers pinch-zoom
// around their midpoint.
let pinch = null;
function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function handleTouchStart(e) {
  if (e.touches.length === 2) {
    state.isDraggingCanvas = false;
    pinch = { distance: touchDistance(e.touches), zoom: state.zoom };
    return;
  }
  if (e.touches.length !== 1) return;
  const touch = e.touches[0];
  pinch = null;
  rememberPress(touch);
  state.isDraggingCanvas = true;
  state.dragMoved = false;
  state.dragStartX = touch.clientX - state.panX;
  state.dragStartY = touch.clientY - state.panY;
}

function handleTouchMove(e) {
  if (pinch && e.touches.length === 2) {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    zoomAround(pinch.zoom * touchDistance(e.touches) / Math.max(1, pinch.distance), midX, midY);
    state.dragMoved = true;
    return;
  }
  if (!state.isDraggingCanvas || e.touches.length !== 1) return;
  const touch = e.touches[0];
  if (!state.dragMoved && pressPoint && Math.hypot(touch.clientX - pressPoint.x, touch.clientY - pressPoint.y) < DRAG_THRESHOLD * 2) return;
  e.preventDefault();
  state.dragMoved = true;
  actions.setCamera({
    panX: touch.clientX - state.dragStartX,
    panY: touch.clientY - state.dragStartY,
    userMoved: true
  });
  updateTransform();
}

function handleTouchEnd(e) {
  if (e && e.touches && e.touches.length > 0) return;
  state.isDraggingCanvas = false;
  pinch = null;
  pressPoint = null;
  window.setTimeout(() => { state.dragMoved = false; }, 0);
}
