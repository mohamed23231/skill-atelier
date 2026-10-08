function renderMinimap() {
  const minimap = document.getElementById('minimap-svg');
  const content = document.getElementById('minimap-content');
  if (!minimap || !content) return;
  const bounds = computeTotalVisualBounds();
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  minimap.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${width} ${height}`);
  content.replaceChildren();
  (LAYOUT_DATA.boundaries || []).forEach(boundary => {
    const mark = el('rect', { x: boundary.x, y: boundary.y, width: boundary.width, height: boundary.height, 'data-minimap-mark': 'boundary' });
    mark.setAttribute('fill', 'none');
    mark.setAttribute('stroke', 'var(--faint)');
    mark.setAttribute('stroke-width', '4');
    content.appendChild(mark);
  });
  (LAYOUT_DATA.nodes || []).forEach(node => {
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
  const bounds = computeTotalVisualBounds();
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
  const minimap = document.querySelector('[data-region="minimap"]');
  const bounds = computeTotalVisualBounds();
  const rect = minimap.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const x = bounds.minX + ((event.clientX - rect.left) / rect.width) * bounds.width;
  const y = bounds.minY + ((event.clientY - rect.top) / rect.height) * bounds.height;
  focusModelPoint(x, y);
}
