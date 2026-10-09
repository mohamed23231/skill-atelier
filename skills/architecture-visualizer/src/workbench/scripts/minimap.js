let minimapBounds = null;
function invalidateMinimapBounds() { minimapBounds = null; }

function renderMinimap() {
  const minimap = document.getElementById('minimap-svg');
  const content = document.getElementById('minimap-content');
  if (!minimap || !content) return;
  const bounds = minimapBounds = computeTotalVisualBounds();
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  minimap.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${width} ${height}`);
  content.replaceChildren();
  const tierBottom = new Map();
  (LAYOUT_DATA.boundaries || []).forEach(b => {
    tierBottom.set(b.y, Math.max(tierBottom.get(b.y) ?? -Infinity, b.y + b.height));
  });
  (LAYOUT_DATA.boundaries || []).forEach(boundary => {
    const mark = el('rect', { x: boundary.x, y: boundary.y, width: boundary.width, height: state.collapsedBoundaries.has(boundary.id) ? COLLAPSED_PILL_HEIGHT : tierBottom.get(boundary.y) - boundary.y, 'data-minimap-mark': 'boundary' });
    mark.setAttribute('fill', 'none');
    mark.setAttribute('stroke', 'var(--faint)');
    mark.setAttribute('stroke-width', '4');
    content.appendChild(mark);
  });
  (LAYOUT_DATA.nodes || []).filter(node => !isNodeHidden(node)).forEach(node => {
    const mark = el('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: 4, 'data-minimap-mark': 'node' });
    mark.setAttribute('fill', 'var(--accent)');
    mark.setAttribute('opacity', '0.72');
    content.appendChild(mark);
  });
  updateMinimapViewport();
}

function updateMinimapViewport() {
  const viewportRect = document.querySelector('[data-minimap-viewport]');
  if (!viewportRect || !state.zoom) return;
  const rect = svg.getBoundingClientRect();
  viewportRect.setAttribute('x', -state.panX / state.zoom);
  viewportRect.setAttribute('y', -state.panY / state.zoom);
  viewportRect.setAttribute('width', Math.max(rect.width / state.zoom, 1));
  viewportRect.setAttribute('height', Math.max(rect.height / state.zoom, 1));
  // The minimap only earns its space when part of the diagram is out of view.
  const bounds = minimapBounds || (minimapBounds = computeTotalVisualBounds());
  const left = state.panX + bounds.minX * state.zoom;
  const top = state.panY + bounds.minY * state.zoom;
  const idle = left >= -1 && top >= -1 && left + bounds.width * state.zoom <= rect.width + 1 && top + bounds.height * state.zoom <= rect.height + 1;
  // A walkthrough or a selection frames the camera itself, so the minimap stays out of the way until
  // the reader pans or zooms on their own.
  const walking = typeof walkIsActive === 'function' && walkIsActive();
  const framed = !state.userMovedView;
  document.querySelector('.workbench-minimap')?.setAttribute('data-idle', idle || walking || framed ? 'true' : 'false');
}

function handleMinimapClick(event) {
  event.stopPropagation();
  const minimap = document.getElementById('minimap-svg');
  const matrix = minimap?.getScreenCTM();
  if (!matrix) return;
  const point = minimap.createSVGPoint();
  point.x = event.clientX; point.y = event.clientY;
  const world = point.matrixTransform(matrix.inverse());
  focusModelPoint(world.x, world.y);
}

// Arrow keys move the viewport by a tenth of its size; Enter/Space center the model.
function handleMinimapKeyDown(event) {
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const direction = directions[event.key];
  if (!direction && event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  const rect = svg.getBoundingClientRect();
  if (direction) {
    actions.setCamera({ panX: state.panX - direction[0] * rect.width / 10,
      panY: state.panY - direction[1] * rect.height / 10, userMoved: true });
    updateTransform();
  } else {
    const bounds = minimapBounds || (minimapBounds = computeTotalVisualBounds());
    focusModelPoint(bounds.minX + bounds.width / 2, bounds.minY + bounds.height / 2);
  }
}
