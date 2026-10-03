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
  state.userMovedView = true;
  const clamped = clampZoom(newZoom);
  state.panX = cx - (cx - state.panX) * (clamped / state.zoom);
  state.panY = cy - (cy - state.panY) * (clamped / state.zoom);
  state.zoom = clamped;
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

function handleMouseDown(e) {
  if (e.button === 0 && !state.draggingNodeId && !state.draggingBoundaryId) {
    state.isDraggingCanvas = true;
    state.dragMoved = false;
    state.dragStartX = e.clientX - state.panX;
    state.dragStartY = e.clientY - state.panY;
    container.classList.add('grabbing');
  }
}

function handleMouseMove(e) {
  if (state.isDraggingCanvas) {
    state.panX = e.clientX - state.dragStartX;
    state.panY = e.clientY - state.dragStartY;
    state.dragMoved = true;
    state.userMovedView = true;
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
  window.setTimeout(() => { state.dragMoved = false; }, 0);
}

function handleTouchStart(e) {
  if (e.touches.length !== 1) return;
  const touch = e.touches[0];
  state.isDraggingCanvas = true;
  state.dragStartX = touch.clientX - state.panX;
  state.dragStartY = touch.clientY - state.panY;
}

function handleTouchMove(e) {
  if (!state.isDraggingCanvas || e.touches.length !== 1) return;
  e.preventDefault();
  state.userMovedView = true;
  const touch = e.touches[0];
  state.panX = touch.clientX - state.dragStartX;
  state.panY = touch.clientY - state.dragStartY;
  updateTransform();
}

function handleTouchEnd() {
  state.isDraggingCanvas = false;
}
