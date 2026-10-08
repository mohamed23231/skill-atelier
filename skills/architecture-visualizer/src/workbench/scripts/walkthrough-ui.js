// Renders and drives the scenario walkthrough. The path itself is pure (walkthrough.js); this file
// turns it into the canvas spotlight, the numbered track and the Walkthrough chapter, and owns the
// keys, playback timer and URL round-trip. It reads state but only writes through `actions`.

const WALK_DEFAULT_DELAY = 2600;

let walkTimer = null;
let walkPlaying = false;
let walkTrackBound = false;

function walkEntries() {
  return linearizeScenario(selectedScenario(), state.walkChoices);
}

function walkEntryIndex(entries, id) {
  return (Array.isArray(entries) ? entries : []).findIndex((entry) => entry && entry.id === id);
}

function walkCurrent() {
  const entries = walkEntries();
  const index = walkEntryIndex(entries, state.walkCursor);
  return index < 0 ? null : { entries, index, entry: entries[index] };
}

function walkNodeLabel(id) {
  return nodeById.get(id)?.label || id;
}

// Flattened position of an entry's stage, so existing links and the stage count keep working.
function walkStageIndex(entry) {
  const scenario = selectedScenario();
  if (!scenario || !entry) return -1;
  return flattenScenarioStages(scenario.stages).findIndex((stage) => stage.id === entry.id);
}

function walkStartDelay(entry) {
  const stage = entry && entry.stage;
  return stage && typeof stage.durationMs === 'number' ? stage.durationMs : WALK_DEFAULT_DELAY;
}

function walkIsActive() {
  return Boolean(state.scenarioActive && state.walkCursor);
}

// Light the focused nodes and edges, dim the rest, and draw ghosts plus numbered parallel markers.
function spotlightWalkFocus(focus) {
  const nodes = new Set((focus && focus.primaryNodes) || []);
  document.querySelectorAll('.node-group').forEach((node) => {
    const inStep = nodes.has(node.id.replace('node-', ''));
    node.classList.toggle('selected', inStep);
    node.classList.toggle('walk-active', inStep);
    node.classList.toggle('out-of-focus', nodes.size > 0 && !inStep);
  });
  const edges = new Set((focus && focus.primaryEdges) || []);
  document.querySelectorAll('.edge-path').forEach((path) => {
    const isActive = edges.has(path.id.replace('path-', ''));
    path.classList.toggle('highlighted', isActive);
    if (typeof syncEdgeMarker === 'function') syncEdgeMarker(path);
    path.classList.toggle('dimmed', !isActive);
    path.closest('.edge-group')?.classList.toggle('out-of-focus', !isActive);
  });
  if (typeof drawGhostSteps === 'function') drawGhostSteps((focus && focus.ghosts) || []);
  drawWalkMarkers((focus && focus.markers) || []);
}

function walkMarkerPoint(marker) {
  if (marker.edgeId) {
    const path = document.getElementById(`path-${marker.edgeId}`);
    if (path && typeof path.getTotalLength === 'function') {
      const length = path.getTotalLength();
      // Sit on the line where no label is, so the number never covers a label's text.
      const labels = (LAYOUT_DATA.edges || []).filter(edge => edge.labelBounds).map(edge => edge.labelBounds);
      const clear = point => labels.every(b => point.x < b.left - 14 || point.x > b.left + b.width + 14 || point.y < b.top - 14 || point.y > b.top + b.height + 14);
      if (length > 0) {
        for (const t of [0.5, 0.35, 0.65, 0.25, 0.75, 0.18, 0.82]) {
          const point = path.getPointAtLength(length * t);
          if (clear(point)) return point;
        }
        return path.getPointAtLength(length / 2);
      }
    }
  }
  const from = nodeById.get(marker.from);
  const to = nodeById.get(marker.to);
  if (!from || !to) return null;
  return {
    x: (from.x + from.width / 2 + to.x + to.width / 2) / 2,
    y: (from.y + from.height / 2 + to.y + to.height / 2) / 2
  };
}

