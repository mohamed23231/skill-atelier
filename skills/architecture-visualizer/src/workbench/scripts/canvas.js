// Rendering
function nodeShape(node) {
  const w = node.width;
  const h = node.height;
  switch (node.type) {
    case 'database':
    case 'storage': {
      const r = 12;
      const d = `M 0 ${r} C 0 0, ${w} 0, ${w} ${r} L ${w} ${h - r} C ${w} ${h}, 0 ${h}, 0 ${h - r} Z`;
      return el('path', { class: 'node-rect shape-cylinder', d });
    }
    case 'queue':
    case 'topic': {
      const notch = 16;
      const d = `M 0 0 L ${w - notch} 0 L ${w} ${h / 2} L ${w - notch} ${h} L 0 ${h} Z`;
      return el('path', { class: 'node-rect shape-queue', d });
    }
    case 'external':
      return el('rect', { class: 'node-rect shape-external', width: w, height: h, rx: 14 });
    case 'actor':
      return el('rect', { class: 'node-rect shape-actor', width: w, height: h, rx: h / 2 });
    case 'cloud_function':
    case 'worker':
      return el('rect', { class: 'node-rect shape-worker', width: w, height: h, rx: 22 });
    default:
      return el('rect', { class: 'node-rect', width: w, height: h, rx: 10 });
  }
}

function renderDiagram() {
  boundariesLayer.innerHTML = '';
  edgesLayer.innerHTML = '';
  nodesLayer.innerHTML = '';

  const tierBottom = new Map();
  (LAYOUT_DATA.boundaries || []).forEach(b => {
    tierBottom.set(b.y, Math.max(tierBottom.get(b.y) ?? -Infinity, b.y + b.height));
  });

  (LAYOUT_DATA.boundaries || []).forEach(b => {
    const collapsed = state.collapsedBoundaries.has(b.id);
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
      width: b.width,
      height: 36,
      fill: 'transparent',
      'pointer-events': 'all'
    });
    const chevron = el('text', { class: 'boundary-header', x: b.x + 18, y: b.y + 26 });
    chevron.textContent = collapsed ? '▸' : '▾';
    const text = el('text', { class: 'boundary-header', x: b.x + 36, y: b.y + 26 });
    const memberCount = (LAYOUT_DATA.nodes || []).filter(n => n.boundary === b.id).length;
    text.textContent = collapsed ? `${b.label || b.id} (${memberCount} hidden)` : (b.label || b.id);

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
    const g = el('g', { class: 'edge-group', id: `edge-${e.id}` });
    const path = el('path', {
      id: `path-${e.id}`,
      class: `edge-path ${e.communication === 'async' ? 'async' : ''} ${e.pathType || ''}`,
      d: e.path,
      'marker-end': e.communication === 'async' ? 'url(#arrow-async)' : 'url(#arrow-sync)'
    });
    const sourceLabel = nodeById.get(e.source)?.label || e.source;
    const targetLabel = nodeById.get(e.target)?.label || e.target;
    withTooltip(path, `${sourceLabel} → ${targetLabel}\n${e.label || e.packetLabel || 'unlabeled'} · ${e.communication || 'sync'}${e.pathType ? ` · ${e.pathType}` : ''}`);
    g.appendChild(path);

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
      class: `node-group delta-${(n.delta || DELTA.UNCHANGED).toLowerCase()}`,
      id: `node-${n.id}`,
      transform: `translate(${n.x}, ${n.y})`,
      tabindex: '0',
      role: 'button',
      'aria-label': `${n.label}. ${n.type}. ${n.status || 'VERIFIED'}. ${n.delta || DELTA.UNCHANGED}.`
    });

    g.appendChild(nodeShape(n));

    const iconText = el('text', { x: 14, y: 30, 'font-size': '14', 'aria-hidden': 'true' });
    iconText.textContent = getNodeIcon(n.type);

    const titleText = el('text', { x: 36, y: 30, 'font-size': '15', 'font-weight': '700', fill: 'var(--text-main)' });
    titleText.textContent = truncateString(n.label, 18);

    const techText = el('text', { x: 14, y: 52, 'font-size': '10', 'letter-spacing': '0.4', fill: 'var(--text-muted)' });
    techText.textContent = truncateString(n.technology || n.type, 26);

    const badgesGroup = el('g', { transform: 'translate(14, 74)' });
    const statusTxt = el('text', {
      'font-size': '10',
      'font-weight': '700',
      fill: n.status === 'VERIFIED' ? 'var(--accent-green)' : 'var(--accent-amber)'
    });
    statusTxt.textContent = `[${n.status || 'VERIFIED'}]`;
    badgesGroup.appendChild(statusTxt);

    if (n.delta && n.delta !== DELTA.UNCHANGED) {
      const deltaTxt = el('text', {
        x: (String(n.status || 'VERIFIED').length + 2) * 6.2 + 8,
        'font-size': '10',
        'font-weight': '700',
        fill: n.delta === DELTA.ADDED ? 'var(--accent-green)' : (n.delta === DELTA.CHANGED ? 'var(--accent-amber)' : 'var(--accent-rose)')
      });
      deltaTxt.textContent = `[${n.delta}]`;
      badgesGroup.appendChild(deltaTxt);
    }

    g.appendChild(iconText);
    g.appendChild(titleText);
    g.appendChild(techText);
    g.appendChild(badgesGroup);

    const tooltipLines = [n.label, n.technology, n.description]
      .concat((n.details?.files || []).map(f => (typeof f === 'string' ? f : f.path)))
      .filter(Boolean);
    withTooltip(g, tooltipLines.join('\n'));

    g.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!state.dragMoved) selectNode(n.id);
    });
    g.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        selectNode(n.id);
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
}

