function flattenScenarioStages(stages, group = 'serial', depth = 0) {
  const result = [];
  (stages || []).forEach(stage => {
    result.push({ ...stage, group, depth });
    if (stage.kind === 'branch') {
      (stage.branches || []).forEach(branch => {
        const branchStages = flattenScenarioStages(branch.stages, `branch: ${branch.name || branch.condition || branch.id || 'condition'}`, depth + 1);
        branchStages.forEach(child => {
          if (!child.branchStatus) child.branchStatus = branch.status;
          if (!child.branchRecovery) child.branchRecovery = branch.recovery || branch.failure;
        });
        result.push(...branchStages);
      });
    }
  });
  return result;
}

function selectedScenario() {
  const scenarios = ARCH_SPEC.scenarios || [];
  return scenarios.find(item => item.id === state.scenarioId) || scenarios[0] || null;
}

function renderScenarioStage() {
  const target = document.querySelector('[data-scenario-stage]');
  const scenario = selectedScenario();
  if (!target || !scenario) return;
  const stages = flattenScenarioStages(scenario.stages);
  actions.setScenarioStage(Math.max(0, Math.min(state.scenarioStage, Math.max(stages.length - 1, 0))));
  const stage = stages[state.scenarioStage];
  target.replaceChildren();
  if (!stage) {
    target.textContent = 'This scenario has no stages.';
    return;
  }
  target.className = 'workbench-stage';
  const interactions = stageInteractions(stage);
  const status = stage.status || interactions.find(item => item.status)?.status || stage.branchStatus || (stage.optional ? 'optional' : 'ready');
  const nodeName = id => nodeById.get(id)?.label || id;
  target.setAttribute('data-stage-status', status);
  appendReviewField(target, 'Stage', `${state.scenarioStage + 1}/${stages.length} · ${stage.name || stage.label || stage.id || stage.kind || 'stage'}`);
  appendReviewField(target, 'Group', stage.kind === 'branch' ? `decision: ${stage.condition || 'condition'}` : (stage.group || stage.kind || 'serial'));
  appendReviewField(target, 'Status', status);
  appendReviewField(target, 'Participants', [...new Set(interactions.flatMap(item => [item.from, item.to]).filter(Boolean))].map(nodeName));
  appendReviewField(target, 'Interactions', interactions.map(item => item.label || item.id));
  appendReviewField(target, 'Payload / metadata', interactions.map(item => item.payload || item.metadata).filter(Boolean));
  appendReviewField(target, 'Failure / recovery', stage.failure || stage.recovery || stage.onFailure
    || interactions.map(item => item.failure || item.recovery).filter(Boolean).join(' · ')
    || stage.branchRecovery || 'Not specified');
  if (state.scenarioActive) spotlightInteractions(interactions);
  const slider = document.querySelector('[data-scenario-scrubber]');
  slider.max = Math.max(stages.length - 1, 0);
  slider.value = state.scenarioStage;
  announceStatus(`${scenario.name || scenario.id}, stage ${state.scenarioStage + 1} of ${stages.length}, ${status}.`);
  updateUrlState();
}

// A branch stage has no hops of its own; it stands for every path it can take.
function stageInteractions(stage) {
  if (stage.kind !== 'branch') return stage.interactions || [];
  const collect = stages => (stages || []).flatMap(child => [...(child.interactions || []), ...(child.branches || []).flatMap(b => collect(b.stages))]);
  return (stage.branches || []).flatMap(branch => collect(branch.stages));
}

function activateScenario() {
  if (state.currentView !== VIEWS.ARCHITECTURE) switchView(VIEWS.ARCHITECTURE);
  actions.setScenarioActive(true);
}

function deactivateScenario() {
  if (!state.scenarioActive) return;
  actions.setScenarioActive(false);
  stopScenarioPlayback();
  clearSpotlight();
  updateUrlState();
}

function selectScenario(id) {
  const scenario = (ARCH_SPEC.scenarios || []).find(item => item.id === id);
  if (!scenario) return;
  activateScenario();
  actions.setScenario(scenario.id);
  actions.setScenarioStage(0);
  renderScenarioStage();
}

function stepScenario(delta) {
  activateScenario();
  actions.setScenarioStage(state.scenarioStage + delta);
  renderScenarioStage();
}

function stopScenarioPlayback() {
  if (state.scenarioTimer) window.clearInterval(state.scenarioTimer);
  state.scenarioTimer = null;
  const button = document.querySelector('[data-scenario-play]');
  if (button) button.setAttribute('aria-pressed', 'false');
}

function toggleScenarioPlayback() {
  if (state.scenarioTimer || state.prefersReducedMotion) {
    stopScenarioPlayback();
    return;
  }
  activateScenario();
  document.querySelector('[data-scenario-play]').setAttribute('aria-pressed', 'true');
  state.scenarioTimer = window.setInterval(() => {
    const stages = flattenScenarioStages(selectedScenario()?.stages);
    actions.setScenarioStage(stages.length ? (state.scenarioStage + 1) % stages.length : 0);
    renderScenarioStage();
  }, 1400);
}

function renderScenarioNavigator() {
  const target = document.querySelector('[data-navigator-section="scenarios"]');
  const scenarios = ARCH_SPEC.scenarios || [];
  target.replaceChildren();
  if (!scenarios.length) {
    target.textContent = 'No named scenarios in this model.';
    return;
  }
  actions.setScenario(state.scenarioId || scenarios[0].id);
  const player = document.createElement('div');
  player.className = 'workbench-scenario-player';
  const select = document.createElement('select');
  select.className = 'workbench-scenario-control';
  select.setAttribute('data-scenario-select', '');
  select.setAttribute('aria-label', 'Scenario');
  scenarios.forEach(scenario => {
    const option = document.createElement('option');
    option.value = scenario.id;
    option.textContent = scenario.name || scenario.id;
    select.appendChild(option);
  });
  select.value = state.scenarioId;
  select.addEventListener('change', () => selectScenario(select.value));
  const toolbar = document.createElement('div');
  toolbar.className = 'workbench-scenario-toolbar';
  const previous = document.createElement('button');
  previous.type = 'button'; previous.innerHTML = iconMarkup('ui-prev'); previous.setAttribute('aria-label', 'Previous scenario stage');
  previous.addEventListener('click', () => stepScenario(-1));
  const play = document.createElement('button');
  play.type = 'button'; play.innerHTML = iconMarkup('ui-play'); play.setAttribute('aria-label', 'Play scenario'); play.setAttribute('aria-pressed', 'false'); play.setAttribute('data-scenario-play', '');
  play.addEventListener('click', toggleScenarioPlayback);
  const next = document.createElement('button');
  next.type = 'button'; next.innerHTML = iconMarkup('ui-next'); next.setAttribute('aria-label', 'Next scenario stage');
  next.addEventListener('click', () => stepScenario(1));
  const scrubber = document.createElement('input');
  scrubber.type = 'range'; scrubber.min = '0'; scrubber.value = '0'; scrubber.setAttribute('data-scenario-scrubber', ''); scrubber.setAttribute('aria-label', 'Scenario stage');
  scrubber.addEventListener('input', () => { activateScenario(); actions.setScenarioStage(Number(scrubber.value)); renderScenarioStage(); });
  const stage = document.createElement('div');
  stage.setAttribute('data-scenario-stage', '');
  toolbar.append(previous, play, next, scrubber);
  player.append(select, toolbar, stage);
  target.appendChild(player);
  renderScenarioStage();
}
