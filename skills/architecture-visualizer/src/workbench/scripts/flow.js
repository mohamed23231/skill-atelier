// Animated Flow Particles

// Moving dots pass behind their connection's label rather than over its text.
function insideEdgeLabel(edge, point, pad) {
  const b = edge && edge.labelBounds;
  return !!b && point.x > b.left - pad && point.x < b.left + b.width + pad && point.y > b.top - pad && point.y < b.top + b.height + pad;
}
function toggleFlowAnimation() {
  if (state.prefersReducedMotion && !state.animatingFlow) {
    announceStatus('Flow animation is disabled by reduced-motion preference.');
    return;
  }
  state.animatingFlow = !state.animatingFlow;
  announceStatus(state.animatingFlow ? 'Data flow animation on.' : 'Data flow animation off.');
  if (state.animatingFlow) {
    startFlowParticles();
  } else {
    stopFlowParticles();
  }
}

let particleAnimationId = null;
let particleLastFrame = 0;
function startFlowParticles() {
  stopFlowParticles();
  if (state.prefersReducedMotion) { state.animatingFlow = false; return; }
  state.animatingFlow = true;

  const totalBounds = computeTotalVisualBounds();
  const visibleEdges = (LAYOUT_DATA.edges || []).filter(e => {
    if (e.animated === false) return false;
    const group = document.getElementById(`edge-${e.id}`);
    if (!group || group.classList.contains('hidden') || group.classList.contains('dimmed')) return false;
    if (e.totalVisualBounds && totalBounds) {
      if (e.totalVisualBounds.maxX < totalBounds.minX || e.totalVisualBounds.minX > totalBounds.maxX ||
          e.totalVisualBounds.maxY < totalBounds.minY || e.totalVisualBounds.minY > totalBounds.maxY) {
        return false;
      }
    }
    return state.currentView !== VIEWS.DATA_FLOW || !e.pathType || DATA_FLOW_PATH_TYPES.has(e.pathType);
  });

  const particles = visibleEdges.map((e, index) => {
    const pathEl = document.getElementById(`path-${e.id}`);
    const length = pathEl ? pathEl.getTotalLength() : 0;
    const circle = el('circle', {
      r: '4',
      class: 'flow-particle',
      fill: 'var(--accent)'
    });
    particlesLayer.appendChild(circle);
    return {
      edge: e,
      element: circle,
      pathEl,
      length,
      path: e.path,
      // deterministic stagger, never Math.random
      progress: length > 0 ? (index / Math.max(visibleEdges.length, 1)) * length : 0,
      speed: e.communication === 'async' ? 90 : 150
    };
  });

  particleLastFrame = performance.now();
  const animate = now => {
    if (!state.animatingFlow) return;
    const dt = Math.min((now - particleLastFrame) / 1000, 0.1);
    particleLastFrame = now;
    particles.forEach(p => {
      if (p.pathEl && p.path !== p.edge.path) {
        const length = p.pathEl.getTotalLength();
        p.progress = p.length > 0 ? p.progress / p.length * length : 0;
        p.length = length;
        p.path = p.edge.path;
      }
      if (p.length > 0 && p.pathEl) {
        p.progress = (p.progress + p.speed * dt) % p.length;
        const pt = p.pathEl.getPointAtLength(p.progress);
        p.element.setAttribute('cx', pt.x);
        p.element.setAttribute('cy', pt.y);
        const group = document.getElementById(`edge-${p.edge.id}`);
        const quiet = !group || ['hidden', 'dimmed', 'context-dim', 'out-of-focus'].some(name => group.classList.contains(name));
        p.element.style.opacity = quiet || insideEdgeLabel(p.edge, pt, 4) ? '0' : '';
      }
    });
    particleAnimationId = requestAnimationFrame(animate);
  };
  particleAnimationId = requestAnimationFrame(animate);
}

function stopFlowParticles() {
  if (particleAnimationId) cancelAnimationFrame(particleAnimationId);
  particleAnimationId = null;
  particlesLayer.innerHTML = '';
}
