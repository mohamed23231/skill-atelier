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

// The Evidence chapter: one row per component in canvas order, each listing every locator behind it.
function renderEvidenceChapter() {
  const target = document.getElementById('evidence-list');
  if (!target) return;
  target.replaceChildren();
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const evidence = nodeEvidence(ARCH_SPEC, node.id);
    const row = document.createElement('div');
    row.className = 'evidence-row';
    row.setAttribute('data-evidence-node', node.id);

    const head = document.createElement('div');
    head.className = 'evidence-head';
    const icon = document.createElement('span');
    icon.className = 'evidence-icon';
    icon.innerHTML = iconMarkup(getNodeIcon(node.type));
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'evidence-name';
    name.setAttribute('data-evidence-node-label', node.id);
    name.textContent = node.label || node.id;
    name.addEventListener('click', () => openInspectorForNode(node.id));
    const chip = document.createElement('span');
    chip.className = 'evidence-chip';
    chip.setAttribute('data-evidence-state', evidence.state);
    chip.textContent = evidence.label;
    head.append(icon, name, chip);

    const locators = document.createElement('div');
    locators.className = 'evidence-locators';
    if (evidence.locators.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'evidence-empty';
      empty.textContent = 'No evidence records';
      locators.appendChild(empty);
    } else {
      evidence.locators.forEach(record => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'evidence-locator';
        button.textContent = trustLocatorKey(record.locator);
        button.addEventListener('click', () => openReviewInspector('evidence', record));
        locators.appendChild(button);
      });
    }

    row.append(head, locators);
    target.appendChild(row);
  });
}