function toggleBoundary(boundaryId) {
  if (state.collapsedBoundaries.has(boundaryId)) {
    state.collapsedBoundaries.delete(boundaryId);
  } else {
    state.collapsedBoundaries.add(boundaryId);
  }
  renderDiagram();
  applyVisibility();
  if (state.animatingFlow) startFlowParticles();
}

function getNodeIcon(type) {
  switch (type) {
    case 'actor': return '👤';
    case 'frontend': return '💻';
    case 'mobile': return '📱';
    case 'api_gateway': return '🚪';
    case 'database': return '🗄️';
    case 'cache': return '⚡';
    case 'queue':
    case 'topic': return '📨';
    case 'external': return '🌐';
    case 'worker': return '⚙️';
    case 'storage': return '📦';
    default: return '🧩';
  }
}

function truncateString(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max - 2) + '…' : str;
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

function matchesSearch(node) {
  const q = state.searchQuery;
  if (!q) return true;
  const files = (node.details?.files || []).map(f => (typeof f === 'string' ? f : f.path));
  return [node.label, node.technology, node.type, node.description, ...files]
    .filter(Boolean)
    .some(value => String(value).toLowerCase().includes(q));
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
  const walk = (current, key, next) => {
    edges.forEach(e => {
      if (e[key] === current && !active.has(e[next])) {
        active.add(e[next]);
        walk(e[next], key, next);
      }
    });
  };
  walk(nodeId, 'target', 'source');
  walk(nodeId, 'source', 'target');
  return active;
}

function applyVisibility() {
  const chain = state.highlightedChain ? dependencyChainSet(state.highlightedChain) : null;
  const hidden = new Set();
  const dimmed = new Set();

  (LAYOUT_DATA.nodes || []).forEach(n => {
    const nodeEl = document.getElementById(`node-${n.id}`);
    if (!nodeEl) return;

    const isHidden = isNodeHidden(n);
    if (isHidden) hidden.add(n.id);

    const isDimmed = !isHidden && (
      !matchesSearch(n) ||
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
    }
  });

  if (state.animatingFlow) startFlowParticles();
}
