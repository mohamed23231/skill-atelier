/**
 * Deterministic hierarchical layout engine for architecture diagrams.
 * Boundaries become ranks, nodes are ordered inside a rank by iterative barycenter
 * sweeps, and every edge is routed as a cubic bezier with an on-curve label anchor.
 * No randomness: identical input always yields identical coordinates.
 */

const {
  buildEdgeGeometry,
  curveSanityScore,
  resolveLabelCollisions,
  findLabelAnchor,
  estimateLabelWidth,
  labelDisplayText,
  calculateConnectionPoints,
  calculateControlPoints,
  cubicBezierBounds,
  calculateMarkerBounds,
  calculateEdgeVisualBounds,
  cubicPointAt,
  generatePathCurve,
  round,
} = require('./geometry.js');

const DEFAULT_CONFIG = {
  direction: 'LR',
  nodeWidth: 200,
  nodeHeight: 96,
  nodeGapY: 34,
  nodeGapX: 50,
  boundaryPaddingX: 20,
  boundaryPaddingY: 28,
  boundaryHeaderHeight: 36,
  boundaryGapX: 120,
  boundaryGapY: 80,
  barycenterSweeps: 4,
};

const TIER_ORDER = [
  'actors',
  'clients',
  'frontend',
  'edge',
  'api_gateway',
  'gateway',
  'services',
  'backend',
  'core',
  'workers',
  'data',
  'storage',
  'database',
  'messaging',
  'queues',
  'external',
  'third_party',
];

