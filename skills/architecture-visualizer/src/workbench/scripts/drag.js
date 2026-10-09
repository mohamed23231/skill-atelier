function startNodeDrag(e, nodeId) {
  rememberPress(e);
  state.draggingNodeId = nodeId;
  state.dragMoved = false;
  const node = nodeById.get(nodeId);
  if (!node) return;
  const rect = svg.getBoundingClientRect();
  state.nodeDragOffset = {
    x: (e.clientX - rect.left - state.panX) / state.zoom - node.x,
    y: (e.clientY - rect.top - state.panY) / state.zoom - node.y
  };
}

function moveDraggedNode(clientX, clientY) {
  const node = nodeById.get(state.draggingNodeId);
  if (!node) return;
  const rect = svg.getBoundingClientRect();
  node.x = (clientX - rect.left - state.panX) / state.zoom - state.nodeDragOffset.x;
  node.y = (clientY - rect.top - state.panY) / state.zoom - state.nodeDragOffset.y;
  state.dragMoved = true;

  const nodeEl = document.getElementById(`node-${node.id}`);
  if (nodeEl) nodeEl.setAttribute('transform', `translate(${node.x}, ${node.y})`);
  recalculateNodeEdges(node.id);
}

function startBoundaryDrag(e, boundaryId) {
  if (e.target && e.target.closest && e.target.closest('.node-group')) return;
  rememberPress(e);
  state.draggingBoundaryId = boundaryId;
  state.dragMoved = false;
  const boundary = boundaryById.get(boundaryId);
  if (!boundary) return;
  const rect = svg.getBoundingClientRect();
  const cursorX = (e.clientX - rect.left - state.panX) / state.zoom;
  const cursorY = (e.clientY - rect.top - state.panY) / state.zoom;
  state.boundaryDragOffset = {
    x: cursorX - boundary.x,
    y: cursorY - boundary.y
  };
  state.boundaryInitialNodes = (LAYOUT_DATA.nodes || [])
    .filter(n => n.boundary === boundaryId)
    .map(n => ({ node: n, relX: n.x - boundary.x, relY: n.y - boundary.y }));
}

function moveDraggedBoundary(clientX, clientY) {
  const boundary = boundaryById.get(state.draggingBoundaryId);
  if (!boundary) return;
  const rect = svg.getBoundingClientRect();
  const cursorX = (clientX - rect.left - state.panX) / state.zoom;
  const cursorY = (clientY - rect.top - state.panY) / state.zoom;
  const newX = cursorX - state.boundaryDragOffset.x;
  const newY = cursorY - state.boundaryDragOffset.y;

  const dx = newX - boundary.x, dy = newY - boundary.y;
  const headerBox = LAYOUT_DATA.boundaryHeaderBoxes?.[(LAYOUT_DATA.boundaries || []).indexOf(boundary)];
  if (headerBox) { headerBox.x += dx; headerBox.y += dy; }
  boundary.x = newX;
  boundary.y = newY;
  state.dragMoved = true;

  const boundaryEl = document.getElementById(`boundary-${boundary.id}`);
  if (boundaryEl) {
    const rectEl = boundaryEl.querySelector('.boundary-rect');
    if (rectEl) {
      rectEl.setAttribute('x', boundary.x);
      rectEl.setAttribute('y', boundary.y);
    }
    const header = boundaryEl.querySelector('.boundary-toggle');
    if (header) {
      const matrix = header.transform.baseVal.consolidate()?.matrix;
      header.setAttribute('transform', `translate(${(matrix?.e || 0) + dx}, ${(matrix?.f || 0) + dy})`);
    }
  }

  const movedNodes = state.boundaryInitialNodes || [];
  movedNodes.forEach(({ node, relX, relY }) => {
    node.x = boundary.x + relX;
    node.y = boundary.y + relY;
    const nodeEl = document.getElementById(`node-${node.id}`);
    if (nodeEl) nodeEl.setAttribute('transform', `translate(${node.x}, ${node.y})`);
  });

  if (LAYOUT_DATA.config.router === 'orthogonal') recomputeAllEdges();
  else movedNodes.forEach(({ node }) => recalculateNodeEdges(node.id));
}

