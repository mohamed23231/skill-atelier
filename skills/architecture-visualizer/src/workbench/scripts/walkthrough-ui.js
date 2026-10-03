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
    node.classList.toggle('selected', nodes.has(node.id.replace('node-', '')));
  });
  const edges = new Set((focus && focus.primaryEdges) || []);
  document.querySelectorAll('.edge-path').forEach((path) => {
    const isActive = edges.has(path.id.replace('path-', ''));
    path.classList.toggle('highlighted', isActive);
    if (typeof syncEdgeMarker === 'function') syncEdgeMarker(path);
    path.classList.toggle('dimmed', !isActive);
  });
  if (typeof drawGhostSteps === 'function') drawGhostSteps((focus && focus.ghosts) || []);
  drawWalkMarkers((focus && focus.markers) || []);
}

function walkMarkerPoint(marker) {
  if (marker.edgeId) {
    const path = document.getElementById(`path-${marker.edgeId}`);
    if (path && typeof path.getTotalLength === 'function') {
      const length = path.getTotalLength();
      if (length > 0) return path.getPointAtLength(length / 2);
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
  spotlightWalkFocus(focusOfEntry(entries, index, LAYOUT_DATA.edges || []));
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
  if (typeof clearSpotlight === 'function') clearSpotlight();
  actions.setWalkCursor(null);
  actions.setScenarioActive(false);
  renderWalkTrack();
  renderWalkthrough();
  updateUrlState();
}

// Leaving the architecture view stows the walkthrough without forgetting the reader's place.
function suspendWalkthrough() {
  if (!state.scenarioActive) return;
  stopWalkPlayback();
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

function renderWalkTrack() {
  const track = document.querySelector('.walk-track');
  if (!track) return;
  // The track sits over the canvas, whose pointer handlers must not start a pan when it is used.
  if (!walkTrackBound) {
    walkTrackBound = true;
    ['mousedown', 'touchstart'].forEach((type) => track.addEventListener(type, (event) => event.stopPropagation()));
  }
  const previousHeight = track.getBoundingClientRect().height;
  const refitTrack = () => {
    if (!state.userMovedView && track.getBoundingClientRect().height !== previousHeight) {
      window.requestAnimationFrame(() => { if (!state.userMovedView) fitToScreen(); });
    }
  };
  const entries = state.scenarioActive ? walkEntries() : [];
  if (!state.scenarioActive || !entries.length) {
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
  const previous = buildWalkButton('btn-icon walk-prev', 'ui-prev', 'Previous walkthrough entry', () => walkPrev());
  previous.disabled = cursorIndex <= 0;
  const play = buildWalkButton('btn-icon walk-play', walkPlaying ? 'ui-pause' : 'ui-play', walkPlaying ? 'Pause walkthrough' : 'Play walkthrough', () => toggleWalkPlayback());
  play.setAttribute('aria-pressed', String(walkPlaying));
  if (state.prefersReducedMotion) {
    play.disabled = true;
    play.setAttribute('aria-disabled', 'true');
    play.title = 'Play unavailable under reduced motion';
  }
  const next = buildWalkButton('btn-icon walk-next', 'ui-next', 'Next walkthrough entry', () => walkNext());
  next.disabled = cursorIndex >= entries.length - 1;
  controls.append(previous, play, next);

  const count = document.createElement('span');
  count.className = 'walk-count';
  count.textContent = `Step ${stepNumber} of ${total}`;

  const beads = document.createElement('div');
  beads.className = 'walk-beads';
  beads.setAttribute('role', 'presentation');
  entries.forEach((entry) => {
    const bead = document.createElement('button');
    bead.type = 'button';
    bead.className = `walk-bead walk-bead-${walkBeadKind(entry)}`;
    bead.setAttribute('role', 'option');
    bead.setAttribute('data-walk-entry', entry.id);
    bead.setAttribute('data-walk-kind', walkBeadKind(entry));
    bead.setAttribute('aria-label', walkEntryAriaLabel(entry));
    bead.setAttribute('aria-selected', String(entry.id === state.walkCursor));
    if (entry.id === state.walkCursor) bead.classList.add('current');
    const number = document.createElement('span');
    number.className = 'walk-bead-number';
    number.textContent = entry.kind === 'step' ? String(entry.number) : (entry.kind === 'decision' ? '?' : '');
    bead.appendChild(number);
    bead.addEventListener('click', () => walkTo(entry.id));
    beads.appendChild(bead);
  });

  track.append(controls, count, beads);
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

  const narrative = entry.stage?.narrative;
  if (narrative) {
    const text = document.createElement('p');
    text.className = 'walk-item-narrative';
    text.textContent = narrative;
    item.appendChild(text);
  }
  if (entry.stage?.narrativeGenerated) {
    const generated = document.createElement('span');
    generated.className = 'walk-generated';
    generated.textContent = 'generated';
    item.appendChild(generated);
  }
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
    list.appendChild(item);
  });
  if (cursorId) {
    const current = list.querySelector(`[data-walk-entry="${CSS.escape(cursorId)}"]`);
    if (current) current.scrollIntoView({ block: 'nearest' });
  }
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
  select.addEventListener('change', () => startWalkthrough(select.value));
  const list = document.createElement('ol');
  list.className = 'walk-list';
  list.setAttribute('data-walk-list', '');
  target.append(select, list);
  renderWalkthrough();
}
