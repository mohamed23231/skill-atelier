function availableChapters() {
  const chapters = [
    { id: 'overview', label: 'Overview' },
    { id: 'walkthrough', label: 'Walkthrough' },
    { id: 'changes', label: 'Changes' },
    { id: 'review', label: 'Review' },
    { id: 'evidence', label: 'Evidence' }
  ];
  if (ARCH_SPEC.views?.database_er?.tables?.length > 0) {
    chapters.push({ id: 'data', label: 'Data' });
  }
  if (ARCH_SPEC.views?.implementation_plan?.phases?.length > 0) {
    chapters.push({ id: 'plan', label: 'Plan' });
  }
  return chapters;
}

function initRail() {
  const railChapters = document.querySelector('.rail-chapters');
  if (!railChapters) return;

  const chapters = availableChapters();
  const availableIds = new Set(chapters.map(c => c.id));

  // Remove panels for absent chapters
  document.querySelectorAll('.rail-panel').forEach(panel => {
    const id = panel.getAttribute('data-chapter-panel');
    if (id && !availableIds.has(id)) {
      panel.remove();
    }
  });

  renderRailTabs();

  // Ensure current chapter is set and panel is visible
  const initialChapter = availableIds.has(state.chapter) ? state.chapter : 'overview';
  openChapter(initialChapter);
}

function renderRailTabs() {
  const railChapters = document.querySelector('.rail-chapters');
  if (!railChapters) return;

  railChapters.replaceChildren();
  const chapters = availableChapters();

  chapters.forEach(ch => {
    const tab = document.createElement('button');
    tab.className = 'rail-tab';
    tab.setAttribute('role', 'tab');
    tab.id = `chapter-tab-${ch.id}`;
    tab.setAttribute('aria-controls', `chapter-${ch.id}`);
    const isSelected = state.chapter === ch.id;
    tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    tab.setAttribute('tabindex', isSelected ? '0' : '-1');
    if (isSelected) tab.classList.add('active');
    tab.textContent = ch.label;

    tab.addEventListener('click', () => {
      openChapter(ch.id);
    });

    tab.addEventListener('keydown', event => {
      handleChapterTabKeyDown(event, ch.id);
    });

    railChapters.appendChild(tab);
  });
}

function handleChapterTabKeyDown(event, currentId) {
  const chapters = availableChapters();
  const count = chapters.length;
  const currentIndex = chapters.findIndex(c => c.id === currentId);
  if (currentIndex === -1) return;

  let targetIndex = -1;
  switch (event.key) {
    case 'ArrowLeft':
      event.preventDefault();
      targetIndex = (currentIndex - 1 + count) % count;
      break;
    case 'ArrowRight':
      event.preventDefault();
      targetIndex = (currentIndex + 1) % count;
      break;
    case 'Home':
      event.preventDefault();
      targetIndex = 0;
      break;
    case 'End':
      event.preventDefault();
      targetIndex = count - 1;
      break;
    default:
      return;
  }

  if (targetIndex !== -1) {
    const targetChapter = chapters[targetIndex];
    openChapter(targetChapter.id);
    const targetTab = document.getElementById(`chapter-tab-${targetChapter.id}`);
    targetTab?.focus();
  }
}

function openChapter(id) {
  const chapters = availableChapters();
  const found = chapters.find(c => c.id === id);
  const targetId = found ? id : (chapters[0]?.id || 'overview');
  const targetChapter = found || chapters[0] || { id: targetId, label: targetId };

  const chapterChanged = state.chapter !== targetId;
  actions.setChapter(targetId);
  if (chapterChanged) {
    if (state.lensExplicit) actions.setLens(state.lens, false);
    else selectLens(suggestedLens(targetId), { explicit: false });
  }

  // Update chapter tabs
  chapters.forEach(ch => {
    const tab = document.getElementById(`chapter-tab-${ch.id}`);
    if (tab) {
      const isSelected = ch.id === targetId;
      tab.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tab.setAttribute('tabindex', isSelected ? '0' : '-1');
      tab.classList.toggle('active', isSelected);
    }
  });

  // Update chapter panels
  document.querySelectorAll('.rail-panel').forEach(panel => {
    const panelId = panel.getAttribute('data-chapter-panel');
    if (panelId === targetId) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
    }
  });

  // Closes the sheet, keeping the selection
  hideSheetKeepSelection();

  // Update back button text in sheet
  const backBtn = document.querySelector('[data-action="sheet-back"]');
  if (backBtn) {
    backBtn.textContent = `Back to ${targetChapter.label}`;
  }

  updateUrlState();
}

