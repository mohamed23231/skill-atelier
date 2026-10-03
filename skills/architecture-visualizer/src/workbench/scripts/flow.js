// Animated Flow Particles
function toggleFlowAnimation() {
  if (state.prefersReducedMotion && !state.animatingFlow) {
    announceStatus('Flow animation is disabled by reduced-motion preference.');
    return;
  }
  state.animatingFlow = !state.animatingFlow;
  setIconLabel(document.getElementById('anim-icon'), state.animatingFlow ? 'ui-pause' : 'ui-play');
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
  state.animatingFlow = true;
  setIconLabel(document.getElementById('anim-icon'), 'ui-pause');

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
      element: circle,
      pathEl,
      length,
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
      if (p.length > 0 && p.pathEl) {
        p.progress = (p.progress + p.speed * dt) % p.length;
        const pt = p.pathEl.getPointAtLength(p.progress);
        p.element.setAttribute('cx', pt.x);
        p.element.setAttribute('cy', pt.y);
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