function drawWalkMarkers(markers) {
  if (!Array.isArray(markers) || markers.length === 0) return;
  markers.forEach((marker) => {
    const point = walkMarkerPoint(marker);
    if (!point) return;
    const group = el('g', { class: 'walk-marker', 'data-walk-marker': String(marker.n) });
    group.appendChild(el('circle', { class: 'walk-marker-dot', cx: point.x, cy: point.y, r: 11 }));
    const text = el('text', { class: 'walk-marker-number', x: point.x, y: point.y + 4 });
    text.textContent = String(marker.n);
    group.appendChild(text);
    ghostLayer.appendChild(group);
  });
}

function applyWalkFocus(entries, index) {
  const focus = focusOfEntry(entries, index, LAYOUT_DATA.edges || []);
  spotlightWalkFocus(focus);
  frameWalkFocus(focus);
  playWalkPackets(entries, index);
}

// Each step glides the camera to its participants; never smaller than the whole diagram's fit.
let walkCameraFrame = null;
function frameWalkFocus(focus) {
  frameModelNodes(focus.primaryNodes || [], focus.primaryEdges || []);
}

// Glides the camera to frame these components and connections, never smaller than the whole fit.
function frameModelNodes(nodeIds, edgeIdList) {
  const ids = new Set(nodeIds);
  const nodes = (LAYOUT_DATA.nodes || []).filter(node => ids.has(node.id) && !isNodeHidden(node));
  if (!nodes.length) return;
  const edgeIds = new Set(edgeIdList);
  const boxes = nodes.map(node => ({ minX: node.x, minY: node.y, maxX: node.x + node.width, maxY: node.y + node.height }))
    .concat((LAYOUT_DATA.edges || []).filter(edge => edgeIds.has(edge.id) && edge.totalVisualBounds).map(edge => edge.totalVisualBounds));
  const pad = 72;
  const box = { minX: Math.min(...boxes.map(b => b.minX)) - pad, minY: Math.min(...boxes.map(b => b.minY)) - pad,
    maxX: Math.max(...boxes.map(b => b.maxX)) + pad, maxY: Math.max(...boxes.map(b => b.maxY)) + pad };
  const safe = canvasSafeArea();
  const fit = fitCamera();
  const zoom = clampZoom(Math.min(safe.width / (box.maxX - box.minX), safe.height / (box.maxY - box.minY), 1));
  // When the group needs the whole diagram anyway, use exactly the whole-diagram view.
  if (zoom <= fit.zoom * 1.05) {
    animateWalkCamera(fit);
    return;
  }
  animateWalkCamera({ zoom, panX: safe.left + safe.width / 2 - (box.minX + box.maxX) * zoom / 2,
    panY: safe.top + safe.height / 2 - (box.minY + box.maxY) * zoom / 2 });
}

function animateWalkCamera(target) {
  window.cancelAnimationFrame(walkCameraFrame);
  if (state.prefersReducedMotion || restoringViewState || !viewStateReady) {
    actions.setCamera({ ...target, userMoved: false });
    updateTransform();
    return;
  }
  const from = { zoom: state.zoom, panX: state.panX, panY: state.panY };
  actions.setCamera({ userMoved: false });
  const start = performance.now();
  const tick = now => {
    // A reader who pans or zooms mid-glide keeps their view.
    if (state.userMovedView) return;
    const t = Math.min(1, (now - start) / 420);
    const k = 1 - Math.pow(1 - t, 3);
    actions.setCamera({ zoom: from.zoom + (target.zoom - from.zoom) * k, panX: from.panX + (target.panX - from.panX) * k,
      panY: from.panY + (target.panY - from.panY) * k });
    updateTransform();
    if (t < 1) walkCameraFrame = window.requestAnimationFrame(tick);
  };
  walkCameraFrame = window.requestAnimationFrame(tick);
}

