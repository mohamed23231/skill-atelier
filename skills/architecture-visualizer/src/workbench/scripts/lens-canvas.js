const LAYER_FILTERS = ['all', 'frontend', 'backend', 'data', 'external'];

function selectLayerFilter(layer) {
  actions.setFilter(layer);
  applyVisibility();
  updateUrlState();
}

// Lens encoding changes marks, never visibility or spotlight state.
function lensEdgePoint(edge, t) {
  if (edge && edge.points && edge.controls && typeof ArchVizGeometry !== 'undefined') {
    return ArchVizGeometry.cubicPointAt(t, edge.points, edge.controls);
  }
  return { x: (edge && edge.labelX) || 0, y: (edge && edge.labelY) || 0 };
}

// An against-flow edge earns a chevron at its midpoint; a cycle edge a numbered disc.
function renderEdgeLensMarks(group, edge, mark) {
  if (!group || !mark) return;
  if (mark.marker === 'against-flow') {
    const mid = lensEdgePoint(edge, 0.5);
    const before = lensEdgePoint(edge, 0.4);
    const angle = (Math.atan2(mid.y - before.y, mid.x - before.x) * 180) / Math.PI;
    group.appendChild(el('path', {
      class: 'edge-chevron',
      d: 'M -5 -5 L 5 0 L -5 5',
      transform: `translate(${mid.x}, ${mid.y}) rotate(${angle})`,
      'data-edge-id': edge.id,
      'aria-hidden': 'true',
    }));
  }
  if (mark.cycleIndex != null) {
    const mid = lensEdgePoint(edge, 0.5);
    const badge = el('g', {
      class: 'edge-cycle-marker',
      transform: `translate(${mid.x}, ${mid.y})`,
      'data-cycle-index': String(mark.cycleIndex),
      'aria-hidden': 'true',
    });
    badge.appendChild(el('circle', { class: 'edge-cycle-circle', r: 9 }));
    const text = el('text', { class: 'edge-cycle-text', x: 0, y: 0 });
    text.textContent = String(mark.cycleIndex);
    badge.appendChild(text);
    group.appendChild(badge);
  }
}

function applyLens() {
  const encoding = lensEncoding(state.lens, ARCH_SPEC);
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const group = document.getElementById(`node-${node.id}`);
    const mark = encoding.nodes[node.id];
    if (!group || !mark) return;
    group.dataset.lensStroke = mark.stroke;
    group.dataset.lensStyle = mark.strokeStyle;
    if (mark.fill) group.dataset.lensFill = mark.fill;
    else group.removeAttribute('data-lens-fill');
    group.toggleAttribute('data-lens-muted', mark.mutedText);
    group.toggleAttribute('data-lens-strike', mark.strike);
    group.querySelectorAll('.node-evidence-marker').forEach(item => item.remove());
    renderNodeLensDetails(group, node, mark.badge, mark.marker);
    if (mark.marker === 'evidence-missing') {
      group.appendChild(el('circle', { class: 'node-evidence-marker', cx: node.width - 22, cy: 16, r: 4.5, 'aria-hidden': 'true' }));
    }
  });
  (LAYOUT_DATA.edges || []).forEach(edge => {
    const group = document.getElementById(`edge-${edge.id}`);
    const path = document.getElementById(`path-${edge.id}`);
    const mark = encoding.edges[edge.id];
    if (!path || !mark) return;
    path.dataset.lensStroke = mark.stroke;
    path.dataset.lensStyle = mark.strokeStyle;
    if (group) {
      group.querySelectorAll('.edge-chevron, .edge-cycle-marker').forEach(item => item.remove());
      renderEdgeLensMarks(group, edge, mark);
    }
  });
  ghostLayer.querySelectorAll('.policy-ghost').forEach(item => item.remove());
  encoding.ghosts.forEach(ghost => {
    const from = nodeById.get(ghost.from);
    const to = nodeById.get(ghost.to);
    if (!from || !to) return;
    const x1 = from.x + from.width / 2, y1 = from.y + from.height / 2;
    const x2 = to.x + to.width / 2, y2 = to.y + to.height / 2;
    const group = el('g', { class: 'policy-ghost', 'data-policy-id': ghost.policyId });
    group.appendChild(el('line', {
      class: 'policy-ghost-line', x1, y1, x2, y2,
      'data-lens-stroke': ghost.label === 'Forbidden · absent' ? 'risk' : 'warn'
    }));
    const label = el('g', { class: 'edge-label' });
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    const width = estimateLabelWidth(ghost.label);
    label.appendChild(el('rect', { class: 'edge-label-bg', x: x - width / 2, y: y - 9, width, height: 18 }));
    const text = el('text', { class: 'edge-label-text', x, y });
    text.textContent = ghost.label;
    label.appendChild(text);
    group.appendChild(label);
    ghostLayer.appendChild(group);
  });
  renderLensKey(encoding.keyItems);
}

