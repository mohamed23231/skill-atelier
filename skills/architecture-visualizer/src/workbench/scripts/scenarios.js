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

function activateScenario() {
  if (state.currentView !== VIEWS.ARCHITECTURE) switchView(VIEWS.ARCHITECTURE);
  actions.setScenarioActive(true);
}