function hideSheetKeepSelection() {
  const sheet = document.getElementById('component-sheet');
  if (sheet) sheet.setAttribute('hidden', '');
  const rail = document.getElementById('rail');
  if (rail) rail.setAttribute('data-sheet', 'none');
}

function showSheet(kind) {
  const sheet = document.getElementById('component-sheet');
  if (sheet) sheet.removeAttribute('hidden');
  const rail = document.getElementById('rail');
  if (rail) rail.setAttribute('data-sheet', kind);
  const railToggle = document.querySelector('[data-action="rail-toggle"]');
  setDrawerOpen('rail', true, railToggle);
}

function chapterLabel(id) {
  const chapter = availableChapters().find(item => item.id === id);
  return chapter ? chapter.label : id;
}

function renderOverviewChapter() {
  if (!document.getElementById('chapter-overview')) return;
  const meta = ARCH_SPEC.meta || {};

  const title = document.getElementById('overview-title');
  if (title) title.textContent = meta.title || 'Overview';

  const description = document.getElementById('overview-description');
  if (description) description.textContent = meta.description || '';

  const metaLine = document.getElementById('overview-meta');
  if (metaLine) {
    metaLine.textContent = [meta.status, meta.author, meta.date].filter(part => part != null && part !== '').join(' · ');
  }

  const facts = document.getElementById('overview-facts');
  if (facts) {
    facts.replaceChildren();
    [
      ['Components', (ARCH_SPEC.nodes || []).length],
      ['Connections', (ARCH_SPEC.edges || []).length],
      ['Boundaries', (ARCH_SPEC.boundaries || []).length],
      ['Scenarios', (ARCH_SPEC.scenarios || []).length],
    ].forEach(([label, count]) => {
      const item = document.createElement('div');
      item.className = 'overview-fact';
      const term = document.createElement('dt');
      term.textContent = label;
      const value = document.createElement('dd');
      value.textContent = String(count);
      item.append(term, value);
      facts.appendChild(item);
    });
  }

  const trust = document.getElementById('overview-trust');
  if (trust && typeof trustSummary === 'function') {
    trust.replaceChildren();
    Object.entries(trustSummary(ARCH_SPEC, QUALITY_GATE)).forEach(([key, entry]) => {
      const row = document.createElement('div');
      row.className = 'ov-trust-row';
      row.setAttribute('data-trust-key', key);

      const dot = document.createElement('span');
      dot.className = 'trust-dot';
      dot.setAttribute('data-state', entry.state);

      const label = document.createElement('span');
      label.className = 'ov-trust-label';
      label.textContent = entry.label;

      const detail = document.createElement('span');
      detail.className = 'ov-trust-detail';
      detail.textContent = entry.detail;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'btn-icon ov-trust-open';
      open.setAttribute('data-trust-chapter', entry.chapter);
      open.textContent = `Open ${chapterLabel(entry.chapter)}`;
      open.addEventListener('click', () => openChapter(entry.chapter));

      row.append(dot, label, detail, open);
      trust.appendChild(row);
    });
  }

  const stagesTarget = document.getElementById('overview-stages');
  if (stagesTarget) {
    stagesTarget.replaceChildren();
    const scenario = (ARCH_SPEC.scenarios || [])[0];
    if (!scenario || !scenario.stages || scenario.stages.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'rail-muted';
      empty.textContent = 'No scenarios recorded.';
      stagesTarget.appendChild(empty);
    } else {
      const flattened = flattenScenarioStages(scenario.stages);
      scenario.stages.forEach((stage, index) => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'overview-stage';
        button.setAttribute('data-overview-stage', stage.id || String(index));
        button.textContent = stage.name || stage.label || stage.id || `Stage ${index + 1}`;
        button.addEventListener('click', () => {
          selectScenario(scenario.id);
          const flatIndex = flattened.findIndex(itemStage => itemStage.id === stage.id);
          actions.setScenarioStage(flatIndex >= 0 ? flatIndex : index);
          renderScenarioStage();
          openChapter('walkthrough');
        });
        item.appendChild(button);
        stagesTarget.appendChild(item);
      });
    }
  }

  const changes = document.getElementById('overview-changes');
  if (changes) {
    changes.replaceChildren();
    const counts = { ADDED: 0, CHANGED: 0, REMOVED: 0, MOVED: 0 };
    (ARCH_SPEC.nodes || []).forEach(node => {
      if (counts[node.delta] !== undefined) counts[node.delta] += 1;
    });
    const summary = document.createElement('span');
    summary.className = 'rail-muted';
    summary.textContent = `Added ${counts.ADDED} · Changed ${counts.CHANGED} · Removed ${counts.REMOVED} · Moved ${counts.MOVED}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn-icon';
    open.setAttribute('data-overview-open-changes', '');
    open.textContent = 'Open Changes';
    open.addEventListener('click', () => openChapter('changes'));
    changes.append(summary, open);
  }
}

const CHANGE_DELTAS = [
  ['ADDED', 'Added'],
  ['CHANGED', 'Changed'],
  ['REMOVED', 'Removed'],
  ['MOVED', 'Moved'],
];

function renderChangesChapter() {
  const deltas = document.getElementById('changes-deltas');
  if (!deltas) return;

  const nodesById = new Map((ARCH_SPEC.nodes || []).map(node => [node.id, node]));
  const review = ARCH_SPEC.review || {};
  const changed = Array.isArray(review.changedComponents) && review.changedComponents.length
    ? review.changedComponents
    : (ARCH_SPEC.nodes || [])
      .filter(node => node.delta && node.delta !== 'UNCHANGED')
      .map(node => ({ id: node.id, label: node.label, delta: node.delta }));

  deltas.replaceChildren();
  CHANGE_DELTAS.forEach(([delta, label]) => {
    const components = changed.filter(entry => entry.delta === delta);
    if (components.length === 0) return;
    const group = document.createElement('section');
    group.className = 'change-group';
    group.setAttribute('data-change-delta', delta);
    const heading = document.createElement('h3');
    heading.textContent = label;
    group.appendChild(heading);
    components.forEach(entry => {
      const node = nodesById.get(entry.id) || entry;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'change-component';
      button.setAttribute('data-change-component', entry.id);
      const icon = document.createElement('span');
      icon.className = 'change-icon';
      icon.innerHTML = iconMarkup(getNodeIcon(node.type));
      const name = document.createElement('span');
      name.className = 'change-name';
      name.textContent = entry.label || node.label || entry.id;
      const tech = document.createElement('span');
      tech.className = 'change-tech';
      tech.textContent = node.technology || node.type || '';
      button.append(icon, name, tech);
      button.addEventListener('click', () => openInspectorForNode(entry.id));
      group.appendChild(button);
    });
    deltas.appendChild(group);
  });
  if (!deltas.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'rail-muted';
    empty.textContent = 'No changed components.';
    deltas.appendChild(empty);
  }

  const blastTarget = document.getElementById('changes-blast');
  if (blastTarget) {
    blastTarget.replaceChildren();
    const blast = Array.isArray(review.blastRadius) ? review.blastRadius : [];
    if (blast.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rail-muted';
      empty.textContent = 'No blast radius recorded.';
      blastTarget.appendChild(empty);
    } else {
      blast.forEach(entry => {
        const node = nodesById.get(entry.nodeId) || {};
        const upstream = entry.upstream || [];
        const downstream = entry.downstream || [];
        const details = document.createElement('details');
        details.className = 'blast-item';
        details.setAttribute('data-blast-node', entry.nodeId);
        details.setAttribute('data-blast-up', String(upstream.length));
        details.setAttribute('data-blast-down', String(downstream.length));
        const summary = document.createElement('summary');
        summary.textContent = `${node.label || entry.nodeId} — ${upstream.length} upstream · ${downstream.length} downstream`;
        const names = document.createElement('div');
        names.className = 'blast-names';
        const nameOf = id => nodesById.get(id)?.label || id;
        if (!upstream.length && !downstream.length) {
          names.textContent = 'No upstream or downstream components.';
        } else {
          if (upstream.length) names.append(`Upstream: ${upstream.map(nameOf).join(', ')}`);
          if (upstream.length && downstream.length) names.append(document.createElement('br'));
          if (downstream.length) names.append(`Downstream: ${downstream.map(nameOf).join(', ')}`);
        }
        details.append(summary, names);
        blastTarget.appendChild(details);
      });
    }
  }

  const traceTarget = document.getElementById('changes-traceability');
  if (traceTarget) {
    traceTarget.replaceChildren();
    const trace = review.traceability;
    if (!trace || typeof trace !== 'object') {
      const empty = document.createElement('div');
      empty.className = 'rail-muted';
      empty.textContent = 'No traceability recorded.';
      traceTarget.appendChild(empty);
    } else {
      const mapped = Array.isArray(trace.mapped) ? trace.mapped : [];
      const changedIds = Array.isArray(trace.changed) ? trace.changed : [];
      const gaps = Array.isArray(trace.gaps) ? trace.gaps : [];
      const line = document.createElement('div');
      line.className = 'trace-line';
      line.setAttribute('data-trace-summary', '');
      line.textContent = `${mapped.length} of ${changedIds.length} changed components mapped`;
      traceTarget.appendChild(line);
      if (gaps.length === 0) {
        const none = document.createElement('div');
        none.className = 'trace-line';
        none.textContent = 'No gaps';
        traceTarget.appendChild(none);
      } else {
        gaps.forEach(id => {
          const gap = document.createElement('div');
          gap.className = 'trace-line trace-gap';
          gap.setAttribute('data-trace-gap', id);
          gap.textContent = nodesById.get(id)?.label || id;
          traceTarget.appendChild(gap);
        });
      }
    }
  }
}

function renderReviewChapter() {
  const gateLine = document.getElementById('gate-line');
  if (gateLine && typeof trustSummary === 'function') {
    const summary = trustSummary(ARCH_SPEC, QUALITY_GATE);
    gateLine.textContent = summary.gate.label;
  }

  // Rules
  const rulesTarget = document.getElementById('review-rules');
  if (rulesTarget) {
    const policies = ARCH_SPEC.policies || [];
    if (!policies.length) {
      rulesTarget.innerHTML = '<div style="color: var(--muted); font-size: 12px;">No rules defined.</div>';
    } else {
      const findings = (ARCH_SPEC.findings || []).concat(ARCH_SPEC.review?.policyFindings || []);
      const violatedIds = new Set(findings.filter(f => f && f.policyId).map(f => f.policyId));
      rulesTarget.innerHTML = policies.map(policy => {
        const isViolated = violatedIds.has(policy.id);
        const statusText = isViolated ? 'Violated' : 'Pass';
        const statusClass = isViolated ? 'violated' : 'pass';
        return `<div class="rule-row"><span class="rule-status ${statusClass}">${statusText}</span><span class="rule-desc">${escapeHtml(policy.description || policy.id)}</span></div>`;
      }).join('');
    }
  }

  // Assumptions
  const assumptionsTarget = document.getElementById('review-assumptions');
  if (assumptionsTarget) {
    const rawAssumptions = ARCH_SPEC.review?.assumptions ?? ARCH_SPEC.meta?.assumptions;
    const assumptions = Array.isArray(rawAssumptions) ? rawAssumptions : [];
    if (!assumptions.length) {
      assumptionsTarget.innerHTML = '<div style="color: var(--muted); font-size: 12px;">No assumptions recorded.</div>';
    } else {
      assumptionsTarget.innerHTML = assumptions.map(a => {
        const text = typeof a === 'string' ? a : (a.text || a.description || (typeof reviewValue === 'function' ? reviewValue(a) : String(a)));
        return `<div class="detail-card" style="margin-bottom: 6px; font-size: 12px;">${escapeHtml(text)}</div>`;
      }).join('');
    }
  }

  // Open questions
  const questionsTarget = document.getElementById('review-questions');
  if (questionsTarget) {
    const rawQuestions = ARCH_SPEC.review?.unresolvedQuestions ?? ARCH_SPEC.meta?.unresolvedQuestions;
    const questions = Array.isArray(rawQuestions) ? rawQuestions : [];
    if (!questions.length) {
      questionsTarget.innerHTML = '<div style="color: var(--muted); font-size: 12px;">No open questions recorded.</div>';
    } else {
      questionsTarget.innerHTML = questions.map(q => {
        const text = typeof q === 'string' ? q : (q.text || q.description || q.question || (typeof reviewValue === 'function' ? reviewValue(q) : String(q)));
        return `<div class="detail-card" style="margin-bottom: 6px; font-size: 12px;">${escapeHtml(text)}</div>`;
      }).join('');
    }
  }

  // Decisions
  const decisionsTarget = document.getElementById('review-decisions');
  if (decisionsTarget) {
    const decisions = Array.isArray(ARCH_SPEC.meta?.decisions) ? ARCH_SPEC.meta.decisions : [];
    if (!decisions.length) {
      decisionsTarget.innerHTML = '<div style="color: var(--muted); font-size: 12px;">No decisions recorded.</div>';
    } else {
      decisionsTarget.innerHTML = decisions.map(d => {
        return `<div class="detail-card" style="margin-bottom: 6px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
            <strong>${escapeHtml(d.title || '')}</strong>
            ${d.status ? `<span class="badge-status ${escapeHtml(d.status)}">${escapeHtml(d.status)}</span>` : ''}
          </div>
          <div style="font-size: 12px; color: var(--muted);">${escapeHtml(d.decision || '')}</div>
        </div>`;
      }).join('');
    }
  }
}
