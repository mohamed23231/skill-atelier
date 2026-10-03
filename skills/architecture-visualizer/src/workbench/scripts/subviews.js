// Database ER Sub-view
function renderERView() {
  const target = document.getElementById('er-tables-container');
  if (!target) return;
  const er = ARCH_SPEC.views?.database_er;
  if (!er || !Array.isArray(er.tables) || er.tables.length === 0) {
    target.innerHTML = '<div style="color: var(--muted);">No database ER specifications defined.</div>';
    return;
  }

  target.innerHTML = er.tables.map(table => {
    const columns = (table.columns || []).map(col => {
      const pkTag = col.pk ? '<span class="key-chip pk" title="Primary key">PK</span>' : '';
      const fkTag = col.fk ? `<span class="key-chip fk" title="Foreign key to ${escapeHtml(col.fk)}">FK → ${escapeHtml(col.fk)}</span>` : '';
      return `<div class="er-col-row"><div>${pkTag}${fkTag}<strong class="voice-mono">${escapeHtml(col.name)}</strong></div><span class="voice-mono" style="color:var(--muted);">${escapeHtml(col.type)}</span></div>`;
    }).join('');
    return `
      <div class="er-table-card" data-table="${escapeHtml(table.name)}">
        <div class="er-table-header">
          <span class="detail-row">${iconMarkup('ui-table')}<span class="voice-mono">${escapeHtml(table.name)}</span></span>
          <span style="font-size:10px; color:var(--muted);">${escapeHtml(table.delta || 'EXISTING')}</span>
        </div>
        ${columns}
      </div>`;
  }).join('');
}

// Implementation Plan Sub-view
function renderImplementationPlanView() {
  const target = document.getElementById('plan-container');
  if (!target) return;
  const plan = ARCH_SPEC.views?.implementation_plan;
  if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    target.innerHTML = '<div style="color: var(--muted);">No implementation phases defined.</div>';
    return;
  }

  target.innerHTML = plan.phases.map((phase, idx) => {
    const tasks = (phase.tasks || []).map(t => `
      <div style="margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
          <div><strong>${escapeHtml(t.title)}</strong> <span style="font-size:11px; color:var(--muted);">(${escapeHtml(t.complexity || 'medium')} complexity)</span></div>
          <span class="badge-status" style="font-size:10px;">${escapeHtml(t.componentId || 'Core')}</span>
        </div>
        ${t.files?.length ? `<div style="font-size:11px; color:var(--muted); margin-top:4px;">Files: <span class="voice-mono" style="color:var(--ink);">${escapeHtml(t.files.join(', '))}</span></div>` : ''}
        ${t.risks?.length ? `<div class="detail-row" style="font-size:11px; color:var(--risk); margin-top:2px;">${iconMarkup('ui-alert')}<span>Risks: ${escapeHtml(t.risks.join(', '))}</span></div>` : ''}
      </div>`).join('');
    return `
      <div class="phase-card">
        <div class="phase-header">
          <div><span style="color:var(--accent); font-weight:700; margin-right:8px;">Phase ${idx + 1}:</span><strong>${escapeHtml(phase.name)}</strong></div>
        </div>
        ${tasks}
      </div>`;
  }).join('');
}

function renderQualityGate() {
  const target = document.getElementById('gate-body');
  if (!target) return;
  const gateLine = document.getElementById('gate-line');
  if (gateLine && typeof trustSummary === 'function') {
    const summary = trustSummary(ARCH_SPEC, QUALITY_GATE);
    gateLine.textContent = summary.gate.label;
  }
  if (!Array.isArray(QUALITY_GATE) || QUALITY_GATE.length === 0) {
    target.innerHTML = '<div style="color: var(--muted);">No quality gate data embedded.</div>';
    return;
  }
  const warnCount = QUALITY_GATE.filter(g => g.status === 'WARN').length;
  setIconLabel(document.getElementById('btn-gate'), warnCount === 0 ? 'ui-check-circle' : 'ui-alert', warnCount === 0 ? 'Gate' : `Gate (${warnCount})`);
  document.getElementById('btn-gate').dataset.gateState = warnCount === 0 ? 'pass' : 'warn';
  target.innerHTML = QUALITY_GATE.map(g => {
    const status = g.status === 'PASS' ? ['ui-check-circle', 'pass', 'Pass'] : (g.status === 'WARN' ? ['ui-alert', 'warn', 'Warning'] : ['ui-skip', 'skip', 'Skipped']);
    return `<div class="gate-row" data-gate-status="${status[1]}"><span class="gate-icon" title="${status[2]}">${iconMarkup(status[0])}<span class="workbench-sr-only">${status[2]}</span></span><div><strong>${g.id}. ${escapeHtml(g.name)}</strong><div style="color:var(--muted); font-size:11px;">${escapeHtml(g.detail)}</div></div></div>`;
  }).join('');
}
