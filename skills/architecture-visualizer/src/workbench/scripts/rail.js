function availableChapters() {
  const chapters = [
    { id: 'walkthrough', label: 'Walkthrough' },
    { id: 'review', label: 'Review' }
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
  const initialChapter = availableIds.has(state.chapter) ? state.chapter : 'walkthrough';
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
  const targetId = found ? id : (chapters[0]?.id || 'walkthrough');
  const targetChapter = found || chapters[0] || { id: targetId, label: targetId };

  actions.setChapter(targetId);

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
