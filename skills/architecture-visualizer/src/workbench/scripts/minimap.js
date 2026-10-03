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
    mark.setAttribute('stroke', 'var(--text-dim)');
    mark.setAttribute('stroke-width', '4');
    content.appendChild(mark);
  });
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const mark = el('rect', { x: node.x, y: node.y, width: node.width, height: node.height, rx: 4, 'data-minimap-mark': 'node' });
    mark.setAttribute('fill', 'var(--accent-blue)');
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
