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
  inspector.setAttribute('data-inspector-kind', kind);
  document.getElementById('ins-title').textContent = item.name || item.label || item.message || item.id || kind;
  document.getElementById('ins-tech').textContent = kind;
  const stateValue = item.verification || item.severity || item.status || 'unknown';
  appendReviewField(panel, 'State', stateValue);
  Object.entries(item).forEach(([key, value]) => {
    if (['name', 'label', 'message', 'id', 'verification', 'severity', 'status'].includes(key)) return;
    appendReviewField(panel, key, value);
  });
  setDrawerOpen('inspector', true, document.querySelector('[data-action="inspector-toggle"]'));
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
  const evidenceTarget = document.querySelector('[data-navigator-section="evidence"]');
  const findingTarget = document.querySelector('[data-navigator-section="findings"]');
  evidenceTarget.replaceChildren();
  findingTarget.replaceChildren();
  evidenceTarget.className = 'workbench-review-list';
  findingTarget.className = 'workbench-review-list';
  const evidence = ARCH_SPEC.review?.evidenceManifest || ARCH_SPEC.evidence || [];
  const findings = ARCH_SPEC.findings || ARCH_SPEC.review?.policyFindings || [];
  if (!evidence.length) evidenceTarget.textContent = 'No evidence records in this model.';
  evidence.forEach(item => evidenceTarget.appendChild(makeReviewButton('evidence', item, item.id || item.type || 'Evidence', item.verification)));
  if (!findings.length) findingTarget.textContent = 'No policy or evidence findings.';
  findings.forEach(item => findingTarget.appendChild(makeReviewButton('finding', item, item.id || item.message || 'Finding', item.severity)));
}