function syncLabelLeader(edge) {
  const labelGroup = document.getElementById(`label-${edge.id}`);
  if (!labelGroup) return;
  // A label the router found no clear room for is not drawn over cards or other labels; the
  // connection's tooltip and sheet still name it.
  labelGroup.toggleAttribute('data-unplaced', !edge.labelBounds);
  const leader = ArchVizGeometry.labelLeader(edge);
  let line = labelGroup.querySelector('.edge-label-leader');
  if (!leader) {
    if (line && line.parentNode) line.parentNode.removeChild(line);
    return;
  }
  if (!line) {
    line = el('line', { class: 'edge-label-leader' });
    labelGroup.insertBefore(line, labelGroup.firstChild);
  }
  Object.entries(leader).forEach(([key, value]) => line.setAttribute(key, value));
}

function contentBand() {
  return (LAYOUT_DATA.nodes || []).reduce((acc, n) => ({
    top: Math.min(acc.top, n.y),
    bottom: Math.max(acc.bottom, n.y + n.height),
    left: Math.min(acc.left, n.x),
    right: Math.max(acc.right, n.x + n.width)
  }), { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity });
}

function resolveLabelCollisions(edges, nodes, boundaryHeaderBoxes) {
  ArchVizGeometry.resolveLabelCollisions(edges, nodes, boundaryHeaderBoxes);
  (edges || []).forEach(edge => {
    if (edge.polyline && !edge.controls && edge.labelSlot === null) { syncLabelLeader(edge); return; }
    if (!(edge.points && typeof edge.labelWidth === 'number' && edge.labelWidth > 0)) return;
    edge.labelAnchor = { x: edge.labelX, y: edge.labelY };
    edge.labelBounds = {
      left: ArchVizGeometry.round(edge.labelX - edge.labelWidth / 2),
      right: ArchVizGeometry.round(edge.labelX + edge.labelWidth / 2),
      top: ArchVizGeometry.round(edge.labelY - 9),
      bottom: ArchVizGeometry.round(edge.labelY + 9),
      width: edge.labelWidth,
      height: 18,
      minX: ArchVizGeometry.round(edge.labelX - edge.labelWidth / 2),
      maxX: ArchVizGeometry.round(edge.labelX + edge.labelWidth / 2),
      minY: ArchVizGeometry.round(edge.labelY - 9),
      maxY: ArchVizGeometry.round(edge.labelY + 9),
    };
    if (edge.pathBounds && edge.markerBounds) {
      edge.totalVisualBounds = ArchVizGeometry.calculateEdgeVisualBounds(edge.pathBounds, edge.markerBounds, edge.labelBounds);
    }
    const labelGroup = document.getElementById('label-' + edge.id);
    if (!labelGroup) return;
    const bg = labelGroup.querySelector('rect');
    const txt = labelGroup.querySelector('text');
    if (!bg || !txt) return;
    bg.setAttribute('x', edge.labelX - edge.labelWidth / 2);
    bg.setAttribute('y', edge.labelY - 9);
    txt.setAttribute('x', edge.labelX);
    txt.setAttribute('y', edge.labelY);
    syncLabelLeader(edge);
  });
}

// Re-routes every connection for the current card positions and says which router managed it.
// Lane routing assumes each card sits in its lane; a card dragged out of it falls back to the
// column router, then to curves, so connections always follow their cards.
function recomputeAllEdges() {
  if (LAYOUT_DATA.config.router !== 'orthogonal') {
    (LAYOUT_DATA.nodes || []).forEach(node => recalculateCurvedEdges(node.id));
    return 'curved';
  }
  const labelWidths = Object.fromEntries(LAYOUT_DATA.edges.map(edge => [edge.id, estimateLabelWidth(edge.label || edge.packetLabel)]));
  const attempts = LAYOUT_DATA.config.layout === 'lanes' ? [['lanes', {}], ['columns', { lanes: false }]] : [['columns', {}]];
  let result = null;
  let used = 'curved';
  for (const [name, extra] of attempts) {
    try {
      result = ArchVizOrthogonal.routeOrthogonal(LAYOUT_DATA, { labelWidths, direction: LAYOUT_DATA.config.direction, ...extra });
      used = name;
      break;
    } catch (error) {
      result = null;
    }
  }
  if (!result) {
    (LAYOUT_DATA.nodes || []).forEach(node => recalculateCurvedEdges(node.id));
    return used;
  }
  LAYOUT_DATA.routingStats = result.stats;
  LAYOUT_DATA.edges.forEach(edge => {
    Object.assign(edge, ArchVizOrthogonal.buildRouteGeometry(result.routes[edge.id], labelWidths[edge.id], ArchVizGeometry, { source: nodeById.get(edge.source), target: nodeById.get(edge.target) }));
    const path = document.getElementById(`path-${edge.id}`);
    if (path) path.setAttribute('d', edge.path);
    document.getElementById(`hit-${edge.id}`)?.setAttribute('d', edge.path);
    const group = document.getElementById(`label-${edge.id}`);
    if (group) {
      const rect = group.querySelector('rect');
      const text = group.querySelector('text');
      if (rect) {
        rect.setAttribute('x', edge.labelX - edge.labelWidth / 2);
        rect.setAttribute('y', edge.labelY - 9);
      }
      if (text) {
        text.setAttribute('x', edge.labelX);
        text.setAttribute('y', edge.labelY);
      }
      syncLabelLeader(edge);
    }
  });
  return used;
}

