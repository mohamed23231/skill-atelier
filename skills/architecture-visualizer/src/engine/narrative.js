/**
 * Turns normalized scenario stages and interactions into readable sentences.
 * An authored narrative always wins; everything else is generated from the
 * `from`/`to`/`label`/`payload` shape produced by validator.normalizeScenarios.
 */

function authoredNarrative(item) {
  if (!item || typeof item !== 'object') return '';
  if (typeof item.narrative !== 'string') return '';
  return item.narrative.trim() === '' ? '' : item.narrative;
}

function labelOf(id, nodeLabel) {
  if (id == null) return '';
  if (typeof nodeLabel !== 'function') return String(id);
  const resolved = nodeLabel(id);
  if (resolved == null || resolved === '') return String(id);
  return String(resolved);
}

function displayValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return '{…}';
  return String(value);
}

function narrateInteraction(interaction, nodeLabel) {
  const authored = authoredNarrative(interaction);
  if (authored) return authored;
  if (!interaction || typeof interaction !== 'object') return '';

  const from = labelOf(interaction.from, nodeLabel);
  const to = labelOf(interaction.to, nodeLabel);
  const label = interaction.label;
  let sentence = !from || !to
    ? (label == null || label === '' ? 'An interaction occurs.' : `Interaction: ${label}.`)
    : label == null || label === ''
      ? `${from} calls ${to}.`
      : `${from} sends ${label} to ${to}.`;
  const payload = interaction.payload;
  if (payload && typeof payload === 'object') {
    const keys = Object.keys(payload).slice(0, 4);
    if (keys.length > 0) {
      const entries = keys.map((key) => `${key}=${displayValue(payload[key])}`).join(', ');
      sentence += ` Payload: ${entries}.`;
    }
  } else if (payload != null && String(payload).trim() !== '') {
    sentence += ` Payload: ${displayValue(payload)}.`;
  }
  return sentence;
}

function stripTrailingPeriod(sentence) {
  return sentence.endsWith('.') ? sentence.slice(0, -1) : sentence;
}

function narrateStage(stage, nodeLabel) {
  const authored = authoredNarrative(stage);
  if (authored) return authored;
  if (!stage || typeof stage !== 'object') return '';

  const kind = stage.kind || 'interaction';

  if (kind === 'parallel') {
    const hops = (stage.interactions || [])
      .map((interaction) => stripTrailingPeriod(narrateInteraction(interaction, nodeLabel)))
      .filter((sentence) => sentence !== '');
    return `In parallel: ${hops.join('; ')}.`;
  }

  if (kind === 'branch') {
    const condition = stage.condition ? String(stage.condition) : (stage.branches || [])
      .map((branch) => branch && branch.condition)
      .filter(Boolean)
      .join(' or ') || 'unspecified condition';
    const outcomes = (stage.branches || []).map((branch) => {
      const name = branch && branch.name ? String(branch.name) : 'Outcome';
      return branch && branch.condition ? `${name} (${branch.condition})` : name;
    });
    if (outcomes.length === 0) return `Decision: ${condition}.`;
    return `Decision: ${condition}. Outcomes: ${outcomes.join(', ')}.`;
  }

  if (stage.interactions && stage.interactions.length) {
    return stage.interactions.map((interaction) => narrateInteraction(interaction, nodeLabel))
      .filter((sentence) => sentence !== '').join(' ');
  }
  return narrateInteraction(stage, nodeLabel);
}

function narrateStageEntry(stage, nodeLabel) {
  const entry = {
    id: stage && stage.id,
    name: stage && (stage.name || stage.id),
    narrative: narrateStage(stage, nodeLabel),
  };
  if (stage && stage.kind === 'branch') {
    entry.outcomes = (stage.branches || []).map((branch) => ({
      name: branch && branch.name,
      condition: branch && branch.condition,
      recovery: branch && branch.recovery,
      stages: ((branch && branch.stages) || []).map((child) => narrateStageEntry(child, nodeLabel)),
    }));
  }
  return entry;
}

function narrateScenario(scenario, nodeLabel) {
  if (!scenario || typeof scenario !== 'object') return [];
  return (scenario.stages || []).map((stage) => narrateStageEntry(stage, nodeLabel));
}

module.exports = {
  narrateInteraction,
  narrateStage,
  narrateScenario,
};
