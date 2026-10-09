function reviewValue(value) {
  if (value == null || value === '') return 'Not provided';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(reviewValue).join(', ');
  return Object.entries(value).map(([key, entry]) => `${key}: ${reviewValue(entry)}`).join(' · ');
}

function appendReviewField(parent, label, value) {
  const field = document.createElement('div');
  field.className = 'workbench-review-field';
  const heading = document.createElement('strong');
  heading.textContent = label;
  const body = document.createElement('div');
  body.textContent = reviewValue(value);
  field.append(heading, body);
  parent.appendChild(field);
}

function showNodeInspector() {
  document.getElementById('node-inspector-body').classList.remove('workbench-hidden');
  document.getElementById('review-inspector-body').classList.add('workbench-hidden');
}

function openReviewInspector(kind, item) {
  const panel = document.getElementById('review-inspector-body');
  document.getElementById('node-inspector-body').classList.add('workbench-hidden');
  panel.classList.remove('workbench-hidden');
  panel.replaceChildren();
  showSheet('review');
  document.getElementById('ins-title').textContent = item.name || item.label || item.message || item.id || kind;
  document.getElementById('ins-tech').textContent = kind;
  const stateValue = item.verification || item.severity || item.status || 'unknown';
  appendReviewField(panel, 'State', stateValue);
  Object.entries(item).forEach(([key, value]) => {
    if (['name', 'label', 'message', 'id', 'verification', 'severity', 'status'].includes(key)) return;
    appendReviewField(panel, key, value);
  });
  panel.focus();
  announceStatus(`${kind} ${item.id || item.name || ''} opened. ${stateValue}.`);
  updateUrlState();
}

function makeReviewButton(kind, item, label, stateValue) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'workbench-review-item';
  button.setAttribute('data-review-kind', kind);
  button.setAttribute('data-review-id', item.id || label);
  button.setAttribute('data-state', String(stateValue || 'unknown').toLowerCase());
  button.textContent = `${label} · ${stateValue || 'unknown'}`;
  button.addEventListener('click', () => openReviewInspector(kind, item));
  return button;
}

function renderReviewNavigator() {
  const findingTarget = document.querySelector('[data-navigator-section="findings"]');
  if (!findingTarget) return;
  findingTarget.replaceChildren();
  findingTarget.className = 'workbench-review-list';
  const findings = ARCH_SPEC.findings || ARCH_SPEC.review?.policyFindings || [];
  if (!findings.length) {
    findingTarget.textContent = 'No policy or evidence findings.';
    return;
  }
  findings.forEach(item => findingTarget.appendChild(makeReviewButton('finding', item, item.id || item.message || 'Finding', item.severity)));
}

// The Evidence chapter pairs each component with its trust state and up to four locators.
function renderEvidenceChapter() {
  const target = document.getElementById('evidence-list');
  if (!target) return;
  const grounding = trustSummary(ARCH_SPEC, QUALITY_GATE).grounding;
  chapterIntro(target.closest('.rail-panel'), 'EVIDENCE', 'What each component is backed by',
    ARCH_SPEC.meta?.grounding === 'illustrative' ? 'This example is illustrative. Locators are declared in the spec and were not verified against a repository.' : grounding.detail);
  target.replaceChildren();
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const evidence = nodeEvidence(ARCH_SPEC, node.id);
    const row = chapterRow('', node.label || node.id, '', '', 'neutral', () => openInspectorForNode(node.id));
    row.classList.add('evidence-row');
    row.dataset.evidenceNode = node.id;
    row.querySelector('.sheet-list-marker').innerHTML = iconMarkup(getNodeIcon(node.type));
    const name = row.querySelector('.sheet-list-title');
    name.dataset.evidenceNodeLabel = node.id;
    const chip = row.querySelector('.chapter-aside');
    chip.classList.add('evidence-chip');
    chip.dataset.evidenceState = evidence.state;
    chip.textContent = evidence.label;
    const locators = row.querySelector('.sheet-list-note');
    locators.classList.add('evidence-locators');
    evidence.locators.slice(0, 4).forEach(record => {
      const line = document.createElement('span');
      line.className = 'evidence-locator';
      line.textContent = `${record.type}  ${trustLocatorKey(record.locator)}`;
      locators.appendChild(line);
    });
    if (!evidence.locators.length) locators.textContent = 'No evidence records';
    target.appendChild(row);
  });
}