function computeLayout(spec, customConfig = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('computeLayout requires an architecture spec object.');
  }
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    throw new TypeError('computeLayout requires spec.nodes to be a non-empty array. Run validateArchitecture first.');
  }

  const config = { ...DEFAULT_CONFIG, ...(spec.layout || {}), ...customConfig };
  const isLR = config.direction !== 'TB';

  const nodeMap = new Map();
  spec.nodes.forEach((n) => {
    nodeMap.set(n.id, {
      ...n,
      width: config.nodeWidth,
      height: config.nodeHeight,
      x: 0,
      y: 0,
    });
  });

  const boundaries =
    Array.isArray(spec.boundaries) && spec.boundaries.length > 0
      ? spec.boundaries.map((b) => ({ ...b, nodes: [], x: 0, y: 0, width: 0, height: 0 }))
      : [{ id: 'default_boundary', label: 'System Components', type: 'system', nodes: [], x: 0, y: 0, width: 0, height: 0 }];

  const boundaryMap = new Map();
  boundaries.forEach((b) => boundaryMap.set(b.id, b));

  const unassignedNodes = [];
  nodeMap.forEach((node) => {
    if (node.boundary && boundaryMap.has(node.boundary)) {
      boundaryMap.get(node.boundary).nodes.push(node);
    } else {
      unassignedNodes.push(node);
    }
  });

  if (unassignedNodes.length > 0) {
    let fallbackBoundary = boundaryMap.get('default_boundary');
    if (!fallbackBoundary) {
      fallbackBoundary = {
        id: 'general_components',
        label: 'Components & Services',
        type: 'container',
        nodes: [],
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
      boundaryMap.set(fallbackBoundary.id, fallbackBoundary);
      boundaries.push(fallbackBoundary);
    }
    unassignedNodes.forEach((node) => {
      node.boundary = fallbackBoundary.id;
      fallbackBoundary.nodes.push(node);
    });
  }

  boundaries.sort((a, b) => {
    const hasOrderA = typeof a.order === 'number';
    const hasOrderB = typeof b.order === 'number';
    if (hasOrderA && hasOrderB) return a.order - b.order || a.id.localeCompare(b.id);
    if (hasOrderA) return -1;
    if (hasOrderB) return 1;
    const rankA = getTierRank(a.id, a.type, a.label);
    const rankB = getTierRank(b.id, b.type, b.label);
    if (rankA !== rankB) return rankA - rankB;
    return a.id.localeCompare(b.id);
  });

  const populatedBoundaries = boundaries.filter((b) => b.nodes.length > 0);
  orderNodesByBarycenter(populatedBoundaries, spec.edges || [], config.barycenterSweeps);

  let currentBoundaryCoord = 60;
  const computedBoundaries = [];
  const computedNodes = [];

  populatedBoundaries.forEach((b, rankIndex) => {
    const nodes = b.nodes;
    nodes.forEach((node) => {
      node.rank = rankIndex;
    });

    if (isLR) {
      const subColumns = nodes.length > 4 ? 2 : 1;
      const rowsPerSubCol = Math.ceil(nodes.length / subColumns);

      const boundaryInnerWidth = subColumns * config.nodeWidth + (subColumns - 1) * config.nodeGapX;
      const boundaryWidth = boundaryInnerWidth + config.boundaryPaddingX * 2;
      const boundaryInnerHeight = rowsPerSubCol * config.nodeHeight + (rowsPerSubCol - 1) * config.nodeGapY;
      const boundaryHeight = boundaryInnerHeight + config.boundaryPaddingY * 2 + config.boundaryHeaderHeight;

      b.x = currentBoundaryCoord;
      b.y = 80;
      b.width = boundaryWidth;
      b.height = boundaryHeight;

      nodes.forEach((node, idx) => {
        const subCol = idx % subColumns;
        const row = Math.floor(idx / subColumns);
        node.x = b.x + config.boundaryPaddingX + subCol * (config.nodeWidth + config.nodeGapX);
        node.y = b.y + config.boundaryHeaderHeight + config.boundaryPaddingY + row * (config.nodeHeight + config.nodeGapY);
        computedNodes.push(node);
      });

      computedBoundaries.push(b);
      currentBoundaryCoord += boundaryWidth + config.boundaryGapX;
    } else {
      const subRows = nodes.length > 4 ? 2 : 1;
      const colsPerSubRow = Math.ceil(nodes.length / subRows);

      const boundaryInnerWidth = colsPerSubRow * config.nodeWidth + (colsPerSubRow - 1) * config.nodeGapX;
      const boundaryWidth = boundaryInnerWidth + config.boundaryPaddingX * 2;
      const boundaryInnerHeight = subRows * config.nodeHeight + (subRows - 1) * config.nodeGapY;
      const boundaryHeight = boundaryInnerHeight + config.boundaryPaddingY * 2 + config.boundaryHeaderHeight;

      b.x = 80;
      b.y = currentBoundaryCoord;
      b.width = boundaryWidth;
      b.height = boundaryHeight;

      nodes.forEach((node, idx) => {
        const row = idx % subRows;
        const col = Math.floor(idx / subRows);
        node.x = b.x + config.boundaryPaddingX + col * (config.nodeWidth + config.nodeGapX);
        node.y = b.y + config.boundaryHeaderHeight + config.boundaryPaddingY + row * (config.nodeHeight + config.nodeGapY);
        computedNodes.push(node);
      });

      computedBoundaries.push(b);
      currentBoundaryCoord += boundaryHeight + config.boundaryGapY;
    }
  });

  const boundaryHeaderBoxes = computedBoundaries.map((b) => ({
    x: b.x + 12,
    y: b.y + 8,
    width: Math.min(b.width - 24, Math.max(String(b.label || '').length * 7.5, 60)),
    height: 24,
  }));

  const band = computedNodes.reduce(
    (acc, n) => ({
      top: Math.min(acc.top, n.y),
      bottom: Math.max(acc.bottom, n.y + n.height),
      left: Math.min(acc.left, n.x),
      right: Math.max(acc.right, n.x + n.width),
    }),
    { top: Infinity, bottom: -Infinity, left: Infinity, right: -Infinity }
  );

  const placedLabels = [];
  const { sourceOffsets, targetOffsets } = computePortOffsets(spec.edges || [], nodeMap, isLR);

  const directedPairs = new Set();
  (spec.edges || []).forEach((e) => {
    directedPairs.add(`${e.source}->${e.target}`);
  });

  const computedEdges = (spec.edges || []).map((edge, idx) => {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    const id = edge.id || `edge_${edge.source}_${edge.target}_${idx}`;

    if (!sourceNode || !targetNode) {
      return { ...edge, id, path: '', points: null, labelX: 0, labelY: 0, sourcePortOffset: 0, targetPortOffset: 0 };
    }

    const sourcePortOffset = sourceOffsets[idx] || 0;
    const targetPortOffset = targetOffsets[idx] || 0;
    const isReciprocal = directedPairs.has(`${edge.target}->${edge.source}`);

    return {
      ...edge,
      id,
      sourcePortOffset,
      targetPortOffset,
      isReciprocal,
      ...buildEdgeGeometry(sourceNode, targetNode, isLR, {
        obstacles: [...computedNodes, ...boundaryHeaderBoxes, ...placedLabels],
        placedLabels,
        nodes: computedNodes,
        band,
        label: edge.label || edge.packetLabel,
        sourcePortOffset,
        targetPortOffset,
        isReciprocal,
      }),
    };
  });

  resolveLabelCollisions(computedEdges, computedNodes, boundaryHeaderBoxes);

  computedEdges.forEach((edge) => {
    if (!edge.points) return;
    edge.labelAnchor = { x: edge.labelX, y: edge.labelY };
    edge.labelBounds = {
      left: round(edge.labelX - edge.labelWidth / 2),
      right: round(edge.labelX + edge.labelWidth / 2),
      top: round(edge.labelY - 9),
      bottom: round(edge.labelY + 9),
      width: edge.labelWidth,
      height: 18,
      minX: round(edge.labelX - edge.labelWidth / 2),
      maxX: round(edge.labelX + edge.labelWidth / 2),
      minY: round(edge.labelY - 9),
      maxY: round(edge.labelY + 9),
    };
    edge.totalVisualBounds = calculateEdgeVisualBounds(edge.pathBounds, edge.markerBounds, edge.labelWidth > 0 ? edge.labelBounds : null);
  });

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  computedBoundaries.forEach((b) => {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  });
  computedNodes.forEach((n) => {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  });
  boundaryHeaderBoxes.forEach((hb) => {
    minX = Math.min(minX, hb.x);
    minY = Math.min(minY, hb.y);
    maxX = Math.max(maxX, hb.x + hb.width);
    maxY = Math.max(maxY, hb.y + hb.height);
  });
  computedEdges.forEach((e) => {
    if (!e.totalVisualBounds) return;
    minX = Math.min(minX, e.totalVisualBounds.minX);
    minY = Math.min(minY, e.totalVisualBounds.minY);
    maxX = Math.max(maxX, e.totalVisualBounds.maxX);
    maxY = Math.max(maxY, e.totalVisualBounds.maxY);
  });

  if (computedBoundaries.length === 0 && computedNodes.length === 0) {
    minX = 0;
    minY = 0;
    maxX = 1200;
    maxY = 800;
  }

  const totalVisualBounds = {
    minX: round(minX),
    minY: round(minY),
    maxX: round(maxX),
    maxY: round(maxY),
    left: round(minX),
    top: round(minY),
    right: round(maxX),
    bottom: round(maxY),
    width: round(maxX - minX),
    height: round(maxY - minY),
  };

  const canvasWidth = Math.max(Math.ceil(totalVisualBounds.maxX + 120), Math.ceil(totalVisualBounds.width + 120), 1200);
  const canvasHeight = Math.max(Math.ceil(totalVisualBounds.maxY + 120), Math.ceil(totalVisualBounds.height + 120), 800);

  return {
    dimensions: {
      minX: totalVisualBounds.minX,
      minY: totalVisualBounds.minY,
      maxX: totalVisualBounds.maxX,
      maxY: totalVisualBounds.maxY,
      canvasWidth,
      canvasHeight,
    },
    totalVisualBounds,
    config,
    boundaries: computedBoundaries,
    boundaryHeaderBoxes,
    nodes: computedNodes,
    edges: computedEdges,
  };
}

