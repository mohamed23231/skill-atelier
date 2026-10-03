function computeTotalVisualBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const tierBottom = new Map();
  (LAYOUT_DATA.boundaries || []).forEach(b => {
    tierBottom.set(b.y, Math.max(tierBottom.get(b.y) ?? -Infinity, b.y + b.height));
  });

  (LAYOUT_DATA.boundaries || []).forEach(b => {
    const collapsed = state.collapsedBoundaries.has(b.id);
    const h = collapsed ? COLLAPSED_PILL_HEIGHT : (tierBottom.get(b.y) - b.y);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + h);
  });

  (LAYOUT_DATA.boundaryHeaderBoxes || []).forEach(hb => {
    minX = Math.min(minX, hb.x);
    minY = Math.min(minY, hb.y);
    maxX = Math.max(maxX, hb.x + hb.width);
    maxY = Math.max(maxY, hb.y + hb.height);
  });

  (LAYOUT_DATA.nodes || []).forEach(n => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });

  (LAYOUT_DATA.edges || []).forEach(e => {
    if (e.totalVisualBounds) {
      minX = Math.min(minX, e.totalVisualBounds.minX);
      minY = Math.min(minY, e.totalVisualBounds.minY);
      maxX = Math.max(maxX, e.totalVisualBounds.maxX);
      maxY = Math.max(maxY, e.totalVisualBounds.maxY);
    } else if (e.points) {
      minX = Math.min(minX, e.points.x1, e.points.x2);
      minY = Math.min(minY, e.points.y1, e.points.y2);
      maxX = Math.max(maxX, e.points.x1, e.points.x2);
      maxY = Math.max(maxY, e.points.y1, e.points.y2);
    }
  });

  if (!isFinite(minX) || !isFinite(minY)) {
    if (LAYOUT_DATA.dimensions) {
      return LAYOUT_DATA.dimensions;
    }
    return { minX: 0, minY: 0, maxX: 1200, maxY: 800, width: 1200, height: 800 };
  }

  return {
    minX: ArchVizGeometry.round(minX),
    minY: ArchVizGeometry.round(minY),
    maxX: ArchVizGeometry.round(maxX),
    maxY: ArchVizGeometry.round(maxY),
    width: ArchVizGeometry.round(maxX - minX),
    height: ArchVizGeometry.round(maxY - minY),
  };
}

function fitToScreen() {
  const bounds = computeTotalVisualBounds();
  if (!bounds || !isFinite(bounds.minX)) return;
  const rect = svg.getBoundingClientRect();
  const padding = 24;
  const contentWidth = bounds.maxX - bounds.minX + padding * 2;
  const contentHeight = bounds.maxY - bounds.minY + padding * 2;

  const fitZoom = Math.min(Math.min(rect.width / contentWidth, rect.height / contentHeight), 1.4);
  const zoom = clampZoom(fitZoom);
  actions.setCamera({
    zoom,
    panX: (rect.width - contentWidth * zoom) / 2 - bounds.minX * zoom + padding * zoom,
    panY: (rect.height - contentHeight * zoom) / 2 - bounds.minY * zoom + padding * zoom
  });
  updateTransform();
}

function resetView() {
  actions.setCamera({ userMoved: false });
  state.selectedNode = null;
  state.highlightedChain = null;
  applyVisibility();
  fitToScreen();
}