// A packet travels each hop of the current step, again after a pause, until the step changes.
// Recovery outcomes travel in the warning colour. Reduced motion shows the highlight alone.
let walkPacketTimer = null;
let walkPacketRun = 0;
function walkPacketsLayer() {
  let layer = document.getElementById('walk-packets');
  if (!layer) {
    layer = el('g', { id: 'walk-packets', 'aria-hidden': 'true' });
    particlesLayer.parentNode.appendChild(layer);
  }
  return layer;
}

function stopWalkPackets() {
  walkPacketRun += 1;
  window.clearTimeout(walkPacketTimer);
  document.getElementById('walk-packets')?.replaceChildren();
}

function playWalkPackets(entries, index) {
  stopWalkPackets();
  const entry = entries[index];
  if (state.prefersReducedMotion || !entry || entry.kind !== 'step') return;
  const decisionIndex = entries.findIndex(item => item.kind === 'decision');
  const decision = entries[decisionIndex];
  const recovery = decisionIndex >= 0 && index > decisionIndex && decision.branches[decision.chosen]?.status === 'recovery';
  const hops = (entry.interactions || []).map(hop => {
    const edgeId = walkEdgeId(hop, LAYOUT_DATA.edges || []);
    const edge = edgeById.get(edgeId);
    const path = document.getElementById(`path-${edgeId}`);
    return edge && path ? { path, reverse: edge.source === hop.to && edge.target === hop.from } : null;
  }).filter(Boolean);
  if (!hops.length) return;
  const run = walkPacketRun;
  const layer = walkPacketsLayer();
  const duration = 1100;
  const once = () => {
    if (run !== walkPacketRun) return;
    hops.forEach((hop, i) => {
      const group = el('g', { class: recovery ? 'walk-packet recovery' : 'walk-packet' });
      group.appendChild(el('circle', { class: 'walk-packet-halo', r: '9' }));
      group.appendChild(el('circle', { class: 'walk-packet-core', r: '4.5' }));
      layer.appendChild(group);
      const length = hop.path.getTotalLength();
      // Parallel hops travel together; sequential hops in one step follow each other.
      const delay = entry.parallel ? 0 : i * duration * 0.6;
      const start = performance.now() + delay;
      const tick = now => {
        if (run !== walkPacketRun || !group.isConnected) return;
        const t = Math.max(0, Math.min(1, (now - start) / duration));
        const point = hop.path.getPointAtLength(length * (hop.reverse ? 1 - t : t));
        group.setAttribute('transform', `translate(${point.x},${point.y})`);
        group.style.opacity = t > 0 && t < 1 ? '1' : '0';
        if (t < 1) window.requestAnimationFrame(tick);
        else group.remove();
      };
      window.requestAnimationFrame(tick);
    });
    const total = (entry.parallel ? 1 : 1 + (hops.length - 1) * 0.6) * duration;
    walkPacketTimer = window.setTimeout(once, total + 900);
  };
  once();
}

function walkAnnouncement(entries, index) {
  const entry = entries[index];
  if (!entry) return '';
  if (entry.kind === 'decision') return `Decision: ${entry.stage?.condition || entry.id}`;
  if (entry.kind === 'end') return `Outcome: ${entry.branch?.name || 'End'}`;
  const total = walkthroughTotal(entries);
  const name = entry.stage?.name || entry.stage?.label || entry.id;
  const hops = entry.interactions || [];
  const first = hops[0] || entry.stage || {};
  return `Step ${entry.number} of ${total}, ${name}, ${walkNodeLabel(first.from)} to ${walkNodeLabel(first.to)}`;
}

function syncScenarioFromEntry(entry) {
  const index = walkStageIndex(entry);
  if (index >= 0) actions.setScenarioStage(index);
}

function walkTo(entryId) {
  const entries = walkEntries();
  const index = walkEntryIndex(entries, entryId);
  if (index < 0) return;
  actions.setScenarioActive(true);
  actions.setWalkCursor(entryId);
  const entry = entries[index];
  syncScenarioFromEntry(entry);
  applyWalkFocus(entries, index);
  announceStatus(walkAnnouncement(entries, index));
  updateUrlState();
  renderWalkTrack();
  renderWalkthrough();
}

