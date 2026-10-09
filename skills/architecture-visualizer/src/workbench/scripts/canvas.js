// Rendering
function nodeShape(node) {
  return el('rect', { class: 'node-rect', width: node.width, height: node.height, rx: 12 });
}

function renderDiagram() {
  invalidateMinimapBounds();
  boundariesLayer.innerHTML = '';
  edgesLayer.innerHTML = '';
  nodesLayer.innerHTML = '';

  const tierBottom = new Map();
  (LAYOUT_DATA.boundaries || []).forEach(b => {
    tierBottom.set(b.y, Math.max(tierBottom.get(b.y) ?? -Infinity, b.y + b.height));
  });

  (LAYOUT_DATA.boundaries || []).forEach(b => {
    const collapsed = state.collapsedBoundaries.has(b.id);
    const lane = LAYOUT_DATA.config.layout === 'lanes';
    const g = el('g', { class: `boundary-group${collapsed ? ' collapsed' : ''}`, id: `boundary-${b.id}` });

    const rect = el('rect', {
      class: 'boundary-rect',
      x: b.x,
      y: b.y,
      width: b.width,
      height: collapsed ? COLLAPSED_PILL_HEIGHT : (tierBottom.get(b.y) - b.y)
    });

    const header = el('g', { class: 'boundary-toggle', role: 'button', tabindex: '0' });
    const hitRect = el('rect', {
      class: 'boundary-hit-rect',
      x: b.x,
      y: b.y,
      width: lane && !collapsed ? b.gutterWidth || 150 : b.width,
      height: lane && !collapsed ? b.height : 36,
      fill: 'transparent',
      'pointer-events': 'all'
    });
    const chevron = el('path', {
      class: 'boundary-chevron',
      d: collapsed
        ? `M ${b.x + 16} ${b.y + 16} l 5 5 l -5 5`
        : `M ${b.x + 14} ${b.y + 18} l 5 5 l 5 -5`
    });
    const text = el('text', { class: 'boundary-header', x: b.x + 34, y: b.y + 26 });
    const memberCount = (LAYOUT_DATA.nodes || []).filter(n => n.boundary === b.id).length;
    const headerText = collapsed ? `${b.label || b.id} (${memberCount} hidden)` : (b.label || b.id);
    if (lane && !collapsed) {
      const available = (b.gutterWidth || 150) - 40;
      const lines = wrapText(headerText, `600 12px ${cssToken('--sans')}`, available, 3);
      text.setAttribute('x', b.x + 30);
      lines.forEach((line, index) => {
        const span = el('tspan', { x: b.x + 30, dy: index ? 16 : 0 });
        span.textContent = fitText(line, `600 12px ${cssToken('--sans')}`, available);
        text.appendChild(span);
      });
      const count = el('text', { class: 'boundary-count', x: b.x + 30, y: b.y + 26 + lines.length * 16 + 2 });
      count.textContent = `${memberCount} component${memberCount === 1 ? '' : 's'}`;
      header.appendChild(count);
      withTooltip(text, headerText);
    } else {
      text.textContent = fitText(headerText, `600 12px ${cssToken('--sans')}`, b.width - 46);
      if (text.textContent !== headerText) withTooltip(text, headerText);
    }

    header.appendChild(hitRect);
    header.appendChild(chevron);
    header.appendChild(text);
    withTooltip(header, collapsed ? 'Expand boundary' : 'Collapse boundary');
    header.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!state.dragMoved) toggleBoundary(b.id);
    });
    header.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        toggleBoundary(b.id);
      }
    });

    rect.addEventListener('mousedown', ev => {
      if (ev.button === 0) {
        ev.stopPropagation();
        startBoundaryDrag(ev, b.id);
      }
    });

    header.addEventListener('mousedown', ev => {
      if (ev.button === 0) {
        ev.stopPropagation();
        if (ev.target === chevron) return;
        startBoundaryDrag(ev, b.id);
      }
    });

    g.appendChild(rect);
    g.appendChild(header);
    boundariesLayer.appendChild(g);
  });

  (LAYOUT_DATA.edges || []).forEach(e => {
    const g = el('g', { class: 'edge-group', id: `edge-${e.id}`, role: 'button', tabindex: '0' });
    const path = el('path', {
      id: `path-${e.id}`,
      class: `edge-path ${e.communication === 'async' ? 'async' : ''} ${e.pathType || ''}`,
      d: e.path,
      'marker-end': e.communication === 'async' ? 'url(#arrow-async)' : 'url(#arrow-sync)'
    });
    const sourceLabel = nodeById.get(e.source)?.label || e.source;
    const targetLabel = nodeById.get(e.target)?.label || e.target;
    g.setAttribute('aria-label', `${sourceLabel} → ${targetLabel}: ${e.label || e.packetLabel || 'unlabeled'} · ${e.communication || 'sync'}`);
    withTooltip(path, `${sourceLabel} → ${targetLabel}\n${e.label || e.packetLabel || 'unlabeled'} · ${e.communication || 'sync'}${e.pathType ? ` · ${e.pathType}` : ''}`);
    g.appendChild(path);
    // A thin line is hard to hit: a wide invisible twin takes the pointer, and a click or the label
    // opens the connection's sheet.
    g.appendChild(el('path', { id: `hit-${e.id}`, class: 'edge-hit', d: e.path }));
    g.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!state.dragMoved) openInspectorForEdge(e.id);
    });
    g.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        ev.stopPropagation();
        openInspectorForEdge(e.id);
      }
    });

    const labelText = e.label || e.packetLabel;
    if (labelText) {
      const labelGroup = el('g', { class: 'edge-label', id: `label-${e.id}` });
      const labelWidth = estimateLabelWidth(labelText);
      labelGroup.appendChild(el('rect', {
        class: 'edge-label-bg',
        x: e.labelX - labelWidth / 2,
        y: e.labelY - 9,
        width: labelWidth,
        height: 18
      }));
      const txt = el('text', { class: 'edge-label-text', x: e.labelX, y: e.labelY });
      txt.textContent = labelDisplayText(labelText);
      if (txt.textContent !== labelText) withTooltip(labelGroup, labelText);
      labelGroup.appendChild(txt);
      g.appendChild(labelGroup);
    }

    edgesLayer.appendChild(g);
    if (labelText) syncLabelLeader(e);
  });

  (LAYOUT_DATA.nodes || []).forEach(n => {
    const g = el('g', {
      class: 'node-group',
      id: `node-${n.id}`,
      transform: `translate(${n.x}, ${n.y})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${n.label}. ${n.type}. ${n.status || 'UNKNOWN'}. ${n.delta || DELTA.UNCHANGED}.`
    });

    g.appendChild(nodeShape(n));
    renderNodeCard(g, n);

    const tooltipLines = [n.label, n.technology, n.description]
      .concat((n.details?.files || []).map(f => (typeof f === 'string' ? f : f.path)))
      .filter(Boolean);
    withTooltip(g, tooltipLines.join('\n'));

    // Clicking a card or pressing Enter on it opens its sheet, frames its neighbourhood and spotlights it.
    g.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!state.dragMoved) openInspectorForNode(n.id);
    });
    g.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openInspectorForNode(n.id);
      }
    });
    g.addEventListener('mousedown', ev => {
      if (ev.button === 0) {
        ev.stopPropagation();
        startNodeDrag(ev, n.id);
      }
    });

    nodesLayer.appendChild(g);
  });
  applyLens();
}

