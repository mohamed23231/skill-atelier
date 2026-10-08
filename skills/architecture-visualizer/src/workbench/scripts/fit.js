// Geometry-only callers have no DOM; live fitting also includes the pill's ink bounds.
function canvasNodeVisualBounds(node) {
  const badge = typeof document === 'undefined' ? null : document.querySelector(`#node-${node.id} .node-badge`);
  if (!badge) return { x: node.x, y: node.y, width: node.width, height: node.height };
  const box = badge.getBBox();
  const translation = badge.transform.baseVal.consolidate().matrix;
  const left = Math.min(0, box.x + translation.e);
  const top = Math.min(0, box.y + translation.f);
  const right = Math.max(node.width, box.x + translation.e + box.width);
  const bottom = Math.max(node.height, box.y + translation.f + box.height);
  return { x: node.x + left, y: node.y + top, width: right - left, height: bottom - top };
}

function canvasPolicyGhosts(selector) {
  return typeof ghostLayer === 'undefined' ? [] : [...ghostLayer.querySelectorAll(selector)];
}

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
    const box = canvasNodeVisualBounds(n);
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
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

  canvasPolicyGhosts('.policy-ghost').forEach(group => {
    const box = group.getBBox();
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
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

// Compact canvas chrome needs an 8px gap, including below the horizontal lens pill.
function canvasOverlayRects() {
  const canvas = svg.getBoundingClientRect();
  // The minimap is left out: once the diagram fits it is idle and hidden.
  return ['.lens-key', '.viewport-controls', '.walk-track', '#sequence-bar']
    .map(selector => document.querySelector(selector))
    .filter(element => element && !element.hidden && getComputedStyle(element).display !== 'none')
    .map(element => ({ rect: element.getBoundingClientRect(), isKey: element.matches('.lens-key') }))
    .filter(({ rect }) => rect.width > 0 && rect.height > 0)
    .map(({ rect, isKey }) => ({ isKey, left: rect.left - canvas.left - 8, right: rect.right - canvas.left + 8,
      top: rect.top - canvas.top - 8, bottom: rect.bottom - canvas.top + 8 }));
}

function canvasSafeArea() {
  const rect = svg.getBoundingClientRect();
  const overlays = canvasOverlayRects();
  // The lens key is a horizontal pill: reserve its top band, not a full right column.
  const top = Math.max(16, ...overlays.filter(item => item.isKey).map(item => item.bottom));
  const bottom = Math.max(16, ...overlays.filter(item => !item.isKey && item.top > rect.height / 2)
    .map(item => rect.height - item.top));
  return { left: 16, top, width: Math.max(1, rect.width - 32),
    height: Math.max(1, rect.height - top - bottom) };
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
  const cardsWithTags = nodes.map(canvasNodeVisualBounds);
  const policyTags = canvasPolicyGhosts('.policy-ghost .edge-label-bg').map(label => {
    const box = label.getBBox();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  });
  const marks = cardsWithTags.concat(titles, policyTags, (LAYOUT_DATA.edges || []).filter(edge => edge.labelBounds)
    .map(edge => ({ x: edge.labelBounds.left, y: edge.labelBounds.top,
      width: edge.labelBounds.width, height: edge.labelBounds.height })));
  const initialZoom = Math.min((rect.width - 32) / Math.max(1, bounds.width),
    (rect.height - 32) / Math.max(1, bounds.height), 1.4);
  // Keep the whole drawing on-screen, but reserve overlay bands only where cards or labels cross them.
  // Candidate translations touch an inset or an overlay edge; prefer the centred solution.
  // Test translations at a fixed scale, then refine the first feasible scale below.
  const cameraAtZoom = zoom => {
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
          return { zoom, panX, panY };
        }
      }
    }
    return null;
  };
  let upperZoom = clampZoom(initialZoom);
  for (let zoom = upperZoom; ; zoom = Math.max(0.15, zoom * 0.995)) {
    let camera = cameraAtZoom(zoom);
    if (camera) {
      // A 0.5% search step can skip a valid fit above the readability threshold.
      // Bisect the last interval so the camera uses the available space precisely.
      let lowerZoom = zoom;
      for (let i = 0; i < 10 && upperZoom - lowerZoom > 0.00001; i++) {
        const middleZoom = (lowerZoom + upperZoom) / 2;
        const refined = cameraAtZoom(middleZoom);
        if (refined) { camera = refined; lowerZoom = middleZoom; }
        else upperZoom = middleZoom;
      }
      actions.setCamera(camera);
      updateTransform();
      return;
    }
    upperZoom = zoom;
    if (zoom <= 0.15) break;
  }
  const safe = canvasSafeArea();
  const zoom = clampZoom(Math.min(safe.width / Math.max(1, bounds.width), safe.height / Math.max(1, bounds.height), 1.4));
  actions.setCamera({ zoom, panX: safe.left + safe.width / 2 - (bounds.minX + bounds.maxX) * zoom / 2,
    panY: safe.top + safe.height / 2 - (bounds.minY + bounds.maxY) * zoom / 2 });
  updateTransform();
}

// The camera fitToScreen would choose, without moving the view. Remembered per canvas size and
// layout, since each walkthrough step and selection asks for it.
let fitCameraCache = null;
function fitCamera() {
  const rect = svg.getBoundingClientRect();
  const key = [Math.round(rect.width), Math.round(rect.height), state.collapsedBoundaries?.size || 0, state.activeFilter, state.lens,
    document.querySelector('.walk-track')?.getBoundingClientRect().height || 0,
    (LAYOUT_DATA.nodes || []).reduce((sum, node) => sum + node.x * 3 + node.y * 7, 0)].join(':');
  if (fitCameraCache?.key === key) return { ...fitCameraCache.camera };
  const current = { zoom: state.zoom, panX: state.panX, panY: state.panY };
  fitToScreen();
  const fit = { zoom: state.zoom, panX: state.panX, panY: state.panY };
  actions.setCamera(current);
  updateTransform();
  fitCameraCache = { key, camera: fit };
  return { ...fit };
}

function resetView() {
  actions.setCamera({ userMoved: false });
  state.selectedNode = null;
  state.highlightedChain = null;
  applyVisibility();
  fitToScreen();
}
