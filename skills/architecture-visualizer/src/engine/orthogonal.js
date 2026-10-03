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
    const first = { x: sx, y: sy, d: 0, visited: rule.right == null, bends: 0, length: 0, prev: null };
    first.key = keyFor(first.x, first.y, first.d, first.visited);
    records.set(first.key, first);
    heapPush(heap, first);
    let best = null;
    while (heap.length) {
      const state = heapPop(heap);
      if (records.get(state.key) !== state) continue;
      if (best && state.bends > best.bends) break;
      if (state.x === ex && state.y === ey && state.visited && (state.d % 2 !== 0 || state.d === rule.endDirection)) {
        const candidate = { ...state, bends: state.bends + Number(state.d % 2 !== 0) };
        if (!best || less(candidate, best)) best = candidate;
        continue;
      }
      const a = { x: xs[state.x], y: ys[state.y] };
      for (const [dx, dy] of [[1, 0], [0, 1], [0, -1], [-1, 0]]) {
        const x = state.x + dx;
        const y = state.y + dy;
        if (x < 0 || x >= nx || y < 0 || y >= ny) continue;
        if (dy && !channels.has(a.x)) continue;
        if (dx < 0 && rule.forward) continue;
        if (dx < 0 && rule.backward && a.y > rule.top && a.y < rule.bottom) continue;
        const b = { x: xs[x], y: ys[y] };
        if (obstacles.some(box => intersects(a, b, box))) continue;
        const d = dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
        if (d === (state.d + 2) % 4) continue;
        const visited = state.visited || (rule.right != null && dy !== 0 && b.x >= rule.right);
        const key = keyFor(x, y, d, visited);
        const next = { x, y, d, visited, key, bends: state.bends + Number(d % 2 !== state.d % 2), length: state.length + distance(a, b), prev: state };
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
            // Coincident crossings need only one visible bridge.
            if (!horizontal.jumps.some(jump => jump.segment === h && jump.x === c.x && jump.y === a.y)) {
              horizontal.jumps.push({ x: c.x, y: a.y, segment: h });
              count++;
            }
          }
        });
      }
      horizontal.jumps.sort((a, b) => a.segment - b.segment || a.x - b.x || a.y - b.y);
    });
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
        const sign = Math.sign(b.x - a.x);
        commands.push(`L ${jump.x - sign * radius} ${jump.y}`, `A ${radius} ${radius} 0 0 ${sign > 0 ? 1 : 0} ${jump.x + sign * radius} ${jump.y}`);
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
    const { cornerRadius = 6, jumpRadius = 5, portSpacing = 12, trackSpacing = 10, margin = 14, labelWidths = {} } = options;
    if (![cornerRadius, jumpRadius, portSpacing, margin].every(n => Number.isFinite(n) && n >= 0) || !Number.isFinite(trackSpacing) || trackSpacing <= 0) {
      throw new RangeError('Router spacing and radii must be finite and nonnegative; trackSpacing must be positive.');
    }
    const nodes = [...input.nodes].sort(byId);
    const boundaries = [...(input.boundaries || [])].sort(byId);
    const edges = [...(input.edges || [])].sort(byId);
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    const boxes = nodes.map(n => ({ ...rect(n, margin), id: n.id }));
    const headers = boundaries.flatMap(b => {
      const members = nodes.filter(n => n.boundary === b.id);
      const headerBottom = b.y + Math.min(HEADER_HEIGHT, b.height);
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
      [['source', source, target, 'right'], ['target', target, source, kind === 'self' || kind === 'same-column' ? 'right' : 'left']].forEach(([end, node, other, face]) => {
        const key = `${node.id}:${face}`;
        if (!faceGroups.has(key)) faceGroups.set(key, []);
        faceGroups.get(key).push({ edge, end, node, other, face });
      });
    });
    [...faceGroups.keys()].sort().forEach(key => {
      const group = faceGroups.get(key).sort((a, b) => a.other.y + a.other.height / 2 - b.other.y - b.other.height / 2 || byId(a.edge, b.edge) || (a.end < b.end ? -1 : 1));
      const step = group.length > 1 ? Math.min(portSpacing, group[0].node.height / (group.length + 1)) : 0;
      group.forEach((entry, i) => {
        ports.get(entry.edge.id)[entry.end] = { x: entry.node.x + (entry.face === 'right' ? entry.node.width : 0), y: entry.node.y + entry.node.height / 2 + (i - (group.length - 1) / 2) * step, face: entry.face };
      });
    });

    const slabs = boxes.map(b => ({ left: b.left, right: b.right })).sort((a, b) => a.left - b.left || a.right - b.right);
    const merged = [];
    slabs.forEach(slab => {
      const last = merged[merged.length - 1];
      if (last && slab.left <= last.right) last.right = Math.max(last.right, slab.right);
      else merged.push({ ...slab });
    });
    const extent = (edges.length + 2) * trackSpacing;
    const left = Math.min(merged[0].left, ...headers.map(h => h.left));
    const right = Math.max(merged[merged.length - 1].right, ...headers.map(h => h.right));
    const gaps = [{ left: left - extent * 2, right: left - trackSpacing, segments: [] }];
    for (let i = 0; i + 1 < merged.length; i++) gaps.push({ left: merged[i].right, right: merged[i + 1].left, segments: [] });
    gaps.push({ left: right + trackSpacing, right: right + extent * 2, segments: [] });
    gaps.forEach(gap => {
      headers.forEach(header => {
        if (header.left <= gap.left && header.right > gap.left && header.right < gap.right) gap.left = header.right;
        if (header.right >= gap.right && header.left < gap.right && header.left > gap.left) gap.right = header.left;
      });
    });
    const baseYs = obstacles.flatMap(b => [b.top, b.bottom]);
    edges.forEach(edge => {
      const port = ports.get(edge.id);
      const start = { x: port.source.x + margin, y: port.source.y };
      const end = { x: port.target.x + (port.target.face === 'left' ? -margin : margin), y: port.target.y };
      const available = new Map();
      gaps.forEach(gap => {
        const count = gap.segments.length;
        const capacity = Math.floor((gap.right - gap.left) / trackSpacing) + 1;
        const center = (gap.left + gap.right) / 2;
        const tracks = Array.from({ length: capacity }, (_, i) => center + (i - (capacity - 1) / 2) * trackSpacing)
          .sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
        if (count < tracks.length) available.set(tracks[count], gap);
      });
      const xs = [...new Set([start.x, end.x, ...available.keys()])].sort((a, b) => a - b);
      const ys = [...new Set([...baseYs, start.y, end.y])].sort((a, b) => a - b);
      const source = nodeMap.get(edge.source);
      const target = nodeMap.get(edge.target);
      const involved = nodes.filter(n => n.rank >= Math.min(source.rank, target.rank) && n.rank <= Math.max(source.rank, target.rank));
      const involvedHeaders = boundaries.filter(b => involved.some(n => n.boundary === b.id));
      const rule = {
        forward: port.kind === 'forward',
        backward: port.kind === 'backward',
        endDirection: port.target.face === 'left' ? 0 : 2,
        top: Math.min(...involved.map(n => n.y - margin), ...involvedHeaders.map(b => b.y - margin)),
        bottom: Math.max(...involved.map(n => n.y + n.height + margin), ...involvedHeaders.map(b => b.y + b.height + margin))
      };
      if (port.kind === 'self' || port.kind === 'same-column') {
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
          const gap = available.get(points[i].x);
          gap.segments.push({ route, index: i, id: edge.id, entry: points[i].y, exit: points[i + 1].y });
        }
      }
    });

    gaps.forEach(gap => {
      const segments = gap.segments.sort((a, b) => a.entry - b.entry || a.exit - b.exit || byId(a, b) || a.index - b.index);
      if ((segments.length - 1) * trackSpacing > gap.right - gap.left) throw new Error('Insufficient channel width for distinct tracks.');
      segments.forEach((segment, i) => {
        const x = (gap.left + gap.right) / 2 + (i - (segments.length - 1) / 2) * trackSpacing;
        segment.route.points[segment.index].x = x;
        segment.route.points[segment.index + 1].x = x;
      });
    });
    const slots = [];
    edges.forEach(edge => {
      const route = routes[edge.id];
      route.points = simplify(route.points);
      const width = labelWidths[edge.id] == null ? 80 : labelWidths[edge.id];
      if (!Number.isFinite(width) || width < 0) throw new RangeError(`Invalid label width for edge ${edge.id}.`);
      const segments = [];
      for (let i = 0; i + 1 < route.points.length; i++) {
        const a = route.points[i];
        const b = route.points[i + 1];
        if (a.y === b.y && distance(a, b) >= width + 16) segments.push({ a, b, index: i, length: distance(a, b) });
        boxes.forEach(box => {
          // Only the terminal escape through its own clearance is permitted.
          if ((i === 0 && box.id === edge.source) || (i === route.points.length - 2 && box.id === edge.target)) return;
          if (intersects(a, b, box)) stats.cardCrossings++;
        });
      }
      segments.sort((a, b) => b.length - a.length || a.index - b.index);
      for (const segment of segments) {
        const x = (segment.a.x + segment.b.x) / 2;
        const y = segment.a.y;
        const box = { left: x - width / 2 - 8, right: x + width / 2 + 8, top: y - 9, bottom: y + 9 };
        if (obstacles.some(card => overlap(box, card)) || slots.some(slot => overlap(box, slot))) continue;
        route.labelSlot = { x, y, width, segment: segment.index };
        slots.push(box);
        break;
      }
      stats.bends += Math.max(0, route.points.length - 2);
    });
    stats.jumps = computeJumps(routes);
    stats.crossings = stats.jumps;
    edges.forEach(edge => { routes[edge.id].path = makePath(routes[edge.id], cornerRadius, jumpRadius); });
    return { routes, stats };
  }

  return { routeOrthogonal, computeJumps };
});
