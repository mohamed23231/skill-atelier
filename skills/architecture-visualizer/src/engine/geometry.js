(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ArchVizGeometry = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LABEL_T_CANDIDATES = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8];
  const LABEL_OFFSETS = [0, -10, 10, -28, 26, -46, 44, -64, 62];
  const LABEL_HEIGHT = 18;
  const LABEL_CLEARANCE = 10;
  const EDGE_END_GAP = 10;
  const LABEL_MAX_CHARS = 20;
  const ROUTE_SAMPLES = 48;
  // Must match nodeShape() in template.html: queue/topic chevron notch depth
  const CHEVRON_NOTCH = 16;
  const CYLINDER_R = 12;
  const PILL_RX = 0.5; // actor: rx = height * 0.5 (stadium shape)
  const WORKER_RX = 22;
  const DEFAULT_RX = 10;

  function nodeCornerRadius(node) {
    const h = node.height || 0;
    if (node.type === 'worker' || node.type === 'cloud_function') return Math.min(WORKER_RX, h / 2);
    return Math.min(DEFAULT_RX, h / 2);
  }

  // Right-face x of the *drawn* shape outline at a vertical offset from the face centre.
  // Rectangular bounds overstate the width of chevrons, pills and rounded cards.
  function shapeRightX(node, offset) {
    const w = node.width || 0;
    const h = node.height || 0;
    const dy = Math.min(Math.abs(offset || 0), h / 2);
    if (node.type === 'queue' || node.type === 'topic') {
      const notch = Math.min(CHEVRON_NOTCH, w * 0.25);
      return h > 0 ? node.x + w - notch * (dy / (h / 2)) : node.x + w;
    }
    if (node.type === 'actor') {
      const r = h * PILL_RX;
      return node.x + w - r + Math.sqrt(Math.max(0, r * r - dy * dy));
    }
    const rx = nodeCornerRadius(node);
    const straight = h / 2 - rx;
    if (dy > straight && rx > 0) {
      const d = dy - straight;
      return node.x + w - rx + Math.sqrt(Math.max(0, rx * rx - d * d));
    }
    return node.x + w;
  }

  // Left-face x of the drawn shape outline at a vertical offset from the face centre.
  function shapeLeftX(node, offset) {
    const h = node.height || 0;
    const dy = Math.min(Math.abs(offset || 0), h / 2);
    if (node.type === 'queue' || node.type === 'topic') return node.x; // flat rear edge
    if (node.type === 'actor') {
      const r = h * PILL_RX;
      return node.x + r - Math.sqrt(Math.max(0, r * r - dy * dy));
    }
    const rx = nodeCornerRadius(node);
    const straight = h / 2 - rx;
    if (dy > straight && rx > 0) {
      const d = dy - straight;
      return node.x + rx - Math.sqrt(Math.max(0, rx * rx - d * d));
    }
    return node.x;
  }

  // Top/bottom-face y of the drawn shape outline at a horizontal offset from the centre.
  // Only the cylinder (database/storage) deviates measurably from the rectangle.
  function shapeTopY(node, offset) {
    const w = node.width || 0;
    if ((node.type === 'database' || node.type === 'storage') && w > 0) {
      const dx = Math.min(Math.abs(offset || 0), w / 2);
      const rise = 0.75 * CYLINDER_R * Math.sqrt(Math.max(0, 1 - ((2 * dx) / w) ** 2));
      return node.y + CYLINDER_R - rise;
    }
    return node.y;
  }

  function shapeBottomY(node, offset) {
    const w = node.width || 0;
    const h = node.height || 0;
    if ((node.type === 'database' || node.type === 'storage') && w > 0) {
      const dx = Math.min(Math.abs(offset || 0), w / 2);
      const rise = 0.75 * CYLINDER_R * Math.sqrt(Math.max(0, 1 - ((2 * dx) / w) ** 2));
      return node.y + h - CYLINDER_R + rise;
    }
    return node.y + h;
  }

  // Clamp a horizontal port offset so top/bottom connections stay on the flat
  // part of chevron (notched right side) and pill/rounded (corner caps) shapes.
  function shapeHorizontalPortOffset(node, offset) {
    const w = node.width || 0;
    const h = node.height || 0;
    let insetLeft = 0;
    let insetRight = 0;
    if (node.type === 'queue' || node.type === 'topic') {
      insetRight = Math.min(CHEVRON_NOTCH, w * 0.25);
    } else if (node.type === 'actor') {
      insetLeft = h * PILL_RX;
      insetRight = insetLeft;
    } else {
      insetLeft = nodeCornerRadius(node);
      insetRight = insetLeft;
    }
    const minOffset = insetLeft - w / 2;
    const maxOffset = w / 2 - insetRight;
    return Math.max(minOffset, Math.min(maxOffset, offset || 0));
  }

  function labelDisplayText(text) {
    const value = String(text || '');
    return value.length <= LABEL_MAX_CHARS ? value : `${value.slice(0, LABEL_MAX_CHARS - 1)}…`;
  }

  function estimateLabelWidth(text) {
    return Math.max(labelDisplayText(text).length * 6.5, 40);
  }

  function overlapArea(box, node) {
    const actualDx = Math.min(box.right, node.x + node.width) - Math.max(box.left, node.x);
    const actualDy = Math.min(box.bottom, node.y + node.height) - Math.max(box.top, node.y);
    if (actualDx > 0 && actualDy > 0) {
      return actualDx * actualDy * (node.weight || 10000);
    }
    const clearance = typeof node.clearance === 'number' ? node.clearance : node.width <= 32 && node.height <= 32 ? 0 : LABEL_CLEARANCE;
    if (clearance === 0) return 0;
    const dx = Math.min(box.right, node.x + node.width + clearance) - Math.max(box.left, node.x - clearance);
    const dy = Math.min(box.bottom, node.y + node.height + clearance) - Math.max(box.top, node.y - clearance);
    if (dx <= 0 || dy <= 0) return 0;
    return dx * dy * (node.clearanceWeight || 1);
  }

  function findLabelAnchor(points, controls, obstacles, labelWidth) {
    const halfWidth = labelWidth / 2;
    const halfHeight = LABEL_HEIGHT / 2;
    let best = null;

    for (let i = 0; i < LABEL_T_CANDIDATES.length; i++) {
      const point = cubicPointAt(LABEL_T_CANDIDATES[i], points, controls);

      for (let k = 0; k < LABEL_OFFSETS.length; k++) {
        const centerY = point.y + LABEL_OFFSETS[k];
        const box = {
          left: point.x - halfWidth,
          right: point.x + halfWidth,
          top: centerY - halfHeight,
          bottom: centerY + halfHeight,
        };

        let collision = 0;
        for (let j = 0; j < obstacles.length; j++) {
          const area = overlapArea(box, obstacles[j]);
          if (area > 0) {
            collision += area * (obstacles[j].weight || 1);
          }
          if (best !== null && collision >= best.collision) break;
        }

        if (collision === 0) {
          return { x: point.x, y: centerY, collision: 0, offset: LABEL_OFFSETS[k] };
        }
        if (best === null || collision < best.collision) {
          best = { x: point.x, y: centerY, collision, offset: LABEL_OFFSETS[k] };
        }
      }
    }

    const LABEL_OFFSETS_X = [30, -30, 60, -60, 90, -90, 120, -120, 160, -160, 200, -200];
    for (let i = 0; i < LABEL_T_CANDIDATES.length; i++) {
      const point = cubicPointAt(LABEL_T_CANDIDATES[i], points, controls);

      for (let k = 0; k < LABEL_OFFSETS_X.length; k++) {
        const centerX = point.x + LABEL_OFFSETS_X[k];
        const box = {
          left: centerX - halfWidth,
          right: centerX + halfWidth,
          top: point.y - halfHeight,
          bottom: point.y + halfHeight,
        };

        let collision = 0;
        for (let j = 0; j < obstacles.length; j++) {
          const area = overlapArea(box, obstacles[j]);
          if (area > 0) {
            collision += area * (obstacles[j].weight || 1);
          }
          if (best !== null && collision >= best.collision) break;
        }

        if (collision === 0) {
          return { x: centerX, y: point.y, collision: 0, offset: LABEL_OFFSETS_X[k] };
        }
        if (best === null || collision < best.collision) {
          best = { x: centerX, y: point.y, collision, offset: LABEL_OFFSETS_X[k] };
        }
      }
    }

    return best;
  }

  function resolveLabelCollisions(edges, nodes, boundaryHeaderBoxes) {
    const labeledEdges = edges.filter((e) => e.points && e.controls && typeof e.labelWidth === 'number' && e.labelWidth > 0);
    if (labeledEdges.length <= 1) return;

    const MAX_PASSES = 6;
    const halfH = LABEL_HEIGHT / 2;

    const getLabelBox = (edge) => {
      const halfW = edge.labelWidth / 2;
      return {
        left: edge.labelX - halfW,
        right: edge.labelX + halfW,
        top: edge.labelY - halfH,
        bottom: edge.labelY + halfH,
      };
    };

    const boxesOverlap = (b1, b2) => {
      return b1.left < b2.right && b1.right > b2.left && b1.top < b2.bottom && b1.bottom > b2.top;
    };

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      let movedAny = false;

      for (let i = 0; i < labeledEdges.length; i++) {
        for (let j = i + 1; j < labeledEdges.length; j++) {
          const e1 = labeledEdges[i];
          const e2 = labeledEdges[j];

          const b1 = getLabelBox(e1);
          const b2 = getLabelBox(e2);

          if (boxesOverlap(b1, b2)) {
            const dist = Math.hypot(e2.points.x2 - e2.points.x1, e2.points.y2 - e2.points.y1);
            const epR1 = Math.min(14, Math.max(4, dist * 0.25));
            const epR2 = Math.min(16, Math.max(4, dist * 0.25));
            const endpointZones = [
              { x: e2.points.x1 - epR1, y: e2.points.y1 - epR1, width: epR1 * 2, height: epR1 * 2, clearance: 0, weight: 100 },
              { x: e2.points.x2 - epR2, y: e2.points.y2 - epR2, width: epR2 * 2, height: epR2 * 2, clearance: 0, weight: 100 },
            ];

            const otherLabels = labeledEdges
              .filter((e) => e.id !== e2.id)
              .map((e) => ({
                x: e.labelX - e.labelWidth / 2,
                y: e.labelY - halfH,
                width: e.labelWidth,
                height: LABEL_HEIGHT,
              }));

            const obstacles = [...nodes, ...boundaryHeaderBoxes, ...endpointZones, ...otherLabels];

            const newAnchor = findLabelAnchor(e2.points, e2.controls, obstacles, e2.labelWidth);
            if (newAnchor && (Math.abs(newAnchor.x - e2.labelX) > 0.01 || Math.abs(newAnchor.y - e2.labelY) > 0.01)) {
              e2.labelX = newAnchor.x;
              e2.labelY = newAnchor.y;
              movedAny = true;
            } else {
              const shift = LABEL_HEIGHT + 4;
              const dir = e2.labelY >= e1.labelY ? 1 : -1;
              e2.labelY += dir * shift;
              movedAny = true;
            }
          }
        }
      }

      if (!movedAny) break;
    }
  }

  function channelRoute(source, target, span, band, isLR, exit, sourcePortOffset = 0, targetPortOffset = 0) {
    const clearance = 40 + span * 12;

    if (isLR) {
      const routeAbove = (source.y + target.y) / 2 <= (band.top + band.bottom) / 2;
      const channelY = routeAbove ? band.top - clearance : band.bottom + clearance;

      if (exit === 'face') {
        const x1 = source.x + source.width * 0.5;
        const x2 = target.x + target.width * 0.5;
        const y1 = routeAbove ? shapeTopY(source, 0) : shapeBottomY(source, 0);
        const y2 = routeAbove ? shapeTopY(target, 0) - EDGE_END_GAP : shapeBottomY(target, 0) + EDGE_END_GAP;
        const approach = Math.max(50, Math.min(220, Math.hypot(x2 - x1, y2 - y1) * 0.35));
        return {
          points: { x1, y1, x2, y2, kind: 'skip', sourceFace: routeAbove ? 'top' : 'bottom', targetFace: routeAbove ? 'top' : 'bottom' },
          controls: {
            cx1: x1,
            cy1: routeAbove ? Math.min(channelY, y1 - approach) : Math.max(channelY, y1 + approach),
            cx2: x2,
            cy2: routeAbove ? Math.min(channelY, y2 - approach) : Math.max(channelY, y2 + approach),
          },
        };
      }

      const x1 = shapeRightX(source, sourcePortOffset);
      const y1 = source.y + source.height * 0.5 + sourcePortOffset;
      const x2 = shapeLeftX(target, targetPortOffset) - EDGE_END_GAP;
      const y2 = target.y + target.height * 0.5 + targetPortOffset;
      const approach = Math.max(40, Math.min(220, Math.hypot(x2 - x1, y2 - y1) * 0.35));
      return {
        points: { x1, y1, x2, y2, kind: 'skip', sourceFace: 'right', targetFace: 'left' },
        controls: { cx1: x1, cy1: channelY, cx2: x2 - approach, cy2: y2 },
      };
    }

    const routeLeft = (source.x + target.x) / 2 <= (band.left + band.right) / 2;
    const channelX = routeLeft ? band.left - clearance : band.right + clearance;

    if (exit === 'face') {
      const x1 = source.x + source.width * 0.5;
      const y1 = shapeBottomY(source, 0);
      const x2 = target.x + target.width * 0.5;
      const y2 = shapeTopY(target, 0) - EDGE_END_GAP;
      const approach = Math.max(40, Math.min(220, Math.hypot(x2 - x1, y2 - y1) * 0.35));
      return {
        points: { x1, y1, x2, y2, kind: 'skip', sourceFace: 'bottom', targetFace: 'top' },
        controls: { cx1: channelX, cy1: y1, cx2: x2, cy2: y2 - approach },
      };
    }

    const x1 = routeLeft ? shapeLeftX(source, sourcePortOffset) : shapeRightX(source, sourcePortOffset);
    const y1 = source.y + source.height * 0.5 + sourcePortOffset;
    const x2 = routeLeft ? shapeLeftX(target, targetPortOffset) - EDGE_END_GAP : shapeRightX(target, targetPortOffset) + EDGE_END_GAP;
    const y2 = target.y + target.height * 0.5 + targetPortOffset;
    const approach = Math.max(50, Math.min(220, Math.hypot(x2 - x1, y2 - y1) * 0.35));
    return {
      points: { x1, y1, x2, y2, kind: 'skip', sourceFace: routeLeft ? 'left' : 'right', targetFace: routeLeft ? 'left' : 'right' },
      controls: {
        cx1: routeLeft ? Math.min(channelX, x1 - approach) : Math.max(channelX, x1 + approach),
        cy1: y1,
        cx2: routeLeft ? Math.min(channelX, x2 - approach) : Math.max(channelX, x2 + approach),
        cy2: y2,
      },
    };
  }

  function routeCollisionScore(points, controls, nodes, sourceId, targetId) {
    let score = 0;
    for (let i = 1; i < ROUTE_SAMPLES; i++) {
      const p = cubicPointAt(i / ROUTE_SAMPLES, points, controls);
      for (let j = 0; j < nodes.length; j++) {
        const n = nodes[j];
        if (n.id === sourceId || n.id === targetId || typeof n.width !== 'number') continue;
        if (p.x > n.x && p.x < n.x + n.width && p.y > n.y && p.y < n.y + n.height) {
          score++;
          break;
        }
      }
    }
    return score;
  }

  function curveSanityScore(points, controls) {
    let score = 0;
    const dist = Math.hypot(points.x2 - points.x1, points.y2 - points.y1);
    const minX = Math.min(points.x1, points.x2);
    const maxX = Math.max(points.x1, points.x2);
    const minY = Math.min(points.y1, points.y2);
    const maxY = Math.max(points.y1, points.y2);
    const endThreshold = Math.min(12, dist * 0.3);

    let prev = null;
    for (let i = 0; i <= ROUTE_SAMPLES; i++) {
      const t = i / ROUTE_SAMPLES;
      const p = cubicPointAt(t, points, controls);
      if (prev) {
        const vx = p.x - prev.x;
        const vy = p.y - prev.y;
        if (prev.v) {
          const dot = vx * prev.v.x + vy * prev.v.y;
          if (dot < -1e-6) score++;
        }
        if (vx !== 0 || vy !== 0) prev.v = { x: vx, y: vy };
      } else {
        prev = { x: p.x, y: p.y, v: null };
      }

      if (t < 0.7) {
        const dEnd = Math.hypot(p.x - points.x2, p.y - points.y2);
        if (dEnd <= endThreshold) score++;
      }

      const dOut = Math.hypot(Math.max(0, minX - p.x, p.x - maxX), Math.max(0, minY - p.y, p.y - maxY));
      if (dOut > 1.2 * dist) score++;
    }
    return score;
  }

  function solveRoots(a, b, c) {
    if (Math.abs(a) < 1e-9) {
      if (Math.abs(b) < 1e-9) return [];
      return [-c / b];
    }
    const disc = b * b - 4 * a * c;
    if (disc < 0) return [];
    if (disc === 0) return [-b / (2 * a)];
    const sqrtDisc = Math.sqrt(disc);
    return [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];
  }

  function cubicVal(t, p0, p1, p2, p3) {
    const mt = 1 - t;
    return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
  }

  function cubicBezierBounds(p0, p1, p2, p3) {
    let minX = Math.min(p0.x, p3.x);
    let maxX = Math.max(p0.x, p3.x);
    let minY = Math.min(p0.y, p3.y);
    let maxY = Math.max(p0.y, p3.y);

    const ax = 3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x);
    const bx = 6 * (p0.x - 2 * p1.x + p2.x);
    const cx = 3 * (p1.x - p0.x);
    solveRoots(ax, bx, cx).forEach((t) => {
      if (t > 0 && t < 1) {
        const x = cubicVal(t, p0.x, p1.x, p2.x, p3.x);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
      }
    });

    const ay = 3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y);
    const by = 6 * (p0.y - 2 * p1.y + p2.y);
    const cy = 3 * (p1.y - p0.y);
    solveRoots(ay, by, cy).forEach((t) => {
      if (t > 0 && t < 1) {
        const y = cubicVal(t, p0.y, p1.y, p2.y, p3.y);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    });

    return {
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
  }

  function calculateMarkerBounds(endpoint, tangent) {
    const len = Math.hypot(tangent.x, tangent.y) || 1;
    const ux = tangent.x / len;
    const uy = tangent.y / len;
    const px = -uy;
    const py = ux;
    const tipX = endpoint.x;
    const tipY = endpoint.y;
    const baseDist = 10.5;
    const halfWidth = 5.25;
    const baseX = tipX - ux * baseDist;
    const baseY = tipY - uy * baseDist;
    const w1x = baseX + px * halfWidth;
    const w1y = baseY + py * halfWidth;
    const w2x = baseX - px * halfWidth;
    const w2y = baseY - py * halfWidth;

    const minX = round(Math.min(tipX, w1x, w2x));
    const maxX = round(Math.max(tipX, w1x, w2x));
    const minY = round(Math.min(tipY, w1y, w2y));
    const maxY = round(Math.max(tipY, w1y, w2y));
    return {
      minX,
      minY,
      maxX,
      maxY,
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width: round(maxX - minX),
      height: round(maxY - minY),
    };
  }

  function calculateEdgeVisualBounds(pathBounds, markerBounds, labelBounds) {
    let minX = Math.min(pathBounds.minX, markerBounds.minX);
    let maxX = Math.max(pathBounds.maxX, markerBounds.maxX);
    let minY = Math.min(pathBounds.minY, markerBounds.minY);
    let maxY = Math.max(pathBounds.maxY, markerBounds.maxY);

    if (labelBounds) {
      minX = Math.min(minX, labelBounds.left);
      maxX = Math.max(maxX, labelBounds.right);
      minY = Math.min(minY, labelBounds.top);
      maxY = Math.max(maxY, labelBounds.bottom);
    }

    return {
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
  }

  function buildEdgeGeometry(source, target, isLR, options = {}) {
    const sourcePortOffset = (options && options.sourcePortOffset) || 0;
    const targetPortOffset = (options && options.targetPortOffset) || 0;
    const basePoints = calculateConnectionPoints(source, target, isLR, sourcePortOffset, targetPortOffset);
    if (options && options.isReciprocal) {
      basePoints.isReciprocal = true;
    }
    const candidates = [{ points: basePoints, controls: calculateControlPoints(basePoints, isLR) }];

    const span = typeof source.rank === 'number' && typeof target.rank === 'number' ? Math.abs(target.rank - source.rank) : 0;

    if (basePoints.kind === 'forward' && span >= 2 && options && options.band) {
      candidates.push(channelRoute(source, target, span, options.band, isLR, 'side', sourcePortOffset, targetPortOffset));
      candidates.push(channelRoute(source, target, span, options.band, isLR, 'face', sourcePortOffset, targetPortOffset));
    }

    if (basePoints.kind === 'sibling') {
      const { x1, y1, x2, y2 } = basePoints;
      const dist = Math.hypot(x2 - x1, y2 - y1);
      const maxReach = isLR ? source.width * 0.5 + 40 : source.height * 0.5 + 40;
      const reach = Math.min(maxReach, dist * 0.5);
      const detour = basePoints.detour || 0;
      const approach = detour > 0 ? Math.max(90, Math.min(140, dist * 0.65)) : Math.max(18, Math.min(28, dist * 0.75));
      [1, -1].forEach((side) => {
        candidates.push({
          points: basePoints,
          controls: isLR
            ? { cx1: x1 + side * reach * 1.7, cy1: y1 + (y2 - y1) * 0.25, cx2: x2, cy2: y2 - Math.sign(y2 - y1 || 1) * approach }
            : { cx1: x1 + (x2 - x1) * 0.25, cy1: y1 + side * reach * 1.7, cx2: x2 - Math.sign(x2 - x1 || 1) * approach, cy2: y2 },
        });
      });
    }

    let points = candidates[0].points;
    let controls = candidates[0].controls;

    if (candidates.length > 1) {
      const candidateNodes = Array.isArray(options.nodes) && options.nodes.length > 0 ? options.nodes : [];
      let bestCandidate = candidates[0];
      let bestSanity = curveSanityScore(candidates[0].points, candidates[0].controls);
      let bestCollision = candidateNodes.length > 0 ? routeCollisionScore(candidates[0].points, candidates[0].controls, candidateNodes, source.id, target.id) : 0;

      for (let i = 1; i < candidates.length; i++) {
        const candidate = candidates[i];
        const sanity = curveSanityScore(candidate.points, candidate.controls);
        const collision = candidateNodes.length > 0 ? routeCollisionScore(candidate.points, candidate.controls, candidateNodes, source.id, target.id) : 0;

        let better = false;
        if (sanity === 0 && bestSanity > 0) {
          better = true;
        } else if (sanity > 0 && bestSanity === 0) {
          better = false;
        } else if (sanity === 0 && bestSanity === 0) {
          better = collision < bestCollision;
        } else {
          if (sanity < bestSanity) {
            better = true;
          } else if (sanity === bestSanity) {
            better = collision < bestCollision;
          }
        }

        if (better) {
          bestCandidate = candidate;
          bestSanity = sanity;
          bestCollision = collision;
        }
      }

      points = bestCandidate.points;
      controls = bestCandidate.controls;
    }

    const path = buildPath(points, controls);

    const obstacles = Array.isArray(options.obstacles) ? options.obstacles : [];
    const labelWidth = typeof options.labelWidth === 'number' ? options.labelWidth : estimateLabelWidth(options.label);

    const edgeDist = Math.hypot(points.x2 - points.x1, points.y2 - points.y1);
    const epR1 = Math.min(14, Math.max(4, edgeDist * 0.25));
    const epR2 = Math.min(16, Math.max(4, edgeDist * 0.25));
    const endpointZones = [
      { x: points.x1 - epR1, y: points.y1 - epR1, width: epR1 * 2, height: epR1 * 2, clearance: 0, weight: 100 },
      { x: points.x2 - epR2, y: points.y2 - epR2, width: epR2 * 2, height: epR2 * 2, clearance: 0, weight: 100 },
    ];

    const anchor = findLabelAnchor(points, controls, [...obstacles, ...endpointZones], labelWidth);

    if (Array.isArray(options.placedLabels) && labelWidth > 0) {
      options.placedLabels.push({
        x: anchor.x - labelWidth / 2,
        y: anchor.y - LABEL_HEIGHT / 2,
        width: labelWidth,
        height: LABEL_HEIGHT,
      });
    }

    const endpoint = { x: points.x2, y: points.y2 };
    const segments = [
      { type: 'M', x: points.x1, y: points.y1 },
      { type: 'C', cx1: controls.cx1, cy1: controls.cy1, cx2: controls.cx2, cy2: controls.cy2, x: points.x2, y: points.y2 },
    ];
    const labelAnchor = { x: anchor.x, y: anchor.y };
    const labelBounds = {
      left: round(anchor.x - labelWidth / 2),
      right: round(anchor.x + labelWidth / 2),
      top: round(anchor.y - LABEL_HEIGHT / 2),
      bottom: round(anchor.y + LABEL_HEIGHT / 2),
      width: labelWidth,
      height: LABEL_HEIGHT,
      minX: round(anchor.x - labelWidth / 2),
      maxX: round(anchor.x + labelWidth / 2),
      minY: round(anchor.y - LABEL_HEIGHT / 2),
      maxY: round(anchor.y + LABEL_HEIGHT / 2),
    };

    const tanX = round(3 * (points.x2 - controls.cx2));
    const tanY = round(3 * (points.y2 - controls.cy2));
    const tanAngle = round((Math.atan2(tanY, tanX) * 180) / Math.PI);
    const terminalTangent = { x: tanX, y: tanY, angle: tanAngle };

    const markerBounds = calculateMarkerBounds(endpoint, terminalTangent);
    const pathBounds = cubicBezierBounds({ x: points.x1, y: points.y1 }, { x: controls.cx1, y: controls.cy1 }, { x: controls.cx2, y: controls.cy2 }, { x: points.x2, y: points.y2 });
    const totalVisualBounds = calculateEdgeVisualBounds(pathBounds, markerBounds, labelWidth > 0 ? labelBounds : null);

    return {
      points,
      controls,
      path,
      segments,
      endpoint,
      labelX: anchor.x,
      labelY: anchor.y,
      labelWidth,
      labelAnchor,
      labelBounds,
      terminalTangent,
      markerBounds,
      pathBounds,
      totalVisualBounds,
    };
  }

  function calculateConnectionPoints(source, target, isLR, sourcePortOffset = 0, targetPortOffset = 0) {
    if (source.id === target.id) {
      const selfSourceDy = -source.height * 0.2 + sourcePortOffset;
      const selfTargetDy = source.height * 0.2 + targetPortOffset;
      return {
        x1: shapeRightX(source, selfSourceDy),
        y1: source.y + source.height * 0.3 + sourcePortOffset,
        x2: shapeRightX(source, selfTargetDy) + EDGE_END_GAP,
        y2: source.y + source.height * 0.7 + targetPortOffset,
        kind: 'self',
        sourceFace: 'right',
        targetFace: 'right',
      };
    }

    if (isLR) {
      const sameColumn = Math.abs(target.x - source.x) < source.width * 0.5;
      if (sameColumn) {
        const downward = target.y >= source.y;
        const sourceOff = shapeHorizontalPortOffset(source, sourcePortOffset);
        const targetOff = shapeHorizontalPortOffset(target, targetPortOffset);
        return {
          x1: source.x + source.width * 0.5 + sourceOff,
          y1: downward ? shapeBottomY(source, sourceOff) : shapeTopY(source, sourceOff),
          x2: target.x + target.width * 0.5 + targetOff,
          y2: downward ? shapeTopY(target, targetOff) - EDGE_END_GAP : shapeBottomY(target, targetOff) + EDGE_END_GAP,
          kind: 'sibling',
          sourceFace: downward ? 'bottom' : 'top',
          targetFace: downward ? 'top' : 'bottom',
          detour: Math.abs(target.y - source.y) > source.height * 1.8 ? source.width * 0.5 + 30 : 0,
        };
      }
      if (target.x + target.width < source.x) {
        return {
          x1: shapeLeftX(source, sourcePortOffset),
          y1: source.y + source.height * 0.5 + sourcePortOffset,
          x2: shapeRightX(target, targetPortOffset) + EDGE_END_GAP,
          y2: target.y + target.height * 0.5 + targetPortOffset,
          kind: 'backward',
          sourceFace: 'left',
          targetFace: 'right',
        };
      }
      return {
        x1: shapeRightX(source, sourcePortOffset),
        y1: source.y + source.height * 0.5 + sourcePortOffset,
        x2: shapeLeftX(target, targetPortOffset) - EDGE_END_GAP,
        y2: target.y + target.height * 0.5 + targetPortOffset,
        kind: 'forward',
        sourceFace: 'right',
        targetFace: 'left',
      };
    }

    const sameRow = Math.abs(target.y - source.y) < source.height * 0.5;
    if (sameRow) {
      const rightward = target.x >= source.x;
      return {
        x1: rightward ? shapeRightX(source, sourcePortOffset) : shapeLeftX(source, sourcePortOffset),
        y1: source.y + source.height * 0.5 + sourcePortOffset,
        x2: rightward ? shapeLeftX(target, targetPortOffset) - EDGE_END_GAP : shapeRightX(target, targetPortOffset) + EDGE_END_GAP,
        y2: target.y + target.height * 0.5 + targetPortOffset,
        kind: 'sibling',
        sourceFace: rightward ? 'right' : 'left',
        targetFace: rightward ? 'left' : 'right',
        detour: Math.abs(target.x - source.x) > source.width * 1.8 ? source.height * 0.5 + 30 : 0,
      };
    }
    if (target.y + target.height < source.y) {
      const sourceOff = shapeHorizontalPortOffset(source, sourcePortOffset);
      const targetOff = shapeHorizontalPortOffset(target, targetPortOffset);
      return {
        x1: source.x + source.width * 0.5 + sourceOff,
        y1: shapeTopY(source, sourceOff),
        x2: target.x + target.width * 0.5 + targetOff,
        y2: shapeBottomY(target, targetOff) + EDGE_END_GAP,
        kind: 'backward',
        sourceFace: 'top',
        targetFace: 'bottom',
      };
    }
    const sourceOff = shapeHorizontalPortOffset(source, sourcePortOffset);
    const targetOff = shapeHorizontalPortOffset(target, targetPortOffset);
    return {
      x1: source.x + source.width * 0.5 + sourceOff,
      y1: shapeBottomY(source, sourceOff),
      x2: target.x + target.width * 0.5 + targetOff,
      y2: shapeTopY(target, targetOff) - EDGE_END_GAP,
      kind: 'forward',
      sourceFace: 'bottom',
      targetFace: 'top',
    };
  }

  function calculateControlPoints(points, isLR) {
    const { x1, y1, x2, y2, kind } = points;
    const dist = Math.hypot(x2 - x1, y2 - y1);

    if (kind === 'self') {
      const loop = 70;
      const approach = Math.max(35, Math.min(50, dist * 0.8));
      return { cx1: x1 + loop, cy1: y1 - 10, cx2: x2 + approach, cy2: y2 };
    }

    if (kind === 'backward') {
      const approach = Math.max(40, Math.min(200, dist * 0.38));
      if (isLR) {
        const reach = Math.max(Math.abs(x2 - x1) * 0.45, 50);
        const bow = points.isReciprocal ? 36 : 0;
        return { cx1: x1 - reach, cy1: y1 + bow, cx2: x2 + approach, cy2: y2 };
      }
      const reach = Math.max(Math.abs(y2 - y1) * 0.45, 50);
      const bow = points.isReciprocal ? 36 : 0;
      return { cx1: x1 + bow, cy1: y1 - reach, cx2: x2, cy2: y2 + approach };
    }

    if (kind === 'sibling') {
      const detour = points.detour || 0;
      if (detour > 0) {
        const approach = Math.max(90, Math.min(140, dist * 0.65));
        if (isLR) {
          const cy2 = y2 - Math.sign(y2 - y1 || 1) * approach;
          return { cx1: x1 + detour * 1.7, cy1: y1 + (y2 - y1) * 0.25, cx2: x2, cy2 };
        }
        const cx2 = x2 - Math.sign(x2 - x1 || 1) * approach;
        return { cx1: x1 + (x2 - x1) * 0.25, cy1: y1 - detour * 1.7, cx2, cy2: y2 };
      }

      if (isLR) {
        const signY = Math.sign(y2 - y1 || 1);
        const spanY = Math.abs(y2 - y1);
        const bowY = Math.min(spanY * 0.35, 14);
        const approachY = Math.min(spanY * 0.45, 18);
        const cy1 = y1 + signY * bowY;
        const cy2 = y2 - signY * approachY;
        return { cx1: x2, cy1: round(cy1), cx2: x2, cy2: round(cy2) };
      }

      const signX = Math.sign(x2 - x1 || 1);
      const spanX = Math.abs(x2 - x1);
      const bowX = Math.min(spanX * 0.35, 14);
      const approachX = Math.min(spanX * 0.45, 18);
      const cx1 = x1 + signX * bowX;
      const cx2 = x2 - signX * approachX;
      return { cx1: round(cx1), cy1: y2, cx2: round(cx2), cy2: y2 };
    }

    const approach = Math.max(40, Math.min(200, dist * 0.38));
    if (isLR) {
      const curvature = Math.max(Math.abs(x2 - x1) * 0.45, 40);
      return { cx1: x1 + curvature, cy1: y1, cx2: x2 - approach, cy2: y2 };
    }
    const curvature = Math.max(Math.abs(y2 - y1) * 0.45, 40);
    return { cx1: x1, cy1: y1 + curvature, cx2: x2, cy2: y2 - approach };
  }

  function buildPath(points, controls) {
    return `M ${round(points.x1)} ${round(points.y1)} C ${round(controls.cx1)} ${round(controls.cy1)}, ${round(controls.cx2)} ${round(controls.cy2)}, ${round(points.x2)} ${round(points.y2)}`;
  }

  function cubicPointAt(t, points, controls) {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return {
      x: round(a * points.x1 + b * controls.cx1 + c * controls.cx2 + d * points.x2),
      y: round(a * points.y1 + b * controls.cy1 + c * controls.cy2 + d * points.y2),
    };
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function generatePathCurve(x1, y1, x2, y2, isLR, isBackward) {
    const points = { x1, y1, x2, y2, kind: isBackward ? 'backward' : 'forward' };
    return buildPath(points, calculateControlPoints(points, isLR));
  }

  return {
    LABEL_HEIGHT,
    EDGE_END_GAP,
    CHEVRON_NOTCH,
    labelDisplayText,
    estimateLabelWidth,
    findLabelAnchor,
    resolveLabelCollisions,
    curveSanityScore,
    buildEdgeGeometry,
    calculateConnectionPoints,
    calculateControlPoints,
    cubicBezierBounds,
    calculateMarkerBounds,
    calculateEdgeVisualBounds,
    cubicPointAt,
    generatePathCurve,
    shapeRightX,
    shapeLeftX,
    shapeTopY,
    shapeBottomY,
    shapeHorizontalPortOffset,
    round,
  };
});
