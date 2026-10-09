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
  if (edge?.polyline?.length > 1) {
    const points = edge.polyline;
    const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.y - points[index].y));
    let remaining = lengths.reduce((sum, length) => sum + length, 0) * Math.max(0, Math.min(1, t));
    for (let i = 0; i < lengths.length; i++) {
      if (remaining <= lengths[i] && lengths[i] > 0) {
        const ratio = remaining / lengths[i];
        return { x: points[i].x + (points[i + 1].x - points[i].x) * ratio, y: points[i].y + (points[i + 1].y - points[i].y) * ratio };
      }
      remaining -= lengths[i];
    }
    return points[points.length - 1];
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
    group.dataset.canvasLens = state.lens;
    group.toggleAttribute('data-lens-context', state.lens === 'change' && (!node.delta || node.delta === 'UNCHANGED'));
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
    path.dataset.lensStroke = state.lens === 'change' && edge.delta === 'CHANGED' ? 'warn' : mark.stroke;
    path.dataset.lensStyle = mark.strokeStyle;
    if (group) {
      group.dataset.canvasLens = state.lens;
      group.toggleAttribute('data-lens-context',
        (state.lens === 'change' && (!edge.delta || edge.delta === 'UNCHANGED')) ||
        (state.lens === 'risk' && mark.stroke === 'edge'));
      group.querySelectorAll('.edge-chevron, .edge-cycle-marker').forEach(item => item.remove());
      renderEdgeLensMarks(group, edge, mark);
    }
  });
  ghostLayer.querySelectorAll('.policy-ghost').forEach(item => item.remove());
  renderPolicyGhosts(encoding.ghosts);
  renderLensKey(encoding.keyItems);
}

// Route ghosts together so their ports and label slots do not compete with each other.
function renderPolicyGhosts(ghosts) {
  const candidates = (ghost, side) => (LAYOUT_DATA.nodes || []).filter(node =>
    Boolean(ghost[side] || ghost[`${side}Type`] || ghost[`${side}Boundary`]) &&
    (!ghost[side] || node.id === ghost[side]) &&
    (!ghost[`${side}Type`] || node.type === ghost[`${side}Type`]) &&
    (!ghost[`${side}Boundary`] || node.boundary === ghost[`${side}Boundary`]));
  const resolved = ghosts.flatMap(ghost => candidates(ghost, 'from').flatMap(from =>
    candidates(ghost, 'to').map(to => ({ ...ghost, from: from.id, to: to.id }))));
  const edges = resolved.map((ghost, index) => ({ ...ghost, id: `policy-ghost-${index}`, source: ghost.from, target: ghost.to }));
  if (!edges.length) return;
  let routes = {};
  try {
    routes = ArchVizOrthogonal.routeOrthogonal({ ...LAYOUT_DATA, edges }, {
      direction: LAYOUT_DATA.config.direction,
      cornerRadius: 0, jumpRadius: 0,
      labelWidths: Object.fromEntries(edges.map(edge => [edge.id, estimateLabelWidth(edge.label)])),
    }).routes;
  } catch {
    // A crowded or manually dragged layout can make a route impossible.
    // Preserve the previous drawing as a fallback rather than breaking lens switching.
  }
  const occupied = LAYOUT_DATA.nodes.map(node => ({
    left: node.x - 4, right: node.x + node.width + 4,
    top: node.y - 14, bottom: node.y + node.height + 4,
  }));
  const inverse = ghostLayer.getCTM().inverse();
  document.querySelectorAll('.edge-label-bg, .node-badge').forEach(item => {
    const box = item.getBBox();
    const matrix = inverse.multiply(item.getCTM());
    const a = new DOMPoint(box.x, box.y).matrixTransform(matrix);
    const b = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
    occupied.push({ left: a.x - 4, right: b.x + 4, top: a.y - 4, bottom: b.y + 4 });
  });
  edges.forEach(ghost => {
    const from = nodeById.get(ghost.from), to = nodeById.get(ghost.to);
    const points = routes[ghost.id]?.points || [
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: to.x + to.width / 2, y: to.y + to.height / 2 },
    ];
    const group = el('g', { class: 'policy-ghost', 'data-policy-id': ghost.policyId });
    group.appendChild(el('path', {
      class: 'policy-ghost-line',
      d: points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '),
      'data-lens-stroke': 'risk',
    }));
    const width = estimateLabelWidth(ghost.label);
    const segments = points.slice(1).map((b, index) => ({ a: points[index], b }))
      .sort((a, b) => Math.hypot(b.b.x - b.a.x, b.b.y - b.a.y) - Math.hypot(a.b.x - a.a.x, a.b.y - a.a.y));
    let placement;
    // Prefer an on-route pill; only a fully occupied route needs a short leader.
    for (let offset = 0; offset <= 896 && !placement; offset += 14) {
      for (const segment of segments) {
        const length = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
        const steps = Math.max(1, Math.ceil(length / 14));
        const fractions = Array.from({ length: steps + 1 }, (_, i) => i / steps)
          .sort((a, b) => Math.abs(a - 0.5) - Math.abs(b - 0.5));
        for (const t of fractions) {
          const anchor = { x: segment.a.x + (segment.b.x - segment.a.x) * t, y: segment.a.y + (segment.b.y - segment.a.y) * t };
          for (const sign of offset ? [-1, 1] : [1]) {
            const x = anchor.x + (segment.a.x === segment.b.x ? offset * sign : 0);
            const y = anchor.y + (segment.a.x === segment.b.x ? 0 : offset * sign);
            const box = { left: x - width / 2, right: x + width / 2, top: y - 9, bottom: y + 9 };
            if (occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue;
            placement = { x, y, anchor, box };
            break;
          }
          if (placement) break;
        }
        if (placement) break;
      }
    }
    const { x, y, anchor, box } = placement || {
      x: points[0].x, y: points[0].y, anchor: points[0],
      box: { left: points[0].x - width / 2, right: points[0].x + width / 2, top: points[0].y - 9, bottom: points[0].y + 9 },
    };
    occupied.push({ left: box.left - 4, right: box.right + 4, top: box.top - 4, bottom: box.bottom + 4 });
    const label = el('g', { class: 'edge-label' });
    if (x !== anchor.x || y !== anchor.y) label.appendChild(el('line', {
      class: 'edge-label-leader', x1: anchor.x, y1: anchor.y, x2: x, y2: y,
    }));
    label.appendChild(el('rect', { class: 'edge-label-bg', x: x - width / 2, y: y - 9, width, height: 18 }));
    const text = el('text', { class: 'edge-label-text', x, y });
    text.textContent = ghost.label;
    label.appendChild(text);
    group.appendChild(label);
    ghostLayer.appendChild(group);
  });
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