/**
 * Iterative barycenter ordering across boundary ranks.
 * Nodes carrying an explicit numeric `order` are pinned; everything else is swept.
 */
function orderNodesByBarycenter(rankedBoundaries, edges, sweeps) {
  const positionOf = new Map();

  rankedBoundaries.forEach((b) => {
    b.nodes.sort((n1, n2) => {
      const o1 = typeof n1.order === 'number' ? n1.order : Number.POSITIVE_INFINITY;
      const o2 = typeof n2.order === 'number' ? n2.order : Number.POSITIVE_INFINITY;
      if (o1 !== o2) return o1 - o2;
      return n1.id.localeCompare(n2.id);
    });
    b.nodes.forEach((n, i) => positionOf.set(n.id, i));
  });

  const predecessors = new Map();
  const successors = new Map();
  edges.forEach((e) => {
    if (!predecessors.has(e.target)) predecessors.set(e.target, []);
    predecessors.get(e.target).push(e.source);
    if (!successors.has(e.source)) successors.set(e.source, []);
    successors.get(e.source).push(e.target);
  });

  const sweepOnce = (boundaryList, neighborMap) => {
    boundaryList.forEach((b) => {
      const pinned = b.nodes.every((n) => typeof n.order === 'number');
      if (pinned) return;

      const scored = b.nodes.map((node, index) => {
        const neighbors = (neighborMap.get(node.id) || []).map((id) => positionOf.get(id)).filter((p) => typeof p === 'number');
        const barycenter = neighbors.length > 0 ? neighbors.reduce((sum, p) => sum + p, 0) / neighbors.length : index;
        return { node, index, barycenter };
      });

      scored.sort((a, b2) => {
        if (typeof a.node.order === 'number' || typeof b2.node.order === 'number') {
          const o1 = typeof a.node.order === 'number' ? a.node.order : Number.POSITIVE_INFINITY;
          const o2 = typeof b2.node.order === 'number' ? b2.node.order : Number.POSITIVE_INFINITY;
          if (o1 !== o2) return o1 - o2;
        }
        if (Math.abs(a.barycenter - b2.barycenter) > 1e-9) return a.barycenter - b2.barycenter;
        if (a.index !== b2.index) return a.index - b2.index;
        return a.node.id.localeCompare(b2.node.id);
      });

      b.nodes = scored.map((s) => s.node);
      b.nodes.forEach((n, i) => positionOf.set(n.id, i));
    });
  };

  for (let i = 0; i < sweeps; i++) {
    sweepOnce(rankedBoundaries.slice(1), predecessors);
    sweepOnce(rankedBoundaries.slice(0, -1).reverse(), successors);
  }
}

