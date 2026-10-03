// Database ER Sub-view
function renderERView() {
  const target = document.getElementById('er-tables-container');
  const er = ARCH_SPEC.views?.database_er;
  if (!er || !Array.isArray(er.tables) || er.tables.length === 0) {
    target.innerHTML = '<div style="color: var(--text-dim);">No database ER specifications defined.</div>';
    return;
  }

  target.innerHTML = er.tables.map(table => {
    const columns = (table.columns || []).map(col => {
      const pkTag = col.pk ? '<span style="color:var(--accent-amber); font-weight:700; margin-right:4px;">[PK]</span>' : '';
      const fkTag = col.fk ? `<span style="color:var(--accent-blue); font-weight:700; margin-right:4px;">[FK→${escapeHtml(col.fk)}]</span>` : '';
      return `<div class="er-col-row"><div>${pkTag}${fkTag}<strong>${escapeHtml(col.name)}</strong></div><span style="color:var(--text-muted);">${escapeHtml(col.type)}</span></div>`;
    }).join('');
    return `
      <div class="er-table-card">
        <div class="er-table-header">
          <span>🗄️ ${escapeHtml(table.name)}</span>
          <span style="font-size:10px; color:var(--text-dim);">${escapeHtml(table.delta || 'EXISTING')}</span>
        </div>
        ${columns}
      </div>`;
  }).join('');
}

// Implementation Plan Sub-view
function renderImplementationPlanView() {
  const target = document.getElementById('plan-container');
  const plan = ARCH_SPEC.views?.implementation_plan;
  if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    target.innerHTML = '<div style="color: var(--text-dim);">No implementation phases defined.</div>';
    return;
  }

  target.innerHTML = plan.phases.map((phase, idx) => {
    const tasks = (phase.tasks || []).map(t => `
      <div style="margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px;">
          <div><strong>${escapeHtml(t.title)}</strong> <span style="font-size:11px; color:var(--text-dim);">(${escapeHtml(t.complexity || 'medium')} complexity)</span></div>
          <span class="badge-status" style="font-size:10px;">${escapeHtml(t.componentId || 'Core')}</span>
        </div>
        ${t.files?.length ? `<div style="font-size:11px; color:var(--accent-blue); margin-top:4px;">Files: ${escapeHtml(t.files.join(', '))}</div>` : ''}
        ${t.risks?.length ? `<div style="font-size:11px; color:var(--accent-rose); margin-top:2px;">⚠️ Risks: ${escapeHtml(t.risks.join(', '))}</div>` : ''}
      </div>`).join('');
    return `
      <div class="phase-card">
        <div class="phase-header">
          <div><span style="color:var(--accent-blue); font-weight:700; margin-right:8px;">Phase ${idx + 1}:</span><strong>${escapeHtml(phase.name)}</strong></div>
        </div>
        ${tasks}
      </div>`;
  }).join('');
}

function renderQualityGate() {
  const target = document.getElementById('gate-body');
  if (!Array.isArray(QUALITY_GATE) || QUALITY_GATE.length === 0) {
    target.innerHTML = '<div style="color: var(--text-dim);">No quality gate data embedded.</div>';
    return;
  }
  const warnCount = QUALITY_GATE.filter(g => g.status === 'WARN').length;
  document.getElementById('btn-gate').textContent = warnCount === 0 ? '✅ Gate' : `⚠️ Gate (${warnCount})`;
  target.innerHTML = QUALITY_GATE.map(g => {
    const icon = g.status === 'PASS' ? '✅' : (g.status === 'WARN' ? '⚠️' : '➖');
    return `<div class="gate-row"><span>${icon}</span><div><strong>${g.id}. ${escapeHtml(g.name)}</strong><div style="color:var(--text-muted); font-size:11px;">${escapeHtml(g.detail)}</div></div></div>`;
  }).join('');
}