function toggleBoundary(boundaryId) {
  if (state.collapsedBoundaries.has(boundaryId)) {
    state.collapsedBoundaries.delete(boundaryId);
  } else {
    state.collapsedBoundaries.add(boundaryId);
  }
  renderDiagram();
  applyVisibility();
  renderMinimap();
  if (state.animatingFlow) startFlowParticles();
}

// One line icon per component kind; the kind is never carried by card color.
function getNodeIcon(type) {
  switch (type) {
    case 'actor': return 'kind-actor';
    case 'frontend': return 'kind-frontend';
    case 'mobile': return 'kind-mobile';
    case 'api_gateway': return 'kind-api_gateway';
    case 'database': return 'kind-database';
    case 'cache': return 'kind-cache';
    case 'queue': return 'kind-queue';
    case 'topic': return 'kind-topic';
    case 'external': return 'kind-external';
    case 'worker': return 'kind-worker';
    case 'cloud_function': return 'kind-cloud_function';
    case 'storage': return 'kind-storage';
    case 'service': return 'kind-service';
    default: return 'kind-component';
  }
}

// Card content is neutral; the active lens supplies badges and evidence markers.
function renderNodeCard(g, n) {
  const w = n.width;
  const sans = cssToken('--sans');

  g.appendChild(el('rect', { class: 'node-tile', x: 12, y: 12, width: 28, height: 28, rx: 8 }));
  g.appendChild(el('use', { class: 'node-icon', href: `#${getNodeIcon(n.type)}`, x: 18, y: 18, width: 16, height: 16, 'aria-hidden': 'true' }));

  const nameFont = `600 13px ${sans}`;
  const nameLines = wrapText(n.label, nameFont, w - 50 - 32, 2);
  const name = el('text', { class: 'node-name', x: 50, y: nameLines.length > 1 ? 23 : 31 });
  nameLines.forEach((line, i) => {
    const span = el('tspan', { x: 50, dy: i === 0 ? 0 : 16 });
    span.textContent = line;
    name.appendChild(span);
  });
  g.appendChild(name);

  renderNodeLensDetails(g, n, null, null);
}

