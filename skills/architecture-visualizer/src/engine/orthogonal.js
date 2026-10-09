(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.ArchVizOrthogonal = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const HEADER_HEIGHT = 36;
  const byId = (a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const direction = (a, b) => a.y === b.y ? 0 : 1;
  const rect = (n, m) => ({ left: n.x - m, right: n.x + n.width + m, top: n.y - m, bottom: n.y + n.height + m });
  const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  function intersects(a, b, box) {
    if (a.y === b.y) {
      return a.y > box.top && a.y < box.bottom && Math.min(a.x, b.x) < box.right && Math.max(a.x, b.x) > box.left;
    }
    return a.x > box.left && a.x < box.right && Math.min(a.y, b.y) < box.bottom && Math.max(a.y, b.y) > box.top;
  }

  // An arrowhead takes its angle from the last segment, so a route must leave and enter a card
  // with a straight stub at least minStub long. When the stub is shorter, slide the parallel run
  // before it away from the card (moving both of its ends keeps it axis-aligned), unless that
  // would cut through another card.
  function ensureStubs(points, boxes, edge, minStub) {
    const clear = (pts, from, to) => {
      for (let i = from; i < to; i++) {
        for (const box of boxes) {
          if ((i === 0 && box.id === edge.source) || (i === pts.length - 2 && box.id === edge.target)) continue;
          if (intersects(pts[i], pts[i + 1], box)) return false;
        }
      }
      return true;
    };
    const fixEnd = (pts) => {
      const n = pts.length;
      if (n < 4) return pts;
      const a = pts[n - 2];
      const b = pts[n - 1];
      const len = distance(a, b);
      if (len >= minStub || len === 0) return pts;
      const dx = Math.sign(b.x - a.x);
      const dy = Math.sign(b.y - a.y);
      const shift = minStub - len;
      const next = pts.map(p => ({ x: p.x, y: p.y }));
      next[n - 2] = { x: a.x - dx * shift, y: a.y - dy * shift };
      const shifted = { x: next[n - 3].x - dx * shift, y: next[n - 3].y - dy * shift };
      if (direction(pts[n - 4], pts[n - 3]) === direction(a, b)) {
        next[n - 3] = shifted;
      } else {
        // Keep the preceding perpendicular run intact and bridge to the shifted run.
        next.splice(n - 2, 0, shifted);
      }
      return clear(next, Math.max(0, n - 4), next.length - 1) ? next : pts;
    };
    const end = fixEnd(points);
    return fixEnd(end.slice().reverse()).reverse();
  }

  function simplify(points) {
    const result = [];
    points.forEach(p => {
      if (result.length && distance(result[result.length - 1], p) === 0) return;
      while (result.length > 1) {
        const a = result[result.length - 2];
        const b = result[result.length - 1];
        if (direction(a, b) !== direction(b, p) || distance(a, p) !== distance(a, b) + distance(b, p)) break;
        result.pop();
      }
      result.push({ x: p.x, y: p.y });
    });
    return result;
  }

  function heapPush(heap, item) {
    heap.push(item);
    let i = heap.length - 1;
    while (i) {
      const parent = (i - 1) >> 1;
      if (!less(item, heap[parent])) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = item;
  }

  function less(a, b) {
    if (a.shortest) return a.length < b.length || (a.length === b.length && (a.bends < b.bends || (a.bends === b.bends && a.key < b.key)));
    return a.bends < b.bends || (a.bends === b.bends && (a.length < b.length || (a.length === b.length && a.key < b.key)));
  }

  function heapPop(heap) {
    const first = heap[0];
    const last = heap.pop();
    if (!heap.length) return first;
    let i = 0;
    while (i * 2 + 1 < heap.length) {
      let child = i * 2 + 1;
      if (child + 1 < heap.length && less(heap[child + 1], heap[child])) child++;
      if (!less(heap[child], last)) break;
      heap[i] = heap[child];
      i = child;
    }
    heap[i] = last;
    return first;
  }

  // A rectilinear visibility grid, with bends taking priority over distance.
  function search(start, end, xs, ys, obstacles, channels, rule) {
    const nx = xs.length;
    const ny = ys.length;
    const sx = xs.indexOf(start.x);
    const sy = ys.indexOf(start.y);
    const ex = xs.indexOf(end.x);
    const ey = ys.indexOf(end.y);
    const records = new Map();
    const heap = [];
    const keyFor = (x, y, d, visited) => (((y * nx + x) * 4 + d) * 2 + Number(visited));
    const first = { x: sx, y: sy, d: rule.startDirection ?? 0, visited: rule.right == null, bends: 0, length: 0, prev: null, shortest: rule.backward };
    first.key = keyFor(first.x, first.y, first.d, first.visited);
    records.set(first.key, first);
    heapPush(heap, first);
    let best = null;
    while (heap.length) {
      const state = heapPop(heap);
      if (records.get(state.key) !== state) continue;
      if (best && (rule.backward ? state.length > best.length : state.bends > best.bends)) break;
      if (state.x === ex && state.y === ey && state.visited && (state.d % 2 !== rule.endDirection % 2 || state.d === rule.endDirection)) {
        const candidate = { ...state, bends: state.bends + Number(state.d % 2 !== rule.endDirection % 2) };
        if (!best || less(candidate, best)) best = candidate;
        continue;
      }
      const a = { x: xs[state.x], y: ys[state.y] };
      for (const [dx, dy] of [[1, 0], [0, 1], [0, -1], [-1, 0]]) {
        const x = state.x + dx;
        const y = state.y + dy;
        if (x < 0 || x >= nx || y < 0 || y >= ny) continue;
        if (dy && !rule.lanes && !channels.has(a.x)) continue;
        if (dx < 0 && rule.forward) continue;
        if (dx && rule.rowDirection && dx !== rule.rowDirection) continue;
        const b = { x: xs[x], y: ys[y] };
        if (obstacles.some(box => intersects(a, b, box))) continue;
        const d = dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
        if (d === (state.d + 2) % 4) continue;
        const visited = state.visited || (rule.right != null && dy !== 0 && b.x >= rule.right);
        const key = keyFor(x, y, d, visited);
        const next = { x, y, d, visited, key, shortest: rule.backward, bends: state.bends + Number(d % 2 !== state.d % 2), length: state.length + distance(a, b), prev: state };
        const old = records.get(key);
        if (old && !less(next, old)) continue;
        records.set(key, next);
        heapPush(heap, next);
      }
    }
    if (!best) return null;
    const points = [];
    for (let state = best; state; state = state.prev) points.push({ x: xs[state.x], y: ys[state.y] });
    return points.reverse();
  }

  // Jump radius + the arrowhead gap the layout trims + clearance.
  const JUMP_END_ZONE = 24;

  function computeJumps(routes) {
    const list = Object.keys(routes).sort().map(id => routes[id]);
    list.forEach(route => { route.jumps = []; });
    let count = 0;
    list.forEach((horizontal, i) => {
      for (let h = 0; h + 1 < horizontal.points.length; h++) {
        const a = horizontal.points[h];
        const b = horizontal.points[h + 1];
        if (a.y !== b.y || a.x === b.x) continue;
        list.forEach((vertical, j) => {
          if (i === j) return;
          for (let v = 0; v + 1 < vertical.points.length; v++) {
            const c = vertical.points[v];
            const d = vertical.points[v + 1];
            if (c.x !== d.x || c.y === d.y) continue;
            if (c.x <= Math.min(a.x, b.x) || c.x >= Math.max(a.x, b.x) || a.y <= Math.min(c.y, d.y) || a.y >= Math.max(c.y, d.y)) continue;
            // A bridge next to a route's end would bend the arrowhead (it takes its angle from the
            // last few pixels), so near an end the vertical route carries the bridge instead.
            const at = { x: c.x, y: a.y };
            const nearEnd = (route) => {
              const first = route.points[0];
              const last = route.points[route.points.length - 1];
              return distance(first, at) < JUMP_END_ZONE || distance(last, at) < JUMP_END_ZONE;
            };
            const carrier = nearEnd(horizontal) && !nearEnd(vertical) ? { route: vertical, segment: v } : { route: horizontal, segment: h };
            // Coincident crossings need only one visible bridge.
            if (!carrier.route.jumps.some(jump => jump.segment === carrier.segment && jump.x === at.x && jump.y === at.y)) {
              carrier.route.jumps.push({ x: at.x, y: at.y, segment: carrier.segment });
              count++;
            }
          }
        });
      }
    });
    list.forEach(route => route.jumps.sort((a, b) => a.segment - b.segment || a.x - b.x || a.y - b.y));
    return count;
  }

  function makePath(route, cornerRadius, jumpRadius) {
    const points = route.points;
    if (!points.length) return '';
    const move = (p, q, amount) => {
      const length = distance(p, q);
      return { x: p.x + (q.x - p.x) * amount / length, y: p.y + (q.y - p.y) * amount / length };
    };
    const cuts = points.map((p, i) => i && i < points.length - 1 ? Math.min(cornerRadius, distance(points[i - 1], p) / 2, distance(p, points[i + 1]) / 2) : 0);
    route.jumps.forEach(jump => {
      const i = jump.segment;
      cuts[i] = Math.min(cuts[i], Math.max(0, distance(points[i], jump) - jumpRadius));
      cuts[i + 1] = Math.min(cuts[i + 1], Math.max(0, distance(points[i + 1], jump) - jumpRadius));
    });
    const commands = [`M ${points[0].x} ${points[0].y}`];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i];
      const b = points[i + 1];
      const start = cuts[i] ? move(a, b, cuts[i]) : a;
      const end = cuts[i + 1] ? move(b, a, cuts[i + 1]) : b;
      const jumps = route.jumps.filter(jump => jump.segment === i).sort((p, q) => distance(a, p) - distance(a, q));
      jumps.forEach((jump, j) => {
        const before = j ? distance(jumps[j - 1], jump) / 2 : distance(start, jump);
        const after = j + 1 < jumps.length ? distance(jumps[j + 1], jump) / 2 : distance(jump, end);
        const radius = Math.min(jumpRadius, before, after);
        if (radius <= 0) return;
        const dx = Math.sign(b.x - a.x);
        const dy = Math.sign(b.y - a.y);
        commands.push(`L ${jump.x - dx * radius} ${jump.y - dy * radius}`,
          `A ${radius} ${radius} 0 0 ${dx > 0 || dy > 0 ? 1 : 0} ${jump.x + dx * radius} ${jump.y + dy * radius}`);
      });
      commands.push(`L ${end.x} ${end.y}`);
      if (cuts[i + 1]) {
        const next = points[i + 2];
        const exit = move(b, next, cuts[i + 1]);
        const cross = (b.x - a.x) * (next.y - b.y) - (b.y - a.y) * (next.x - b.x);
        commands.push(`A ${cuts[i + 1]} ${cuts[i + 1]} 0 0 ${cross > 0 ? 1 : 0} ${exit.x} ${exit.y}`);
      }
    }
    return commands.join(' ');
  }

  function routeOrthogonal(input, options = {}) {
    options = { lanes: input.config?.layout === 'lanes' || (input.boundaries || []).some(b => b.gutterWidth), ...options };
    const headerHeight = input.config?.boundaryHeaderHeight ?? HEADER_HEIGHT;
    const cardMargin = input.config ? Math.min(14, input.config.nodeGapX / 2, input.config.nodeGapY / 2) : 14;
    // Rotate the routing grid for TB, preserving horizontal label dimensions.
    // Columns enter cards from below; lanes reserve only the title gutter.
    if (options.direction === 'TB') {
      const transpose = n => ({ ...n, x: n.y, y: n.x, width: n.height, height: n.width });
      const labelWidths = Object.fromEntries((input.edges || []).map(e => [e.id, 18]));
      const labelHeights = Object.fromEntries((input.edges || []).map(e => [e.id, options.labelWidths?.[e.id] ?? e.labelWidth ?? 80]));
      const margin = options.margin ?? cardMargin;
      const headers = (input.boundaries || []).map(b => ({
        left: b.y - margin, right: b.y + (options.lanes ? b.height : Math.min(headerHeight, b.height)) + margin,
        top: b.x - margin, bottom: b.x + (options.lanes ? (b.gutterWidth || 150) : b.width) + margin
      }));
      const result = routeOrthogonal({ ...input, nodes: input.nodes.map(transpose), boundaries: (input.boundaries || []).map(transpose) },
        { ...options, direction: 'LR', labelWidths, labelHeights, headers, targetFace: options.lanes ? null : 'right', compactExterior: true });
      Object.values(result.routes).forEach(route => {
        route.points = route.points.map(p => ({ x: p.y, y: p.x }));
        if (route.labelSlot) {
          const slot = route.labelSlot;
          route.labelSlot = { ...slot, x: slot.y, y: slot.x, width: slot.height, height: slot.width,
            orientation: slot.orientation === 'horizontal' ? 'vertical' : 'horizontal',
            ...(slot.tether ? { tether: { x: slot.tether.y, y: slot.tether.x } } : {}) };
        }
      });
      result.stats.jumps = computeJumps(result.routes);
      result.stats.crossings = result.stats.jumps;
      Object.values(result.routes).forEach(route => {
        route.path = makePath(route, options.cornerRadius ?? 6, options.jumpRadius ?? 5);
      });
      return result;
    }
    const { cornerRadius = 6, jumpRadius = 5, portSpacing = null, trackSpacing = 14, margin = cardMargin, labelWidths = {} } = options;
    if (![cornerRadius, jumpRadius, ...(portSpacing == null ? [] : [portSpacing]), margin].every(n => Number.isFinite(n) && n >= 0) || !Number.isFinite(trackSpacing) || trackSpacing <= 0) {
      throw new RangeError('Router spacing and radii must be finite and nonnegative; trackSpacing must be positive.');
    }
    const nodes = [...input.nodes].sort(byId);
    const boundaries = [...(input.boundaries || [])].sort(byId);
    const edges = [...(input.edges || [])].sort(byId);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const boxes = nodes.map(n => ({ ...rect(n, margin), id: n.id }));
    const headers = options.headers || boundaries.flatMap(b => {
      const members = nodes.filter(n => n.boundary === b.id);
      const headerBottom = b.y + Math.min(headerHeight, b.height);
      const bottom = Math.min(headerBottom, ...(members.length ? members.map(n => n.y) : [headerBottom])) + margin;
      return bottom > b.y - margin ? [{ left: b.x - margin, right: b.x + b.width + margin, top: b.y - margin, bottom }] : [];
    });
    const obstacles = [...boxes, ...headers];
    const routes = {};
    const stats = { cardCrossings: 0, crossings: 0, jumps: 0, bends: 0 };
    if (!nodes.length || !edges.length) return { routes, stats };

    const faceGroups = new Map();
    const ports = new Map();
    edges.forEach(edge => {
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      if (!source || !target) throw new Error(`Unknown endpoint for edge ${edge.id}.`);
      const kind = source.id === target.id ? 'self' : target.rank > source.rank ? 'forward' : target.rank < source.rank ? 'backward' : 'same-column';
      if (ports.has(edge.id)) throw new Error(`Duplicate edge id ${edge.id}.`);
      ports.set(edge.id, { kind });
      const laneMembers = options.lanes ? nodes.filter(n => n.boundary === source.boundary) : [];
      // With few lanes, spend a row channel on local links so their pills fit below the cards.
      const sameRowFace = boundaries.length <= 2 && laneMembers.some(n => n.row !== source.row)
        && kind === 'same-column' && source.x === target.x
        ? (source.x === Math.max(...laneMembers.map(n => n.x)) ? 'left' : 'right') : null;
      const local = options.lanes && kind === 'same-column' && source.x === target.x && !sameRowFace;
      const rowLink = options.lanes && kind === 'same-column' && source.boundary === target.boundary && source.x !== target.x;
      const rowBackward = rowLink && target.x < source.x;
      const sourceFace = sameRowFace || (rowBackward ? 'left' : local ? (target.y > source.y ? 'bottom' : 'top') : options.lanes && kind === 'backward' ? 'left' : 'right');
      const targetFace = sameRowFace || (rowLink ? (rowBackward ? 'right' : 'left') : local ? (target.y > source.y ? 'top' : 'bottom') : options.lanes && kind === 'backward' ? 'right' : options.targetFace || (kind === 'self' || kind === 'same-column' ? 'right' : 'left'));
      [['source', source, target, sourceFace], ['target', target, source, targetFace]].forEach(([end, node, other, face]) => {
        const key = `${node.id}:${face}`;
        if (!faceGroups.has(key)) faceGroups.set(key, []);
        faceGroups.get(key).push({ edge, end, node, other, face });
      });
    });
    [...faceGroups.keys()].sort().forEach(key => {
      const group = faceGroups.get(key);
      const verticalFace = ['top', 'bottom'].includes(group[0].face);
      const axis = verticalFace ? 'x' : 'y';
      const size = verticalFace ? 'width' : 'height';
      group.sort((a, b) => a.other[axis] + a.other[size] / 2 - b.other[axis] - b.other[size] / 2 || byId(a.edge, b.edge) || (a.end < b.end ? -1 : 1));
      const height = verticalFace ? group[0].node.width : group[0].node.height;
      const step = Math.max(8, portSpacing == null ? (group.length > 1 ? 0.6 * height / (group.length - 1) : 0) : portSpacing);
      if ((group.length - 1) * step >= height) throw new RangeError(`Too many ports on face ${key} for 8px spacing.`);
      group.forEach((entry, i) => {
        const offset = (i - (group.length - 1) / 2) * step;
        ports.get(entry.edge.id)[entry.end] = verticalFace
          ? { x: entry.node.x + entry.node.width / 2 + offset, y: entry.node.y + (entry.face === 'bottom' ? entry.node.height : 0), face: entry.face }
          : { x: entry.node.x + (entry.face === 'right' ? entry.node.width : 0), y: entry.node.y + entry.node.height / 2 + offset, face: entry.face };
      });
    });

    const slabs = boxes.map(b => ({ left: b.left, right: b.right })).sort((a, b) => a.left - b.left || a.right - b.right);
    const merged = [];
    slabs.forEach(slab => {
      const last = merged[merged.length - 1];
      if (last && slab.left < last.right) last.right = Math.max(last.right, slab.right);
      else merged.push({ ...slab });
    });
    const extent = (edges.length + 2) * trackSpacing * (options.compactExterior ? 1 : 2);
    const left = Math.min(merged[0].left, ...headers.map(h => h.left));
    const right = Math.max(merged[merged.length - 1].right, ...headers.map(h => h.right));
    const gaps = [{ left: left - extent, right: left - trackSpacing, segments: [] }];
    for (let i = 0; i + 1 < merged.length; i++) gaps.push({ left: merged[i].right, right: merged[i + 1].left, segments: [] });
    gaps.push({ left: right + trackSpacing, right: right + extent, segments: [] });
    gaps.forEach(gap => {
      if (options.lanes) return;
      headers.forEach(header => {
        if (header.left <= gap.left && header.right > gap.left && header.right < gap.right) gap.left = header.right;
        if (header.right >= gap.right && header.left < gap.right && header.left > gap.left) gap.right = header.left;
      });
    });
    const baseYs = obstacles.flatMap(b => [b.top, b.bottom]);
    edges.forEach(edge => {
      const port = ports.get(edge.id);
      const escape = p => ({ x: p.x + (p.face === 'right' ? margin : p.face === 'left' ? -margin : 0), y: p.y + (p.face === 'bottom' ? margin : p.face === 'top' ? -margin : 0) });
      const start = escape(port.source);
      const end = escape(port.target);
      const available = new Map();
      gaps.forEach(gap => {
        const count = gap.segments.length;
        const capacity = Math.floor((gap.right - gap.left) / trackSpacing) + 1;
        const center = (gap.left + gap.right) / 2;
        const tracks = Array.from({ length: capacity }, (_, i) => center + (i - (capacity - 1) / 2) * trackSpacing)
          .sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
        available.set(tracks[count % tracks.length], gap);
      });
      const xs = [...new Set([start.x, end.x, ...available.keys()])].sort((a, b) => a - b);
      const ys = [...new Set([...baseYs, start.y, end.y])].sort((a, b) => a - b);
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      const involved = nodes.filter(n => n.rank >= Math.min(source.rank, target.rank) && n.rank <= Math.max(source.rank, target.rank));
      const involvedHeaders = boundaries.filter(b => involved.some(n => n.boundary === b.id));
      const rule = {
        forward: port.kind === 'forward' && port.target.face === 'left',
        rowDirection: options.lanes && source.boundary === target.boundary && source.x !== target.x ? Math.sign(target.x - source.x) : 0,
        lanes: options.lanes,
        startDirection: { right: 0, bottom: 1, left: 2, top: 3 }[port.source.face],
        backward: port.kind === 'backward',
        endDirection: { left: 0, top: 1, right: 2, bottom: 3 }[port.target.face],
        top: Math.min(...involved.map(n => n.y - margin), ...involvedHeaders.map(b => b.y - margin)),
        bottom: Math.max(...involved.map(n => n.y + n.height + margin), ...involvedHeaders.map(b => b.y + Math.min(headerHeight, b.height) + margin))
      };
      if (port.kind === 'self' || (port.kind === 'same-column' && !options.lanes)) {
        rule.right = Math.max(...nodes.filter(n => n.rank === source.rank).map(n => n.x + n.width + margin)) + trackSpacing / 2;
      }
      if (rule.backward) ys.push(rule.top, rule.bottom);
      const gridYs = [...new Set(ys)].sort((a, b) => a - b);
      const middle = search(start, end, xs, gridYs, obstacles, available, rule);
      if (!middle) throw new Error(`No clear orthogonal route for edge ${edge.id}.`);
      const points = simplify([port.source, ...middle, port.target]);
      const route = { points, path: '', jumps: [], labelSlot: null, kind: port.kind };
      Object.defineProperty(routes, edge.id, { value: route, enumerable: true });
      for (let i = 0; i + 1 < points.length; i++) {
        if (points[i].x === points[i + 1].x) {
          const gap = available.get(points[i].x) || (options.lanes ? gaps.find(gap => points[i].x >= gap.left && points[i].x <= gap.right) : null);
          if (gap) gap.segments.push({ route, index: i, id: edge.id, entry: points[i].y, exit: points[i + 1].y });
        }
      }
    });

    gaps.forEach(gap => {
      const segments = gap.segments.sort((a, b) => a.entry - b.entry || a.exit - b.exit || byId(a, b) || a.index - b.index);
      const capacity = Math.floor((gap.right - gap.left) / trackSpacing) + 1;
      const tracks = [];
      const trackOf = new Map();
      segments.forEach(segment => {
        const low = Math.min(segment.entry, segment.exit);
        const high = Math.max(segment.entry, segment.exit);
        let track = options.lanes ? tracks.findIndex(items => items.every(item => high <= item.low || low >= item.high)) : -1;
        if (track < 0) { track = tracks.length; tracks.push([]); }
        tracks[track].push({ low, high });
        trackOf.set(segment, track);
      });
      if (tracks.length > capacity) {
        if (!stats.gapDemand) stats.gapDemand = {};
        if (!stats.gapAvailable) stats.gapAvailable = {};
        stats.gapAvailable[gaps.indexOf(gap) - 1] = gap.right - gap.left + 2 * margin;
        stats.gapDemand[gaps.indexOf(gap) - 1] = (tracks.length - 1) * trackSpacing + 2 * margin;
      }
      segments.forEach(segment => {
        const count = Math.min(tracks.length, capacity);
        const inset = options.lanes ? Math.max(0, 26 - margin) : 0;
        const spacing = options.lanes && count > 1 ? Math.max(trackSpacing, (gap.right - gap.left - 2 * inset) / (count - 1)) : trackSpacing;
        let x = (gap.left + gap.right) / 2 + (trackOf.get(segment) % count - (count - 1) / 2) * spacing;
        // Keep the final bend beyond the marker gap (10), its straight
        // approach (12), and the corner radius, within the clear corridor.
        if (input.config && !options.lanes && segment.index === segment.route.points.length - 3) {
          const target = segment.route.points.at(-1);
          const sign = Math.sign(x - target.x);
          const approach = target.x + sign * (22 + cornerRadius);
          x = sign > 0 ? Math.min(gap.right, Math.max(x, approach))
            : Math.max(gap.left, Math.min(x, approach));
        }
        segment.route.points[segment.index].x = x;
        segment.route.points[segment.index + 1].x = x;
      });
    });
    const labelObstacles = [...nodes.map(n => rect(n, 0)), ...headers.map(h => ({ left: h.left + margin, right: h.right - margin, top: h.top + margin, bottom: h.bottom - margin }))];
    const labelExtentBoxes = [...nodes.map(n => rect(n, 0)), ...boundaries.map(b => rect(b, 0))];
    const labelExtent = { left: Math.min(...labelExtentBoxes.map(b => b.left)), right: Math.max(...labelExtentBoxes.map(b => b.right)),
      top: Math.min(...labelExtentBoxes.map(b => b.top)), bottom: Math.max(...labelExtentBoxes.map(b => b.bottom)) };
    let exteriorPadding = 40;
    const labelContexts = new Map();
    const multiRow = options.lanes && nodes.some(n => n.row > 0);
    // Candidates are produced lazily, in a fixed order: backtracking usually takes one of the first.
    const labelCandidateStream = function* (edge, slots, displaced = false) {
      const route = routes[edge.id];
      const width = labelWidths[edge.id] == null ? (edge.labelWidth == null ? 80 : edge.labelWidth) : labelWidths[edge.id];
      if (!Number.isFinite(width) || width < 0) throw new RangeError(`Invalid label width for edge ${edge.id}.`);
      const height = options.labelHeights?.[edge.id] ?? 18;
      if (!Number.isFinite(height) || height < 0) throw new RangeError(`Invalid label height for edge ${edge.id}.`);
      let context = labelContexts.get(edge.id);
      if (!context) {
        const lines = edges.filter(other => other.id !== edge.id).flatMap(other => {
          const points = routes[other.id].points;
          return points.slice(1).map((b, i) => ({ left: Math.min(points[i].x, b.x) - 1, right: Math.max(points[i].x, b.x) + 1, top: Math.min(points[i].y, b.y) - 1, bottom: Math.max(points[i].y, b.y) + 1 }));
        });
        const segments = [];
        for (let i = 0; i + 1 < route.points.length; i++) {
          const a = route.points[i];
          const b = route.points[i + 1];
          segments.push({ a, b, index: i, length: distance(a, b), orientation: a.y === b.y ? 'horizontal' : 'vertical' });
        }
        segments.sort((a, b) => b.length - a.length || a.index - b.index);
        const preferredOrientation = options.labelHeights ? 'vertical' : 'horizontal';
        const preferredLength = options.labelHeights ? height : width + 16;
        const preferred = segments.filter(segment => segment.orientation === preferredOrientation && segment.length >= preferredLength);
        const candidates = [...preferred, ...segments.filter(segment => !preferred.includes(segment))];
        context = { lines, candidates, positions: new Map() };
        labelContexts.set(edge.id, context);
      }
      const { lines, candidates } = context;
      for (const segment of candidates) {
        const horizontal = segment.orientation === 'horizontal';
        const anchorFixed = horizontal ? segment.a.y : segment.a.x;
        // A pill in a lower row may need to reach clear space several rows away.
        const offsets = displaced ? [0, ...Array.from({ length: multiRow ? 48 : options.lanes ? 12 : 24 }, (_, i) => (i + 1) * 14).flatMap(n => [-n, n])] : [0];
        if (displaced && exteriorPadding > 40) {
          // Try the nearest fully clear exterior strip directly, even from a far lower-row slot.
          offsets.push(...(horizontal ? [labelExtent.top - height / 2 - 8, labelExtent.bottom + height / 2 + 8]
            : [labelExtent.left - width / 2 - 16, labelExtent.right + width / 2 + 16]).map(fixed => fixed - anchorFixed));
        }
        for (const offset of offsets) {
          const fixed = anchorFixed + offset;
          // Reject out-of-bounds offsets before scanning blockers and packing positions.
          // Every position on this run has the same coordinate on the fixed axis.
          if (offset && (horizontal
            ? fixed - height / 2 < labelExtent.top - exteriorPadding || fixed + height / 2 > labelExtent.bottom + exteriorPadding
            : fixed - width / 2 - 8 < labelExtent.left - exteriorPadding || fixed + width / 2 + 8 > labelExtent.right + exteriorPadding)) continue;
          const low = Math.min(horizontal ? segment.a.x : segment.a.y, horizontal ? segment.b.x : segment.b.y);
          const high = low + segment.length;
          const half = horizontal ? width / 2 + 8 : height / 2;
          // Prefer the midpoint, then the nearest exact collision boundary. The pill
          // may overhang a short segment; its anchor remains on the line.
          const key = `${segment.index}:${fixed}`;
          let packing = context.positions.get(key);
          const crossesFixedAxis = box => horizontal
            ? fixed - height / 2 < box.bottom && fixed + height / 2 > box.top
            : fixed - width / 2 - 8 < box.right && fixed + width / 2 + 8 > box.left;
          const collisionPositions = box => horizontal
            ? [box.left - half, box.right + half]
            : [box.top - half, box.bottom + half];
          const center = (low + high) / 2;
          if (!packing) {
            const blockers = [...labelObstacles, ...lines].filter(crossesFixedAxis);
            packing = { positions: [center, low, high, ...blockers.flatMap(collisionPositions)], valid: new Map() };
            context.positions.set(key, packing);
          }
          const positions = [...new Set([...packing.positions, ...slots.filter(crossesFixedAxis).flatMap(collisionPositions)])]
            .filter(value => value >= low && value <= high)
            .sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
          for (const position of positions) {
            const x = horizontal ? position : fixed;
            const y = horizontal ? fixed : position;
            const box = { left: x - width / 2 - 8, right: x + width / 2 + 8, top: y - height / 2, bottom: y + height / 2 };
            // Static collisions do not change during backtracking; label/label checks do.
            if (!packing.valid.has(position)) packing.valid.set(position,
              !labelObstacles.some(card => overlap(box, card)) && !lines.some(line => overlap(box, line)));
            if (!packing.valid.get(position) || slots.some(slot => overlap(box, slot))) continue;
            if (offset) {
              const limit = { left: labelExtent.left - exteriorPadding, right: labelExtent.right + exteriorPadding,
                top: labelExtent.top - exteriorPadding, bottom: labelExtent.bottom + exteriorPadding };
              if (box.left < limit.left || box.right > limit.right || box.top < limit.top || box.bottom > limit.bottom) continue;
            }
            yield ({ slot: { x, y, width, height, segment: segment.index, orientation: segment.orientation, ...(offset ? { tether: horizontal ? { x, y: anchorFixed } : { x: anchorFixed, y } } : {}) }, box });
          }
        }
      }
    };
    const labelCandidates = (edge, slots, displaced) => [...labelCandidateStream(edge, slots, displaced)];
    // Backtrack when a centred pill consumes another label's only free space.
    // A bounded search keeps impossible or very dense inputs predictable.
    let labelOrder;
    let allowDisplaced = false;
    let attempts = 0;
    let best = [];
    const place = (index, chosen) => {
      if (chosen.filter(Boolean).length > best.filter(Boolean).length) best = [...chosen];
      // Every call spends the budget, leaves included: a dense last label can offer hundreds of slots.
      if (index === labelOrder.length) return ++attempts, chosen.every(Boolean);
      if (++attempts > 10000) return false;
      for (const candidate of labelCandidateStream(labelOrder[index], chosen.filter(Boolean).map(item => item.box), allowDisplaced)) {
        chosen.push(candidate);
        if (place(index + 1, chosen)) return true;
        chosen.pop();
        // Past the budget every later branch fails at once and can only tie the best partial.
        if (attempts > 10000) return false;
      }
      chosen.push(null);
      const complete = place(index + 1, chosen);
      chosen.pop();
      return complete;
    };
    // Count crossings once; candidate generation can be revisited during packing.
    edges.forEach(edge => {
      // The layout trims EDGE_END_GAP (10px) off the end for the arrowhead, so the stub covers that too.
      routes[edge.id].points = ensureStubs(simplify(routes[edge.id].points), boxes, edge, options.minStub ?? (options.cornerRadius ?? 6) + 20);
      const route = routes[edge.id];
      for (let i = 0; i + 1 < route.points.length; i++) {
        const a = route.points[i];
        const b = route.points[i + 1];
        boxes.forEach(box => {
          // Only the terminal escape through its own clearance is permitted.
          if ((i === 0 && box.id === edge.source) || (i === route.points.length - 2 && box.id === edge.target)) return;
          if (intersects(a, b, box)) stats.cardCrossings++;
        });
      }
      stats.bends += Math.max(0, routes[edge.id].points.length - 2);
    });
    const candidateCounts = new Map(edges.map(edge => [edge.id, labelCandidates(edge, []).length]));
    labelOrder = [...edges].sort((a, b) => candidateCounts.get(a.id) - candidateCounts.get(b.id) || byId(a, b));
    if (!place(0, [])) {
      // Keep the anchor on a straight run when no on-line pill fits. Move only
      // the pill into nearby clear space, retaining a leader to that run.
      attempts = 0;
      allowDisplaced = true;
      if (!place(0, [])) {
        // A dense diagram can exhaust the narrow exterior strip; retain the same bounded search.
        // Multi-row lanes have row channels to reach; one-row diagrams keep labels close so the fit holds.
        exteriorPadding = multiRow ? 280 : 80;
        attempts = 0;
        place(0, []);
      }
    }
    labelOrder.forEach((edge, i) => {
      const route = routes[edge.id];
      route.labelSlot = best[i] ? best[i].slot : null;
      if (route.labelSlot) return;
      // Compact card gaps may fit the tracks but leave no room for a label.
      const width = labelWidths[edge.id] ?? edge.labelWidth ?? 80;
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      gaps.slice(1, -1).forEach((gap, index) => {
        if (gap.left < Math.min(source.x, target.x) || gap.right > Math.max(source.x + source.width, target.x + target.width)) return;
        const available = gap.right - gap.left + 2 * margin;
        const demand = width + 16 + 2 * margin;
        if (demand <= available) return;
        if (!stats.gapDemand) stats.gapDemand = {};
        if (!stats.gapAvailable) stats.gapAvailable = {};
        stats.gapAvailable[index] = available;
        stats.gapDemand[index] = Math.max(stats.gapDemand[index] || 0, demand);
      });
    });
    stats.jumps = computeJumps(routes);
    stats.crossings = stats.jumps;
    edges.forEach(edge => { routes[edge.id].path = makePath(routes[edge.id], cornerRadius, jumpRadius); });
    return { routes, stats };
  }

  // Adapt the router's polyline to the workbench's geometry contract in both runtimes.
  function buildRouteGeometry(route, labelWidth, geometry, options = {}) {
    const polyline = route.points.map(p => ({ ...p }));
    const source = options.source;
    const target = options.target;
    const start = polyline[0];
    const finish = polyline[polyline.length - 1];
    const beforeFinish = polyline[polyline.length - 2];
    // Preserve the workbench's shape-aware attachment and arrowhead clearance.
    if (source) {
      if (start.y === polyline[1].y) start.x = polyline[1].x > start.x ? geometry.shapeRightX(source, start.y - source.y - source.height / 2)
        : geometry.shapeLeftX(source, start.y - source.y - source.height / 2);
      else start.y = polyline[1].y > start.y ? geometry.shapeBottomY(source, start.x - source.x - source.width / 2)
        : geometry.shapeTopY(source, start.x - source.x - source.width / 2);
    }
    if (target) {
      if (finish.y === beforeFinish.y) {
        const offset = finish.y - target.y - target.height / 2;
        finish.x = finish.x > beforeFinish.x ? geometry.shapeLeftX(target, offset) - geometry.EDGE_END_GAP
          : geometry.shapeRightX(target, offset) + geometry.EDGE_END_GAP;
      } else {
        const offset = finish.x - target.x - target.width / 2;
        finish.y = finish.y > beforeFinish.y ? geometry.shapeTopY(target, offset) - geometry.EDGE_END_GAP
          : geometry.shapeBottomY(target, offset) + geometry.EDGE_END_GAP;
      }
    }
    const first = polyline[0];
    const endpoint = polyline[polyline.length - 1];
    const previous = polyline[polyline.length - 2] || first;
    const tangent = { x: endpoint.x - previous.x, y: endpoint.y - previous.y };
    tangent.angle = Math.atan2(tangent.y, tangent.x) * 180 / Math.PI;
    const bounds = (left, top, right, bottom) => ({
      left, top, right, bottom, minX: left, minY: top, maxX: right, maxY: bottom,
      width: right - left, height: bottom - top
    });
    const radius = route.jumps.length ? (options.jumpRadius ?? 5) : 0;
    const pathBounds = bounds(
      Math.min(...polyline.map(p => p.x)) - radius,
      Math.min(...polyline.map(p => p.y)) - radius,
      Math.max(...polyline.map(p => p.x)) + radius,
      Math.max(...polyline.map(p => p.y)) + radius
    );
    const slot = route.labelSlot;
    const labelX = slot ? slot.x : first.x;
    const labelY = slot ? slot.y : first.y;
    const labelBounds = slot ? bounds(slot.x - slot.width / 2, slot.y - slot.height / 2,
      slot.x + slot.width / 2, slot.y + slot.height / 2) : null;
    const markerBounds = geometry.calculateMarkerBounds(endpoint, tangent);
    return {
      path: makePath({ ...route, points: polyline }, options.cornerRadius ?? 6, options.jumpRadius ?? 5), polyline, jumps: route.jumps, kind: route.kind,
      points: { x1: first.x, y1: first.y, x2: endpoint.x, y2: endpoint.y, kind: route.kind,
        targetFace: tangent.x > 0 ? 'left' : tangent.x < 0 ? 'right' : tangent.y > 0 ? 'top' : 'bottom' },
      controls: null, endpoint, terminalTangent: tangent,
      segments: polyline.map((p, i) => ({ type: i ? 'L' : 'M', x: p.x, y: p.y })),
      labelSlot: slot, labelX, labelY, labelWidth, labelAnchor: slot ? { x: slot.x, y: slot.y } : null,
      labelBounds, labelTether: slot?.tether || null, pathBounds, markerBounds,
      totalVisualBounds: geometry.calculateEdgeVisualBounds(pathBounds, markerBounds, labelWidth > 0 ? labelBounds : null)
    };
  }

  return { routeOrthogonal, computeJumps, buildRouteGeometry };
});