function walkNext() {
  if (!walkIsActive()) {
    startWalkthrough((ARCH_SPEC.scenarios || [])[0]?.id);
    return;
  }
  const current = walkCurrent();
  if (!current) return;
  const next = current.entries[current.index + 1];
  if (next) walkTo(next.id);
}

function walkPrev() {
  if (!walkIsActive()) {
    startWalkthrough((ARCH_SPEC.scenarios || [])[0]?.id);
    return;
  }
  const current = walkCurrent();
  if (!current) return;
  const previous = current.entries[current.index - 1];
  if (previous) walkTo(previous.id);
}

function chooseOutcome(decisionId, index) {
  if (!Number.isInteger(index) || index < 0) return;
  actions.setWalkChoice(decisionId, index);
  walkTo(decisionId);
}

function startWalkthrough(scenarioId, choices) {
  const scenario = (ARCH_SPEC.scenarios || []).find((item) => item.id === scenarioId);
  if (!scenario) return;
  activateScenario();
  actions.setScenario(scenario.id);
  actions.setWalkChoices(choices || {});
  // Starting from the track, a key or the palette brings the reader to the steps in the rail.
  if (viewStateReady && !restoringViewState && state.chapter !== 'walkthrough') openChapter('walkthrough');
  const entries = walkEntries();
  if (!entries.length) {
    actions.setWalkCursor(null);
    renderWalkTrack();
    renderWalkthrough();
    return;
  }
  walkTo(entries[0].id);
}

function endWalkthrough() {
  stopWalkPlayback();
  stopWalkPackets();
  if (typeof clearSpotlight === 'function') clearSpotlight();
  actions.setWalkCursor(null);
  actions.setScenarioActive(false);
  renderWalkTrack();
  renderWalkthrough();
  updateUrlState();
  // Ending returns to the whole diagram.
  if (!state.userMovedView) fitToScreen();
}

// Leaving the architecture view stows the walkthrough without forgetting the reader's place.
function suspendWalkthrough() {
  if (!state.scenarioActive) return;
  stopWalkPlayback();
  stopWalkPackets();
  actions.setScenarioActive(false);
  renderWalkTrack();
}

function stopScenarioPlayback() {
  stopWalkPlayback();
}

function deactivateScenario() {
  endWalkthrough();
}

function selectScenario(id) {
  startWalkthrough(id);
}

function walkPlaybackNote() {
  return state.prefersReducedMotion ? 'Play is unavailable under reduced motion.' : '';
}

function startWalkPlayback() {
  const current = walkCurrent();
  if (!current) return;
  walkPlaying = true;
  renderWalkTrack();
  scheduleWalkStep();
}

function scheduleWalkStep() {
  const current = walkCurrent();
  if (!current || !walkPlaying) return;
  walkTimer = window.setTimeout(() => {
    if (!walkPlaying) return;
    const next = current.entries[current.index + 1];
    if (!next) {
      stopWalkPlayback();
      return;
    }
    walkTo(next.id);
    scheduleWalkStep();
  }, walkStartDelay(current.entry));
}

function stopWalkPlayback() {
  if (walkTimer) window.clearTimeout(walkTimer);
  walkTimer = null;
  if (!walkPlaying) return;
  walkPlaying = false;
  renderWalkTrack();
}

function toggleWalkPlayback() {
  if (state.prefersReducedMotion) {
    announceStatus('Play is unavailable under reduced motion.');
    return;
  }
  if (walkPlaying) stopWalkPlayback();
  else startWalkPlayback();
}