function renderNodeLensDetails(g, n, badge, marker) {
  g.querySelectorAll('.node-badge, .node-tech, .node-exception').forEach(item => item.remove());
  const w = n.width;
  const h = n.height;
  const sans = cssToken('--sans');
  const mono = cssToken('--mono');

  if (badge) {
    const { text: label, tone } = badge;
    const badgeWidth = measureText(label, `600 10.5px ${sans}`) + 14;
    const badgeGroup = el('g', { class: `node-badge ${tone}`, transform: `translate(${w - 12 - badgeWidth}, -8)` });
    badgeGroup.appendChild(el('rect', { class: 'base', width: badgeWidth, height: 16, rx: 6 }));
    badgeGroup.appendChild(el('rect', { class: 'tint', width: badgeWidth, height: 16, rx: 6 }));
    const badgeText = el('text', { x: 7, y: 12 });
    badgeText.textContent = label;
    badgeGroup.appendChild(badgeText);
    g.appendChild(badgeGroup);
  }

  const techFull = n.technology || n.type;
  const tech = el('text', { class: 'node-tech', x: 12, y: h - 12 });
  tech.textContent = fitText(techFull, `400 10.5px ${mono}`, w - 24);
  g.appendChild(tech);

  if (marker === 'exception-ring') {
    const ring = el('circle', { class: 'node-exception', cx: w - 16, cy: 16, r: 4.5 });
    withTooltip(ring, `${String(n.status).toLowerCase()}: not verified by evidence`);
    g.appendChild(ring);
  }
}

// A highlighted edge ends in an accent arrowhead; every other edge keeps its own.
function syncEdgeMarker(path) {
  if (!path || path.classList.contains('ghost')) return;
  const marker = path.classList.contains('highlighted') ? 'arrow-highlight' : (path.classList.contains('async') ? 'arrow-async' : 'arrow-sync');
  path.setAttribute('marker-end', `url(#${marker})`);
}

// Single source of truth for what is hidden / dimmed
function isNodeHidden(node) {
  if (state.collapsedBoundaries.has(node.boundary)) return true;
  if (state.currentView === VIEWS.BEFORE_AFTER) {
    if (state.deltaMode === DELTA_MODES.CURRENT && node.delta === DELTA.ADDED) return true;
    if (state.deltaMode === DELTA_MODES.PROPOSED && node.delta === DELTA.REMOVED) return true;
  }
  return false;
}

function matchesLayerFilter(node) {
  switch (state.activeFilter) {
    case 'frontend': return node.type === 'frontend' || node.type === 'mobile' || node.type === 'actor';
    case 'backend': return node.type === 'service' || node.type === 'worker' || node.type === 'api_gateway' || node.type === 'cloud_function';
    case 'data': return node.type === 'database' || node.type === 'cache' || node.type === 'storage' || node.type === 'queue' || node.type === 'topic';
    case 'external': return node.type === 'external';
    default: return true;
  }
}

function dependencyChainSet(nodeId) {
  const edges = LAYOUT_DATA.edges || [];
  const active = new Set([nodeId]);
  const walk = (current, key, next, visited) => {
    edges.forEach(e => {
      if (e[key] === current && !visited.has(e[next])) {
        active.add(e[next]);
        visited.add(e[next]);
        walk(e[next], key, next, visited);
      }
    });
  };
  walk(nodeId, 'target', 'source', new Set([nodeId]));
  walk(nodeId, 'source', 'target', new Set([nodeId]));
  return active;
}

function applyVisibility() {
  applyFocusMode();
  renderLensKey(lensEncoding(state.lens, ARCH_SPEC).keyItems);
  const chain = state.highlightedChain ? dependencyChainSet(state.highlightedChain) : null;
  const hidden = new Set();
  const dimmed = new Set();

  (LAYOUT_DATA.nodes || []).forEach(n => {
    const nodeEl = document.getElementById(`node-${n.id}`);
    if (!nodeEl) return;

    const isHidden = isNodeHidden(n);
    if (isHidden) hidden.add(n.id);

    const isDimmed = !isHidden && (
      !matchesLayerFilter(n) ||
      (chain ? !chain.has(n.id) : false)
    );
    if (isDimmed) dimmed.add(n.id);

    nodeEl.classList.toggle('hidden', isHidden);
    nodeEl.classList.toggle('dimmed', isDimmed);
    nodeEl.setAttribute('tabindex', isHidden ? '-1' : '0');
  });

  (LAYOUT_DATA.edges || []).forEach(e => {
    const group = document.getElementById(`edge-${e.id}`);
    if (!group) return;

    const endpointHidden = hidden.has(e.source) || hidden.has(e.target);
    const deltaHidden = state.currentView === VIEWS.BEFORE_AFTER && (
      (state.deltaMode === DELTA_MODES.CURRENT && e.delta === DELTA.ADDED) ||
      (state.deltaMode === DELTA_MODES.PROPOSED && e.delta === DELTA.REMOVED)
    );
    const offDataPath = state.currentView === VIEWS.DATA_FLOW && e.pathType && !DATA_FLOW_PATH_TYPES.has(e.pathType);

    const isHidden = endpointHidden || deltaHidden;
    const isDimmed = !isHidden && (dimmed.has(e.source) || dimmed.has(e.target) || offDataPath);

    group.classList.toggle('hidden', isHidden);
    group.classList.toggle('dimmed', isDimmed);

    const path = document.getElementById(`path-${e.id}`);
    if (path && !state.sequencePlaying && !state.scenarioActive && state.currentView !== VIEWS.SEQUENCE) {
      path.classList.toggle('highlighted', Boolean(chain) && chain.has(e.source) && chain.has(e.target));
      syncEdgeMarker(path);
    }
  });

  renderMinimap();
  if (state.animatingFlow) startFlowParticles();
}