let lensFiltersBound = false;

function closeLensFilters() {
  const key = document.querySelector('.lens-key');
  const popover = key?.querySelector('.lens-filters');
  if (!popover || popover.hidden) return;
  popover.hidden = true;
  key.querySelector('[data-action="lens-filters"]')?.setAttribute('aria-expanded', 'false');
  key.querySelector('[data-action="lens-filters"]')?.focus();
}

function renderLensKey(items) {
  const key = document.querySelector('.lens-key');
  if (!key) return;
  const signature = JSON.stringify([state.lens, state.currentView, state.activeFilter, state.deltaMode, items]);
  if (key.dataset.encoding === signature) return;
  const focused = key.contains(document.activeElement) ? document.activeElement : null;
  const focusAttribute = ['data-filter', 'data-delta-mode', 'data-action'].find(attribute => focused?.hasAttribute(attribute));
  const focusValue = focusAttribute ? focused.getAttribute(focusAttribute) : null;
  const filtersOpen = key.querySelector('.lens-filters')?.hidden === false;
  if (!lensFiltersBound) {
    lensFiltersBound = true;
    ['mousedown', 'touchstart'].forEach(type => key.addEventListener(type, event => event.stopPropagation()));
    document.addEventListener('click', event => {
      // Filtering rebuilds the key before this event bubbles to the document.
      // Its original path still identifies a click inside the popover.
      if (!event.composedPath().includes(key)) closeLensFilters();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && document.querySelector('.lens-filters')?.hidden === false) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeLensFilters();
      }
    }, true);
  }
  key.dataset.encoding = signature;
  key.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = state.lens.charAt(0).toUpperCase() + state.lens.slice(1);
  key.appendChild(title);
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'lens-key-row';
    const swatch = document.createElement('span');
    swatch.className = 'lens-key-swatch';
    swatch.dataset.lensStroke = item.stroke;
    swatch.dataset.lensStyle = item.strokeStyle;
    swatch.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(swatch, label);
    key.appendChild(row);
  });
  const filters = document.createElement('div');
  filters.id = 'lens-filters';
  filters.className = 'lens-filters';
  filters.hidden = !filtersOpen;
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Canvas filters');
  if (state.lens === 'structure') {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'Data flow only';
    toggle.setAttribute('aria-pressed', String(state.currentView === VIEWS.DATA_FLOW));
    toggle.addEventListener('click', () => {
      switchView(state.currentView === VIEWS.DATA_FLOW ? VIEWS.ARCHITECTURE : VIEWS.DATA_FLOW);
    });
    toggle.dataset.action = 'data-flow-toggle';
    filters.appendChild(toggle);
  }
  {
    const layers = document.createElement('div');
    layers.className = 'lens-key-controls lens-key-layers';
    layers.setAttribute('role', 'group');
    layers.setAttribute('aria-label', 'Layers');
    const label = document.createElement('span');
    label.textContent = 'Layers';
    layers.appendChild(label);
    LAYER_FILTERS.forEach(layer => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.filter = layer;
      chip.textContent = layer.charAt(0).toUpperCase() + layer.slice(1);
      chip.setAttribute('aria-pressed', String(state.activeFilter === layer));
      chip.addEventListener('click', () => selectLayerFilter(layer));
      layers.appendChild(chip);
    });
    filters.appendChild(layers);
  }
  if (state.lens === 'change') {
    const modes = document.createElement('div');
    modes.className = 'lens-key-controls lens-key-delta';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Change mode');
    ['current', 'proposed', 'diff'].forEach(mode => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.deltaMode = mode;
      button.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
      button.setAttribute('aria-pressed', String(state.deltaMode === mode));
      button.addEventListener('click', () => {
        actions.setDeltaMode(mode);
        applyVisibility();
      });
      modes.appendChild(button);
    });
    key.appendChild(modes);
  }
  const filterButton = document.createElement('button');
  filterButton.type = 'button';
  filterButton.dataset.action = 'lens-filters';
  filterButton.textContent = 'Filters';
  filterButton.setAttribute('aria-controls', filters.id);
  filterButton.setAttribute('aria-expanded', String(filtersOpen));
  filterButton.addEventListener('click', () => {
    filters.hidden = !filters.hidden;
    filterButton.setAttribute('aria-expanded', String(!filters.hidden));
    if (!filters.hidden) filters.querySelector('button')?.focus();
  });
  key.append(filterButton, filters);
  if (focusAttribute) key.querySelector(`[${focusAttribute}="${focusValue}"]`)?.focus();
}