// Returns true when the event was consumed by the walkthrough; plain arrows fall through to panning.
function handleWalkthroughKey(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target;
  const onControl = Boolean(target && typeof target.closest === 'function' && target.closest('button, a, input, select, textarea'));
  if (event.key === ' ' || event.key === 'Spacebar') {
    if (!walkIsActive() || onControl) return false;
    event.preventDefault();
    toggleWalkPlayback();
    return true;
  }
  const isNext = event.key === 'ArrowRight' || event.key === 'j' || event.key === 'J';
  const isPrev = event.key === 'ArrowLeft' || event.key === 'k' || event.key === 'K';
  if (!isNext && !isPrev) return false;
  if (walkIsActive()) {
    event.preventDefault();
    if (isNext) walkNext();
    else walkPrev();
    return true;
  }
  if (event.key === 'j' || event.key === 'J' || event.key === 'k' || event.key === 'K') {
    event.preventDefault();
    startWalkthrough((ARCH_SPEC.scenarios || [])[0]?.id);
    return true;
  }
  return false;
}

function walkBeadKind(entry) {
  if (entry.kind !== 'step') return entry.kind;
  return entry.parallel ? 'parallel' : 'step';
}

function walkEntryAriaLabel(entry) {
  if (entry.kind === 'decision') return `Decision: ${entry.stage?.condition || entry.id}`;
  if (entry.kind === 'end') return `Outcome: ${entry.branch?.name || 'End'}`;
  return `Step ${entry.number}: ${entry.stage?.name || entry.stage?.label || entry.id}`;
}

function buildWalkButton(className, icon, label, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.setAttribute('aria-label', label);
  button.innerHTML = iconMarkup(icon);
  button.addEventListener('click', handler);
  return button;
}

// Steps across the main path and every outcome, as the track numbers them.
function walkAllStepsTotal(scenario) {
  const entries = linearizeScenario(scenario, {});
  const decisionIndex = entries.findIndex(entry => entry.kind === 'decision');
  if (decisionIndex < 0) return walkthroughTotal(entries);
  let total = walkthroughTotal(entries.slice(0, decisionIndex));
  entries[decisionIndex].branches.forEach(branch => {
    const branchEntries = [];
    walkStages(branch.stages, {}, branchEntries, { next: total + 1 });
    total += walkthroughTotal(branchEntries);
  });
  return total;
}

