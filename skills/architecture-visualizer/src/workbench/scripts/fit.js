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

// Overlay rectangles are canvas-local and include a 16px breathing room.
function canvasOverlayRects() {
  const canvas = svg.getBoundingClientRect();
  return ['.lens-key', '.viewport-controls', '.workbench-minimap', '.walk-track', '#sequence-bar']
    .map(selector => document.querySelector(selector))
    .filter(element => element && !element.hidden && getComputedStyle(element).display !== 'none')
    .map(element => ({ rect: element.getBoundingClientRect(), isKey: element.matches('.lens-key') }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .map(({ rect, isKey }) => ({ isKey, left: rect.left - canvas.left - 16, right: rect.right - canvas.left + 16,
      top: rect.top - canvas.top - 16, bottom: rect.bottom - canvas.top + 16 }));
}

function canvasSafeArea() {
  const rect = svg.getBoundingClientRect();
  const overlays = canvasOverlayRects();
  const key = document.querySelector('.lens-key')?.getBoundingClientRect();
  const right = key?.width ? key.width + 32 : 16;
  const bottom = Math.max(16, ...overlays.filter(item => !item.isKey && item.top > rect.height / 2)
    .map(item => rect.height - item.top));
  return { left: 16, top: 16, width: Math.max(1, rect.width - 16 - right),
    height: Math.max(1, rect.height - 16 - bottom) };
}

function fitToScreen() {
  const bounds = computeTotalVisualBounds();
  if (!bounds || !isFinite(bounds.minX)) return;
  const rect = svg.getBoundingClientRect();
  const overlays = canvasOverlayRects();
  const nodes = (LAYOUT_DATA.nodes || []).filter(node => !isNodeHidden(node));
  // Lane titles sit in the gutter at each boundary's top-left; they must stay readable too.
  const titles = (LAYOUT_DATA.boundaries || []).map(boundary => ({ x: boundary.x, y: boundary.y,
    width: Math.min(160, boundary.width), height: Math.min(52, boundary.height) }));
  const marks = nodes.concat(titles, (LAYOUT_DATA.edges || []).filter(edge => edge.labelBounds)
    .map(edge => ({ x: edge.labelBounds.left, y: edge.labelBounds.top,
      width: edge.labelBounds.width, height: edge.labelBounds.height })));
  const initialZoom = Math.min((rect.width - 32) / Math.max(1, bounds.width),
    (rect.height - 32) / Math.max(1, bounds.height), 1.4);
  // Keep the whole drawing on-screen, but reserve overlay bands only where cards or labels cross them.
  // Candidate translations touch an inset or an overlay edge; prefer the centred solution.
  for (let zoom = clampZoom(initialZoom); ; zoom = Math.max(0.15, zoom * 0.98)) {
    const minX = 16 - bounds.minX * zoom, maxX = rect.width - 16 - bounds.maxX * zoom;
    const minY = 16 - bounds.minY * zoom, maxY = rect.height - 16 - bounds.maxY * zoom;
    const centreX = (minX + maxX) / 2, centreY = (minY + maxY) / 2;
    const xs = [centreX, minX, maxX], ys = [centreY, minY, maxY];
    overlays.forEach(overlay => marks.forEach(node => {
      xs.push(overlay.left - (node.x + node.width) * zoom, overlay.right - node.x * zoom);
      ys.push(overlay.top - (node.y + node.height) * zoom, overlay.bottom - node.y * zoom);
    }));
    const candidates = (values, min, max, centre) => [...new Set(values)]
      .filter(value => value >= min - 0.01 && value <= max + 0.01)
      .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
    for (const panY of candidates(ys, minY, maxY, centreY)) {
      for (const panX of candidates(xs, minX, maxX, centreX)) {
        const blocked = marks.some(node => overlays.some(overlay =>
          panX + node.x * zoom < overlay.right - 0.01 && panX + (node.x + node.width) * zoom > overlay.left + 0.01 &&
          panY + node.y * zoom < overlay.bottom - 0.01 && panY + (node.y + node.height) * zoom > overlay.top + 0.01));
        if (!blocked) {
          actions.setCamera({ zoom, panX, panY });
          updateTransform();
          return;
        }
      }
    }
    if (zoom <= 0.15) break;
  }
  const safe = canvasSafeArea();
  const zoom = clampZoom(Math.min(safe.width / Math.max(1, bounds.width), safe.height / Math.max(1, bounds.height), 1.4));
  actions.setCamera({ zoom, panX: safe.left + safe.width / 2 - (bounds.minX + bounds.maxX) * zoom / 2,
    panY: safe.top + safe.height / 2 - (bounds.minY + bounds.maxY) * zoom / 2 });
  updateTransform();
}

function resetView() {
  actions.setCamera({ userMoved: false });
  state.selectedNode = null;
  state.highlightedChain = null;
  applyVisibility();
  fitToScreen();
}