function computePortOffsets(edges, nodeMap, isLR) {
  const faceGroups = new Map();
  const sourceOffsets = [];
  const targetOffsets = [];

  edges.forEach((edge, idx) => {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    if (!sourceNode || !targetNode) return;

    if (edge.source === edge.target) {
      sourceOffsets[idx] = 0;
      targetOffsets[idx] = 0;
      return;
    }

    const basePoints = calculateConnectionPoints(sourceNode, targetNode, isLR);
    const sourceFace = basePoints.sourceFace;
    const targetFace = basePoints.targetFace;

    const sourceKey = `${sourceNode.id}:${sourceFace}`;
    const targetKey = `${targetNode.id}:${targetFace}`;

    if (!faceGroups.has(sourceKey)) faceGroups.set(sourceKey, []);
    if (!faceGroups.has(targetKey)) faceGroups.set(targetKey, []);

    faceGroups.get(sourceKey).push({
      edge,
      idx,
      node: sourceNode,
      otherNode: targetNode,
      face: sourceFace,
      isSource: true,
    });

    faceGroups.get(targetKey).push({
      edge,
      idx,
      node: targetNode,
      otherNode: sourceNode,
      face: targetFace,
      isSource: false,
    });
  });

  faceGroups.forEach((group) => {
    if (group.length === 1) {
      const item = group[0];
      if (item.isSource) {
        sourceOffsets[item.idx] = 0;
      } else {
        targetOffsets[item.idx] = 0;
      }
      return;
    }

    const face = group[0].face;
    const node = group[0].node;
    const isVerticalFace = face === 'left' || face === 'right';

    group.sort((a, b) => {
      const coordA = isVerticalFace ? a.otherNode.y + a.otherNode.height * 0.5 : a.otherNode.x + a.otherNode.width * 0.5;
      const coordB = isVerticalFace ? b.otherNode.y + b.otherNode.height * 0.5 : b.otherNode.x + b.otherNode.width * 0.5;

      if (Math.abs(coordA - coordB) > 1e-4) {
        return coordA - coordB;
      }

      const sourceA = nodeMap.get(a.edge.source);
      const targetA = nodeMap.get(a.edge.target);
      const sourceB = nodeMap.get(b.edge.source);
      const targetB = nodeMap.get(b.edge.target);

      const isForwardA = isLR ? targetA.x > sourceA.x : targetA.y > sourceA.y;
      const isForwardB = isLR ? targetB.x > sourceB.x : targetB.y > sourceB.y;

      if (isForwardA !== isForwardB) {
        return isForwardA ? -1 : 1;
      }

      return a.idx - b.idx;
    });

    const n = group.length;
    const faceLength = isVerticalFace ? node.height : node.width;
    const span = Math.min(faceLength * 0.6, (n - 1) * 18);

    group.forEach((item, k) => {
      const offset = (k - (n - 1) / 2) * (span / (n - 1));
      const rounded = round(offset);
      if (item.isSource) {
        sourceOffsets[item.idx] = rounded;
      } else {
        targetOffsets[item.idx] = rounded;
      }
    });
  });

  return { sourceOffsets, targetOffsets };
}

function getTierRank(id, type, label) {
  const str = `${id} ${type || ''} ${label || ''}`.toLowerCase();
  for (let i = 0; i < TIER_ORDER.length; i++) {
    if (str.includes(TIER_ORDER[i])) return i;
  }
  return 50;
}

module.exports = {
  computeLayout,
  buildEdgeGeometry,
  curveSanityScore,
  resolveLabelCollisions,
  findLabelAnchor,
  estimateLabelWidth,
  labelDisplayText,
  calculateConnectionPoints,
  calculateControlPoints,
  cubicBezierBounds,
  calculateMarkerBounds,
  calculateEdgeVisualBounds,
  cubicPointAt,
  generatePathCurve,
  orderNodesByBarycenter,
  computePortOffsets,
  DEFAULT_CONFIG,
};