function renderWalkTrack() {
  const track = document.querySelector('.walk-track');
  if (!track) return;
  // The track sits over the canvas, whose pointer handlers must not start a pan when it is used.
  if (!walkTrackBound) {
    walkTrackBound = true;
    ['mousedown', 'touchstart'].forEach((type) => track.addEventListener(type, (event) => event.stopPropagation()));
    // The idle track also needs clearance, and its lanes can grow or wrap on resize.
    new ResizeObserver(() => {
      document.body.style.setProperty('--walk-track-height', `${track.getBoundingClientRect().height}px`);
    }).observe(track);
  }
  const previousHeight = track.getBoundingClientRect().height;
  const refitTrack = () => {
    document.body.style.setProperty('--walk-track-height', `${track.getBoundingClientRect().height}px`);
    if (!state.userMovedView && track.getBoundingClientRect().height !== previousHeight) {
      window.requestAnimationFrame(() => { if (!state.userMovedView) fitToScreen(); });
    }
  };
  const scenario = selectedScenario() || (ARCH_SPEC.scenarios || [])[0];
  const active = walkIsActive();
  const entries = active ? walkEntries() : linearizeScenario(scenario, {});
  if (!entries.length) {
    track.hidden = true;
    track.replaceChildren();
    refitTrack();
    return;
  }
  track.hidden = false;
  const total = walkthroughTotal(entries);
  const cursorIndex = Math.max(0, walkEntryIndex(entries, state.walkCursor));
  const current = entries[cursorIndex] || null;
  const stepNumber = entries.slice(0, cursorIndex + 1).filter((entry) => entry.kind === 'step').length;

  track.replaceChildren();

  const controls = document.createElement('div');
  controls.className = 'walk-track-controls';
  const previous = buildWalkButton('btn-icon walk-prev', 'ui-chevron-left', 'Previous walkthrough entry', () => walkPrev());
  previous.disabled = cursorIndex <= 0;
  const play = buildWalkButton('btn-icon walk-play', walkPlaying ? 'ui-pause' : 'ui-play', walkPlaying ? 'Pause walkthrough' : 'Play walkthrough', () => { if (!walkIsActive()) startWalkthrough(scenario.id); toggleWalkPlayback(); });
  play.setAttribute('aria-pressed', String(walkPlaying));
  if (state.prefersReducedMotion) {
    play.disabled = true;
    play.setAttribute('aria-disabled', 'true');
    play.title = 'Play unavailable under reduced motion';
  }
  const next = buildWalkButton('btn-icon walk-next', 'ui-chevron-right', 'Next walkthrough entry', () => walkNext());
  next.disabled = cursorIndex >= entries.length - 1;
  controls.append(previous, play, next);

  const count = document.createElement('span');
  count.className = 'walk-count';
  count.textContent = active ? `Step ${stepNumber} of ${total}` : 'Start';
  const length = document.createElement('span');
  length.className = 'walk-length';
  length.textContent = `${walkAllStepsTotal(scenario)} steps`;
  length.hidden = active;
  controls.append(count, length);

  const beads = document.createElement('div');
  beads.className = 'walk-beads';
  beads.setAttribute('role', 'presentation');
  const makeBead = (entry, choose) => {
    const bead = document.createElement('button');
    bead.type = 'button';
    bead.className = `walk-bead walk-bead-${walkBeadKind(entry)}`;
    bead.setAttribute('role', 'option');
    bead.setAttribute('data-walk-entry', entry.id);
    bead.setAttribute('data-walk-kind', walkBeadKind(entry));
    bead.setAttribute('aria-label', walkEntryAriaLabel(entry));
    const selected = active && !choose && entry.id === state.walkCursor;
    bead.setAttribute('aria-selected', String(selected));
    bead.classList.toggle('current', selected);
    const number = document.createElement('span');
    number.className = 'walk-bead-number';
    number.textContent = entry.kind === 'step' ? String(entry.number) : entry.kind === 'decision' ? '◇ Decision' : entry.branch?.name || 'End';
    bead.appendChild(number);
    if (entry.parallel) {
      const ticks = document.createElement('span');
      ticks.className = 'walk-parallel-ticks';
      ticks.setAttribute('aria-hidden', 'true');
      entry.interactions.forEach(() => ticks.appendChild(document.createElement('i')));
      bead.appendChild(ticks);
    }
    bead.addEventListener('click', () => {
      if (!walkIsActive()) startWalkthrough(scenario.id);
      if (choose) chooseOutcome(choose.id, choose.index);
      walkTo(entry.id);
    });
    return bead;
  };
  const lane = (label, entries, choose) => {
    const row = document.createElement('div');
    row.className = 'walk-lane';
    const tag = document.createElement('span');
    tag.className = 'walk-lane-label';
    tag.textContent = label;
    tag.title = label;
    row.appendChild(tag);
    entries.forEach(entry => row.appendChild(makeBead(entry, choose)));
    beads.appendChild(row);
    return row;
  };
  const decisionIndex = entries.findIndex(entry => entry.kind === 'decision');
  lane('Main path', decisionIndex < 0 ? entries : entries.slice(0, decisionIndex + 1));
  // Every outcome lane shows, idle or not, so a reader sees where the story can go before starting.
  if (decisionIndex >= 0) {
    const decision = entries[decisionIndex];
    decision.branches.forEach((branch, index) => {
      const branchEntries = [];
      const counter = { next: walkthroughTotal(entries.slice(0, decisionIndex)) + 1 };
      walkStages(branch.stages, active ? state.walkChoices : {}, branchEntries, counter);
      if (!branchEntries.length) branchEntries.push({ kind: 'end', id: `end:${decision.id}`, decisionId: decision.id, branch });
      const row = lane(`\u21b3 ${branch.name || branch.condition || `Outcome ${index + 1}`}`, branchEntries,
        index === decision.chosen ? null : { id: decision.id, index });
      row.dataset.walkOutcomeLane = String(index);
      row.dataset.chosen = String(index === decision.chosen);
    });
  }
  track.append(controls, beads);
  if (current && walkPlaybackNote()) {
    const note = document.createElement('span');
    note.className = 'walk-note';
    note.textContent = walkPlaybackNote();
    track.appendChild(note);
  }
  refitTrack();
}