function recalculateNodeEdges(nodeId) {
  if (LAYOUT_DATA.config.router === 'orthogonal') {
    recomputeAllEdges();
    return;
  }
  recalculateCurvedEdges(nodeId);
}

function recalculateCurvedEdges(nodeId) {
  (LAYOUT_DATA.edges || [])
    .filter(e => e.source === nodeId || e.target === nodeId)
    .forEach(edge => {
      const sourceNode = nodeById.get(edge.source);
      const targetNode = nodeById.get(edge.target);
      if (!sourceNode || !targetNode) return;

      const labelGroupEl = document.getElementById(`label-${edge.id}`);
      const labelRect = labelGroupEl ? labelGroupEl.querySelector('rect') : null;
      const otherLabelBoxes = (LAYOUT_DATA.edges || [])
        .filter(e => e.id !== edge.id && typeof e.labelX === 'number' && typeof e.labelY === 'number')
        .map(e => {
          const width = estimateLabelWidth(e.label || e.packetLabel);
          return {
            x: e.labelX - width / 2,
            y: e.labelY - LABEL_HEIGHT / 2,
            width,
            height: LABEL_HEIGHT
          };
        });
      const geometry = buildEdgeGeometry(sourceNode, targetNode, isLRLayout, {
        obstacles: [
          ...(LAYOUT_DATA.nodes || []),
          ...(LAYOUT_DATA.boundaryHeaderBoxes || []),
          ...otherLabelBoxes
        ],
        nodes: LAYOUT_DATA.nodes || [],
        band: contentBand(),
        labelWidth: labelRect ? parseFloat(labelRect.getAttribute('width')) : 0,
        sourcePortOffset: edge.sourcePortOffset || 0,
        targetPortOffset: edge.targetPortOffset || 0,
        isReciprocal: edge.isReciprocal
      });
      edge.path = geometry.path;
      edge.points = geometry.points;
      edge.controls = geometry.controls;
      edge.endpoint = geometry.endpoint;
      edge.segments = geometry.segments;
      edge.labelX = geometry.labelX;
      edge.labelY = geometry.labelY;
      edge.labelTether = geometry.labelTether;
      edge.labelWidth = labelRect ? parseFloat(labelRect.getAttribute('width')) : 0;
      edge.labelAnchor = geometry.labelAnchor;
      edge.labelBounds = geometry.labelBounds;
      edge.terminalTangent = geometry.terminalTangent;
      edge.markerBounds = geometry.markerBounds;
      edge.pathBounds = geometry.pathBounds;
      edge.totalVisualBounds = geometry.totalVisualBounds;

      const pathEl = document.getElementById(`path-${edge.id}`);
      if (pathEl) pathEl.setAttribute('d', geometry.path);
      document.getElementById(`hit-${edge.id}`)?.setAttribute('d', geometry.path);

      const labelGroup = document.getElementById(`label-${edge.id}`);
      if (labelGroup) {
        const bg = labelGroup.querySelector('rect');
        const txt = labelGroup.querySelector('text');
        const labelWidth = parseFloat(bg.getAttribute('width'));
        bg.setAttribute('x', geometry.labelX - labelWidth / 2);
        bg.setAttribute('y', geometry.labelY - 9);
        txt.setAttribute('x', geometry.labelX);
        txt.setAttribute('y', geometry.labelY);
      }
    });

  resolveLabelCollisions(LAYOUT_DATA.edges || [], LAYOUT_DATA.nodes || [], LAYOUT_DATA.boundaryHeaderBoxes || []);
}
