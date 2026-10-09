// Node Selection & Inspector Drawer
const KIND_NAMES = { actor: 'Actor', frontend: 'Frontend', mobile: 'Mobile app', api_gateway: 'API gateway', service: 'Service',
  worker: 'Worker', database: 'Database', storage: 'Storage', cache: 'Cache', queue: 'Queue', topic: 'Topic',
  external: 'External system', cloud_function: 'Function', component: 'Component' };
const DELTA_NAMES = { ADDED: 'Added', MODIFIED: 'Changed', CHANGED: 'Changed', REMOVED: 'Removed', MOVED: 'Moved', UNCHANGED: 'Unchanged' };

function selectNode(nodeId) {
  actions.selectNode(nodeId);
  document.querySelectorAll('.node-group').forEach(el2 => el2.classList.remove('selected'));

  const nodeEl = document.getElementById(`node-${nodeId}`);
  if (nodeEl) nodeEl.classList.add('selected');

  const node = nodeById.get(nodeId);
  if (!node) return;
  const specNode = (ARCH_SPEC.nodes || []).find(item => item.id === nodeId) || node;

  document.getElementById('ins-title').textContent = node.label;
  document.getElementById('ins-kind-icon')?.querySelector('use')?.setAttribute('href', `#${getNodeIcon(node.type)}`);
  document.getElementById('ins-tech').textContent = [KIND_NAMES[node.type] || node.type, node.technology].filter(Boolean).join(' · ');
  document.getElementById('ins-description').textContent =
    node.description || specNode.description || 'No description provided.';

  // Chips: the trust model's evidence state, then the change when there is one.
  const evidence = nodeEvidence(ARCH_SPEC, nodeId);
  const statusBadge = document.getElementById('ins-status-badge');
  statusBadge.textContent = evidence.label;
  statusBadge.dataset.state = evidence.state;
  const delta = node.delta || DELTA.UNCHANGED;
  const deltaBadge = document.getElementById('ins-delta-badge');
  deltaBadge.textContent = DELTA_NAMES[delta] || delta;
  deltaBadge.dataset.delta = delta;
  deltaBadge.hidden = delta === DELTA.UNCHANGED;

  renderSheetWalkthrough(nodeId);

  const responsibilities = node.details?.responsibilities || specNode.details?.responsibilities || [];
  const respList = document.getElementById('ins-responsibilities');
  respList.replaceChildren(...responsibilities.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  sheetSection('responsibilities', responsibilities.length > 0);

  renderSheetConnections(nodeId);

  renderDetailList('ins-files', [...(node.details?.files || []).map(f => ({ path: typeof f === 'string' ? f : f.path })),
    ...evidence.locators.filter(record => record.type !== 'file').map(record => ({ record }))], item => item.path
    ? `<div class="sheet-row">${iconMarkup('ui-file')}<span class="voice-mono">${escapeHtml(item.path)}</span></div>`
    : `<div class="sheet-row"><span class="sheet-row-key">${escapeHtml(item.record.type)}</span><span class="voice-mono">${escapeHtml(typeof item.record.locator === 'string' ? item.record.locator : JSON.stringify(item.record.locator))}</span></div>`,
  null, 'files');

  renderDetailList('ins-apis', node.details?.apis, api => `
    <div class="sheet-row"><span class="sheet-row-key">${escapeHtml(api.method || 'GET')}</span><span class="voice-mono">${escapeHtml(api.path || '')}</span>
      ${api.desc ? `<span class="sheet-row-note">${escapeHtml(api.desc)}</span>` : ''}</div>`, null, 'apis');

  renderDetailList('ins-tables', node.details?.tables, t => {
    const name = typeof t === 'string' ? t : t.name;
    return `<div class="sheet-row">${iconMarkup('ui-table')}<span class="voice-mono">${escapeHtml(name)}</span></div>`;
  }, null, 'tables');

  renderDetailList('ins-tasks', node.details?.tasks, t => `
    <label class="task-item">
      <input type="checkbox" ${t.status === 'done' ? 'checked' : ''} />
      <span>${escapeHtml(t.title)}</span>
    </label>`, null, 'tasks');

  renderDetailList('ins-risks', node.details?.failureModes, entry => {
    const r = normalizeFailureMode(entry);
    return `
    <div class="sheet-callout">
      <strong>${iconMarkup('ui-alert')}<span>${escapeHtml(r.failure)}</span></strong>
      ${r.impact || r.mitigation ? `<p>${escapeHtml([r.impact, r.mitigation ? `Mitigation: ${r.mitigation}` : ''].filter(Boolean).join('. '))}</p>` : ''}
    </div>`;
  }, null, 'risks');

  const highlightBtn = document.getElementById('ins-btn-highlight');
  setIconLabel(highlightBtn, state.highlightedChain === nodeId ? 'ui-close' : 'ui-link', state.highlightedChain === nodeId ? 'Clear Dependency Chain' : 'Highlight Dependency Chain');
}

function sheetSection(name, visible) {
  const section = document.querySelector(`[data-sheet-section="${name}"]`);
  if (section) section.hidden = !visible;
}

// Every step of the scenario, on any outcome, in which this component takes part; a row opens that step.
function renderSheetWalkthrough(nodeId) {
  const list = document.getElementById('ins-walk');
  const scenario = (ARCH_SPEC.scenarios || [])[0];
  const rows = [];
  if (scenario) {
    const paths = walkScenarioPaths(scenario);
    const seen = new Set();
    let number = 0;
    paths.forEach(({ choices, entries }) => entries.forEach(entry => {
      if (entry.kind !== 'step' || seen.has(entry.id)) return;
      seen.add(entry.id);
      number = Math.max(number, entry.number);
      if (!(entry.interactions || []).some(hop => hop.from === nodeId || hop.to === nodeId)) return;
      const decision = entries.slice(0, entries.indexOf(entry)).findLast(item => item.kind === 'decision');
      const branch = decision?.branches[decision.chosen];
      const afterDecision = Boolean(decision);
      rows.push({ entry, choices, note: afterDecision && branch?.status === 'recovery' ? 'Recovery path' : afterDecision ? `If ${branch?.name || 'outcome'}` : '' });
    }));
  }
  rows.sort((a, b) => a.entry.number - b.entry.number);
  list.replaceChildren(...rows.map(({ entry, choices, note }) => sheetListItem(String(entry.number), entry.stage?.name || entry.id, note, () => {
    startWalkthrough(scenario.id, choices);
    walkTo(entry.id);
    openChapter('walkthrough');
  })));
  document.getElementById('ins-walk-count').textContent = rows.length ? `${rows.length} step${rows.length === 1 ? '' : 's'}` : '';
  sheetSection('walkthrough', rows.length > 0);
}

// Outgoing then incoming connections; a row opens the component at the other end.
function renderSheetConnections(nodeId) {
  const edges = LAYOUT_DATA.edges || [];
  const outs = edges.filter(edge => edge.source === nodeId);
  const ins = edges.filter(edge => edge.target === nodeId);
  const row = (edge, other, arrow) => sheetListItem(arrow, nodeById.get(other)?.label || other,
    [edge.label || edge.packetLabel, edge.communication].filter(Boolean).join(' · '), () => openInspectorForNode(other), { mono: true });
  document.getElementById('ins-connections').replaceChildren(...outs.map(edge => row(edge, edge.target, '→')), ...ins.map(edge => row(edge, edge.source, '←')));
  document.getElementById('ins-connection-count').textContent = `${ins.length} in · ${outs.length} out`;
  sheetSection('connections', ins.length + outs.length > 0);
}

function sheetListItem(marker, title, note, onClick, options = {}) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sheet-list-row';
  const mark = document.createElement('span');
  mark.className = 'sheet-list-marker';
  mark.textContent = marker;
  const text = document.createElement('span');
  text.className = 'sheet-list-text';
  const name = document.createElement('span');
  name.className = 'sheet-list-title';
  name.textContent = title;
  text.appendChild(name);
  if (note) {
    const detail = document.createElement('span');
    detail.className = options.mono ? 'sheet-list-note mono' : 'sheet-list-note';
    detail.textContent = note;
    text.appendChild(detail);
  }
  button.append(mark, text);
  button.addEventListener('click', onClick);
  li.appendChild(button);
  return li;
}

// Fills a sheet list; an empty list hides its section, or shows the message when one is given.
function renderDetailList(containerId, items, renderItem, emptyMessage, section) {
  const target = document.getElementById(containerId);
  const has = Array.isArray(items) && items.length > 0;
  if (has) target.innerHTML = items.map(renderItem).join('');
  else target.innerHTML = emptyMessage ? `<span class="sheet-empty">${escapeHtml(emptyMessage)}</span>` : '';
  if (section) sheetSection(section, has);
}

function closeInspector() {
  hideSheetKeepSelection();
  document.querySelectorAll('[data-selected="true"]').forEach(item => item.removeAttribute('data-selected'));
  actions.clearSelection();
  state.highlightedChain = null;
  document.querySelectorAll('.node-group').forEach(el2 => el2.classList.remove('selected'));
  applyVisibility();
}