function walkChapterStep(entry) {
  const item = document.createElement('li');
  item.className = 'walk-item walk-item-step';
  item.setAttribute('data-walk-entry', entry.id);
  item.setAttribute('data-walk-kind', walkBeadKind(entry));

  const head = document.createElement('div');
  head.className = 'walk-item-head';
  const number = document.createElement('span');
  number.className = 'walk-item-number';
  number.textContent = String(entry.number);
  const name = document.createElement('span');
  name.className = 'walk-item-name';
  name.textContent = entry.stage?.name || entry.stage?.label || entry.id;
  head.append(number, name);
  item.appendChild(head);

  if (entry.parallel) {
    const tag = document.createElement('span');
    tag.className = 'walk-item-tag';
    tag.textContent = 'parallel';
    item.appendChild(tag);
  }

  // A generated narrative's payload sentences repeat the payload table below; the table says it better.
  const narrative = entry.stage?.narrativeGenerated
    ? String(entry.stage?.narrative || '').replace(/ Payload: .*?\.(?=\s|$)/g, '')
    : entry.stage?.narrative;
  if (narrative) {
    const text = document.createElement('p');
    text.className = 'walk-item-narrative';
    text.textContent = narrative;
    item.appendChild(text);
  }
  if (entry.stage?.narrativeGenerated) {
    const generated = document.createElement('span');
    generated.className = 'walk-generated';
    generated.textContent = 'Generated from step data';
    item.appendChild(generated);
  }
  (entry.interactions || []).forEach(hop => {
    const route = document.createElement('p');
    route.className = 'walk-item-route';
    route.textContent = `${walkNodeLabel(hop.from)} → ${walkNodeLabel(hop.to)}${hop.label ? ` · ${hop.label}` : ''}`;
    item.appendChild(route);
    const payload = hop.payload || entry.stage?.payload;
    if (payload && typeof payload === 'object') {
      const table = document.createElement('table');
      table.className = 'walk-payload';
      const body = document.createElement('tbody');
      Object.entries(payload).forEach(([key, value]) => {
        const row = document.createElement('tr');
        const label = document.createElement('th');
        label.scope = 'row';
        label.textContent = key;
        const cell = document.createElement('td');
        cell.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);
        row.append(label, cell);
        body.appendChild(row);
      });
      table.appendChild(body);
      item.appendChild(table);
    }
  });
  return item;
}

function walkChapterDecision(entry) {
  const item = document.createElement('li');
  item.className = 'walk-item walk-item-decision';
  item.setAttribute('data-walk-entry', entry.id);
  item.setAttribute('data-walk-kind', 'decision');

  const condition = document.createElement('p');
  condition.className = 'walk-condition';
  condition.textContent = `Decision: ${entry.stage?.condition || entry.id}`;
  item.appendChild(condition);

  const outcomes = document.createElement('div');
  outcomes.className = 'walk-outcomes';
  entry.branches.forEach((branch, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'walk-outcome';
    button.setAttribute('data-walk-outcome', String(index));
    button.setAttribute('aria-pressed', String(index === entry.chosen));
    button.textContent = branch?.name || branch?.condition || `Outcome ${index + 1}`;
    button.addEventListener('click', () => chooseOutcome(entry.id, index));
    outcomes.appendChild(button);
  });
  item.appendChild(outcomes);
  return item;
}

function walkChapterEnd(entry) {
  const item = document.createElement('li');
  item.className = 'walk-item walk-item-end';
  item.setAttribute('data-walk-entry', entry.id);
  item.setAttribute('data-walk-kind', 'end');
  const name = document.createElement('p');
  name.className = 'walk-outcome-name';
  name.textContent = `Outcome: ${entry.branch?.name || 'End'}`;
  item.appendChild(name);
  return item;
}

