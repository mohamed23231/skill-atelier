// Sequence Playback Engine
function sequenceSteps() {
  return ARCH_SPEC.views?.sequence?.steps || [];
}

function initSequencePlayback() {
  const steps = sequenceSteps();
  const slider = document.getElementById('seq-slider');
  slider.max = Math.max(steps.length, 1);
  slider.value = 1;
  goToSequenceStep(0);
}

function goToSequenceStep(index) {
  const steps = sequenceSteps();
  if (steps.length === 0) return;

  actions.setSequenceIndex(Math.max(0, Math.min(index, steps.length - 1)));
  const step = steps[state.sequenceIndex];

  const stepInfo = document.getElementById('seq-step-info');
  stepInfo.textContent = `Step ${state.sequenceIndex + 1}/${steps.length}: ${step.label || ''}`;
  stepInfo.title = stepInfo.textContent;
  document.getElementById('seq-slider').value = state.sequenceIndex + 1;

  spotlightInteractions([step]);
  updateUrlState();
}

function interactionEdge(interaction) {
  const byId = interaction.edgeId && edgeById.get(interaction.edgeId);
  if (byId) return byId;
  return (LAYOUT_DATA.edges || []).find(edge =>
    (edge.source === interaction.from && edge.target === interaction.to) ||
    (edge.source === interaction.to && edge.target === interaction.from)) || null;
}

// Light up the participants and edges of one playback step (a sequence hop or a scenario stage).
function spotlightInteractions(interactions) {
  const participants = new Set(interactions.flatMap(item => [item.from, item.to]).filter(Boolean));
  const activeEdges = new Set();
  const unmatched = [];
  interactions.forEach(item => {
    const edge = interactionEdge(item);
    if (edge) activeEdges.add(edge.id);
    else unmatched.push(item);
  });

  document.querySelectorAll('.node-group').forEach(el2 => {
    el2.classList.toggle('selected', participants.has(el2.id.replace('node-', '')));
  });
  document.querySelectorAll('.edge-path').forEach(p => {
    const isActive = activeEdges.has(p.id.replace('path-', ''));
    p.classList.toggle('highlighted', isActive);
    syncEdgeMarker(p);
    p.classList.toggle('dimmed', !isActive);
    p.closest('.edge-group')?.classList.toggle('out-of-focus', !isActive);
  });
  drawGhostSteps(unmatched);
}

function clearSpotlight() {
  ghostLayer.querySelectorAll('.playback-ghost').forEach(item => item.remove());
  document.querySelectorAll('.node-group').forEach(el2 => el2.classList.remove('selected'));
  document.querySelectorAll('.edge-path').forEach(p => { p.classList.remove('highlighted', 'dimmed'); p.closest('.edge-group')?.classList.remove('out-of-focus'); syncEdgeMarker(p); });
  if (state.selectedNodeId) {
    const selected = document.getElementById(`node-${state.selectedNodeId}`);
    if (selected) selected.classList.add('selected');
  }
}

// A playback hop with no modelled edge still has to be visible: draw it as a dashed ghost link.
function drawGhostSteps(steps) {
  ghostLayer.querySelectorAll('.playback-ghost').forEach(item => item.remove());
  steps.forEach(step => {
    const from = nodeById.get(step.from);
    const to = nodeById.get(step.to);
    if (!from || !to) return;

    let geometry;
    if (LAYOUT_DATA.config.router === 'orthogonal') {
      const route = ArchVizOrthogonal.routeOrthogonal({ nodes: LAYOUT_DATA.nodes, boundaries: LAYOUT_DATA.boundaries,
        edges: [{ id: 'playback-hop', source: from.id, target: to.id }] },
        { labelWidths: { 'playback-hop': 0 }, direction: LAYOUT_DATA.config.direction }).routes['playback-hop'];
      geometry = ArchVizOrthogonal.buildRouteGeometry(route, 0, ArchVizGeometry, { source: from, target: to });
    } else {
      geometry = buildEdgeGeometry(from, to, isLRLayout);
    }
    const path = el('path', { class: 'edge-path ghost playback-ghost highlighted', d: geometry.path, 'marker-end': 'url(#arrow-highlight)' });
    withTooltip(path, `${step.label || 'Playback step'} (no modelled edge)`);
    ghostLayer.appendChild(path);
  });
}

function stepSequence(dir) {
  stopSequenceTimer();
  goToSequenceStep(state.sequenceIndex + dir);
}

function toggleSequencePlay() {
  state.sequencePlaying = !state.sequencePlaying;
  setIconLabel(document.getElementById('seq-play'), state.sequencePlaying ? 'ui-pause' : 'ui-play', state.sequencePlaying ? 'Pause' : 'Play');
  if (state.sequencePlaying) {
    scheduleNextStep();
  } else {
    stopSequenceTimer();
  }
}

function scheduleNextStep() {
  const steps = sequenceSteps();
  const current = steps[state.sequenceIndex] || {};
  const delay = typeof current.durationMs === 'number' ? current.durationMs : 1800;
  state.sequenceTimer = setTimeout(() => {
    if (!state.sequencePlaying) return;
    goToSequenceStep(state.sequenceIndex >= steps.length - 1 ? 0 : state.sequenceIndex + 1);
    scheduleNextStep();
  }, delay);
}

function stopSequenceTimer() {
  if (state.sequenceTimer) clearTimeout(state.sequenceTimer);
  state.sequenceTimer = null;
  state.sequencePlaying = false;
  const playBtn = document.getElementById('seq-play');
  if (playBtn) setIconLabel(playBtn, 'ui-play', 'Play');
}

function stopSequencePlayback() {
  stopSequenceTimer();
  clearSpotlight();
}
