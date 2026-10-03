// Node Selection & Inspector Drawer
function selectNode(nodeId) {
  actions.selectNode(nodeId);
  document.querySelectorAll('.node-group').forEach(el2 => el2.classList.remove('selected'));

  const nodeEl = document.getElementById(`node-${nodeId}`);
  if (nodeEl) nodeEl.classList.add('selected');

  const node = nodeById.get(nodeId);
  if (!node) return;

  document.getElementById('ins-title').textContent = node.label;
  document.getElementById('ins-tech').textContent = `${node.type} • ${node.technology || 'N/A'}`;

  const statusBadge = document.getElementById('ins-status-badge');
  statusBadge.textContent = node.status || 'VERIFIED';
  statusBadge.className = `badge-status ${node.status || 'VERIFIED'}`;

  const deltaBadge = document.getElementById('ins-delta-badge');
  deltaBadge.textContent = node.delta || DELTA.UNCHANGED;
  deltaBadge.className = `badge-status ${node.delta || DELTA.UNCHANGED}`;

  document.getElementById('ins-description').textContent =
    node.description || node.details?.responsibilities?.join(' ') || 'No detailed description provided.';

  renderDetailList('ins-files', node.details?.files, f => {
    const path = typeof f === 'string' ? f : f.path;
    return `<div class="file-link">${iconMarkup('ui-file')}<span class="voice-mono">${escapeHtml(path)}</span></div>`;
  }, 'No source files mapped');

  renderDetailList('ins-apis', node.details?.apis, api => `
    <div style="margin-bottom:6px;">
      <span style="color: var(--accent); font-weight:700;">${escapeHtml(api.method || 'GET')}</span>
      <code>${escapeHtml(api.path || '')}</code>
      <div style="font-size:11px; color: var(--muted);">${escapeHtml(api.desc || '')}</div>
    </div>`, 'None specified');

  renderDetailList('ins-tables', node.details?.tables, t => {
    const name = typeof t === 'string' ? t : t.name;
    return `<div class="detail-row">${iconMarkup('ui-table')}<span class="voice-mono">${escapeHtml(name)}</span></div>`;
  }, 'No direct tables');

  renderDetailList('ins-tasks', node.details?.tasks, t => `
    <label class="task-item">
      <input type="checkbox" ${t.status === 'done' ? 'checked' : ''} />
      <span>${escapeHtml(t.title)}</span>
    </label>`, 'No implementation tasks');

  renderDetailList('ins-risks', node.details?.failureModes, entry => {
    const r = normalizeFailureMode(entry);
    return `
    <div style="margin-bottom:8px;">
      <strong class="detail-row">${iconMarkup('ui-alert')}<span>${escapeHtml(r.failure)}</span></strong>
      ${r.impact ? `<div style="color:var(--muted); font-size:11px;">Impact: ${escapeHtml(r.impact)}</div>` : ''}
      ${r.mitigation ? `<div style="color:var(--ok); font-size:11px;">Mitigation: ${escapeHtml(r.mitigation)}</div>` : ''}
    </div>`;
  }, 'No critical risks registered');

  const highlightBtn = document.getElementById('ins-btn-highlight');
  setIconLabel(highlightBtn, state.highlightedChain === nodeId ? 'ui-close' : 'ui-link', state.highlightedChain === nodeId ? 'Clear Dependency Chain' : 'Highlight Dependency Chain');
}

function renderDetailList(containerId, items, renderItem, emptyMessage) {
  const target = document.getElementById(containerId);
  if (Array.isArray(items) && items.length > 0) {
    target.innerHTML = items.map(renderItem).join('');
  } else {
    target.innerHTML = `<span style="color: var(--muted);">${escapeHtml(emptyMessage)}</span>`;
  }
}

function closeInspector() {
  hideSheetKeepSelection();
  document.querySelectorAll('[data-selected="true"]').forEach(item => item.removeAttribute('data-selected'));
  actions.clearSelection();
  state.highlightedChain = null;
  document.querySelectorAll('.node-group').forEach(el2 => el2.classList.remove('selected'));
  applyVisibility();
  if (isOverlayPanels()) {
    setDrawerOpen('rail', false);
  }
}