// A step, decision or outcome card in the Walkthrough chapter goes to that point of the story when
// clicked or activated with Enter or Space; controls inside it (outcome buttons) keep their own action.
function makeWalkItemActivatable(item, entry, scenario) {
  item.tabIndex = 0;
  item.classList.add('walk-item-activatable');
  const label = entry.kind === 'step' ? `Go to step ${entry.number}: ${entry.stage?.name || entry.id}`
    : entry.kind === 'decision' ? `Go to the decision: ${entry.stage?.condition || entry.id}` : `Go to the outcome: ${entry.branch?.name || 'end'}`;
  item.setAttribute('aria-label', label);
  const go = () => {
    if (!walkIsActive()) startWalkthrough(scenario.id, state.walkChoices);
    walkTo(entry.id);
  };
  item.addEventListener('click', event => {
    if (event.target.closest('button, a, input, select, textarea')) return;
    go();
  });
  item.addEventListener('keydown', event => {
    if (event.target !== item || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    go();
  });
}

function renderWalkthrough() {
  const list = document.querySelector('[data-walk-list]');
  const select = document.querySelector('[data-scenario-select]');
  if (select && state.scenarioId) select.value = state.scenarioId;
  if (!list) return;
  list.replaceChildren();
  const scenario = selectedScenario();
  if (!scenario) return;
  const entries = walkEntries();
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'rail-muted';
    empty.textContent = 'This scenario has no steps.';
    list.appendChild(empty);
    return;
  }
  const cursorId = state.scenarioActive ? state.walkCursor : null;
  entries.forEach((entry) => {
    const item = entry.kind === 'step' ? walkChapterStep(entry)
      : entry.kind === 'decision' ? walkChapterDecision(entry)
        : walkChapterEnd(entry);
    if (cursorId && entry.id === cursorId) item.classList.add('current');
    makeWalkItemActivatable(item, entry, scenario);
    list.appendChild(item);
  });
  scrollRailToWalkCursor();
}

// Keeps the current step's card in view inside the docked rail. Only the rail scrolls: a stacked
// page is never jumped around under the reader.
function scrollRailToWalkCursor() {
  const cursorId = state.scenarioActive ? state.walkCursor : null;
  const body = document.querySelector('.rail-body');
  const current = cursorId && document.querySelector(`[data-walk-list] [data-walk-entry="${CSS.escape(cursorId)}"]`);
  if (!body || !current || isStackedLayout() || body.scrollHeight <= body.clientHeight) return;
  const top = current.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
  const target = Math.max(0, top - 24);
  body.scrollTo({ top: target, behavior: state.prefersReducedMotion ? 'auto' : 'smooth' });
}

function renderScenarioNavigator() {
  const target = document.querySelector('[data-navigator-section="scenarios"]');
  if (!target) return;
  const scenarios = ARCH_SPEC.scenarios || [];
  target.replaceChildren();
  if (!scenarios.length) {
    target.textContent = 'No named scenarios in this model.';
    return;
  }
  if (!state.scenarioId) actions.setScenario(scenarios[0].id);
  const select = document.createElement('select');
  select.className = 'workbench-scenario-control';
  select.setAttribute('data-scenario-select', '');
  select.setAttribute('aria-label', 'Scenario');
  scenarios.forEach((scenario) => {
    const option = document.createElement('option');
    option.value = scenario.id;
    option.textContent = scenario.name || scenario.id;
    select.appendChild(option);
  });
  select.value = state.scenarioId;
  select.hidden = scenarios.length < 2;
  select.addEventListener('change', () => startWalkthrough(select.value));
  const list = document.createElement('ol');
  list.className = 'walk-list';
  list.setAttribute('data-walk-list', '');
  target.append(select, list);
  renderWalkthrough();
  renderWalkTrack();
}
