function workbenchDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function chapterCount(id) {
  if (id === 'walkthrough') return (ARCH_SPEC.scenarios || [])[0] ? walkAllStepsTotal(ARCH_SPEC.scenarios[0]) : null;
  if (id === 'changes') return ARCH_SPEC.review?.changedComponents?.length || (ARCH_SPEC.nodes || []).filter(node => node.delta && node.delta !== 'UNCHANGED').length;
  if (id === 'review') return (ARCH_SPEC.policies || []).length + (ARCH_SPEC.findings || []).length + (ARCH_SPEC.review?.policyFindings || []).length + (ARCH_SPEC.review?.unresolvedQuestions ?? ARCH_SPEC.meta?.unresolvedQuestions ?? []).length;
  return null;
}

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
  initChapterTabScroll();

  // Ensure current chapter is set and panel is visible
  const initialChapter = availableIds.has(state.chapter) ? state.chapter : 'overview';
  openChapter(initialChapter);
}

// Seven chapters do not fit a 400px rail. The strip scrolls, a chevron shows at each end with more
// chapters behind it, a vertical wheel scrolls it sideways, and the open chapter is kept in view.
function syncChapterTabOverflow() {
  const strip = document.querySelector('.rail-chapters');
  if (!strip) return;
  const more = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  document.querySelectorAll('[data-tabs-scroll]').forEach(button => {
    button.hidden = button.dataset.tabsScroll === '1' ? !more : strip.scrollLeft <= 1;
  });
}

function revealChapterTab(tab) {
  const strip = document.querySelector('.rail-chapters');
  if (!strip || !tab) return;
  const left = tab.offsetLeft - strip.offsetLeft;
  if (left < strip.scrollLeft) strip.scrollLeft = left - 8;
  else if (left + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + tab.offsetWidth - strip.clientWidth + 8;
  syncChapterTabOverflow();
}

function initChapterTabScroll() {
  const strip = document.querySelector('.rail-chapters');
  if (!strip || strip.dataset.scrollReady) return;
  strip.dataset.scrollReady = 'true';
  strip.addEventListener('scroll', syncChapterTabOverflow, { passive: true });
  strip.addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += event.deltaY;
    event.preventDefault();
  }, { passive: false });
  document.querySelectorAll('[data-tabs-scroll]').forEach(button => button.addEventListener('click', () => {
    strip.scrollLeft += Number(button.dataset.tabsScroll) * strip.clientWidth * 0.6;
  }));
  if (typeof ResizeObserver === 'function') new ResizeObserver(syncChapterTabOverflow).observe(strip);
  syncChapterTabOverflow();
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
    const count = chapterCount(ch.id);
    if (count !== null) {
      const number = document.createElement('span');
      number.className = 'rail-tab-count';
      number.textContent = String(count);
      tab.append(' ', number);
    }

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
      if (isSelected) revealChapterTab(tab);
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

  // A different chapter, or leaving a component sheet, starts at the top of the chapter.
  const sheetWasOpen = !document.getElementById('component-sheet')?.hidden;
  const railBody = document.querySelector('.rail-body');
  if (railBody && (chapterChanged || sheetWasOpen) && targetId !== 'walkthrough') railBody.scrollTop = 0;

  // Closes the sheet, keeping the selection
  hideSheetKeepSelection();
  // Closing a sheet brings the rail's close button back and narrows the strip; keep the tab in view.
  window.requestAnimationFrame(() => revealChapterTab(document.getElementById(`chapter-tab-${targetId}`)));
  if (targetId === 'walkthrough' && typeof scrollRailToWalkCursor === 'function') window.requestAnimationFrame(scrollRailToWalkCursor);

  // Update back button text in sheet
  const backBtn = document.querySelector('[data-action="sheet-back"]');
  if (backBtn) {
    const label = backBtn.querySelector('span');
    if (label) label.textContent = `Back to ${targetChapter.label}`;
    else backBtn.textContent = `Back to ${targetChapter.label}`;
  }

  updateUrlState();
}

function hideSheetKeepSelection() {
  applySelectionSpotlight(null);
  const sheet = document.getElementById('component-sheet');
  // Leaving a component returns to the whole diagram, unless the reader placed the camera or a walkthrough holds it.
  if (sheet && !sheet.hidden && !state.userMovedView && !(typeof walkIsActive === 'function' && walkIsActive())) {
    window.requestAnimationFrame(() => fitToScreen());
  }
  if (sheet) sheet.setAttribute('hidden', '');
  const rail = document.getElementById('rail');
  if (rail) rail.setAttribute('data-sheet', 'none');
}

function showSheet(kind) {
  const sheet = document.getElementById('component-sheet');
  if (sheet) sheet.removeAttribute('hidden');
  const rail = document.getElementById('rail');
  if (rail) rail.setAttribute('data-sheet', kind);
  setDrawerOpen('rail', true);
}

function chapterLabel(id) {
  const chapter = availableChapters().find(item => item.id === id);
  return chapter ? chapter.label : id;
}

function renderOverviewChapter() {
  if (!document.getElementById('chapter-overview')) return;
  const meta = ARCH_SPEC.meta || {};
  const panel = document.getElementById('chapter-overview');
  if (!panel.querySelector('.overview-eyebrow')) {
    const eyebrow = document.createElement('p');
    eyebrow.className = 'overview-eyebrow';
    eyebrow.textContent = 'SYSTEM';
    panel.prepend(eyebrow);
  }

  const title = document.getElementById('overview-title');
  if (title) title.textContent = meta.title || 'Overview';

  const description = document.getElementById('overview-description');
  if (description) description.textContent = meta.description || '';

  const metaLine = document.getElementById('overview-meta');
  if (metaLine) {
    metaLine.textContent = [meta.author, workbenchDate(meta.date)].filter(part => part != null && part !== '').join(' · ');
  }

  const facts = document.getElementById('overview-facts');
  if (facts) {
    facts.replaceChildren();
    [
      ['component', (ARCH_SPEC.nodes || []).length],
      // A model without boundaries is drawn in one lane, so count the lanes on the canvas.
      ['layer', (LAYOUT_DATA.boundaries || ARCH_SPEC.boundaries || []).length],
      ['connection', (ARCH_SPEC.edges || []).length],
    ].forEach(([word, count]) => {
      const label = plural(count, word).replace(/^\S+ /, '');
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
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ov-trust-row';
      row.setAttribute('data-trust-chapter', entry.chapter);
      row.addEventListener('click', () => openTrustChapter(entry.chapter, row));
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

      row.append(dot, label, detail);
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
      const entries = linearizeScenario(scenario, {});
      const decisionIndex = entries.findIndex(entry => entry.kind === 'decision');
      const main = decisionIndex < 0 ? entries : entries.slice(0, decisionIndex + 1);
      const heading = stagesTarget.previousElementSibling;
      heading.textContent = 'How it works';
      const aside = document.createElement('span');
      aside.className = 'overview-path-count';
      const decision = main.find(entry => entry.kind === 'decision');
      aside.textContent = plural(walkthroughTotal(main), 'step') + (decision ? `, then ${plural(decision.branches.length, 'outcome')}` : '');
      heading.appendChild(aside);
      main.forEach(entry => {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'overview-stage';
        button.setAttribute('data-overview-stage', entry.id);
        const number = document.createElement('span');
        number.className = 'overview-step-number';
        number.textContent = entry.kind === 'decision' ? '◇' : String(entry.number);
        const name = document.createElement('span');
        name.className = 'overview-step-name';
        name.textContent = entry.kind === 'decision' ? `Decision: ${entry.stage.condition || entry.id}` : entry.stage.name || entry.stage.label || entry.id;
        button.append(number, name);
        if (entry.kind === 'decision') {
          const outcomes = document.createElement('span');
          outcomes.className = 'overview-step-outcomes';
          outcomes.textContent = entry.branches.map(branch => branch.name || branch.condition).join(' · ');
          button.appendChild(outcomes);
        }
        button.addEventListener('click', () => {
          startWalkthrough(scenario.id);
          walkTo(entry.id);
          openChapter('walkthrough');
        });
        item.appendChild(button);
        stagesTarget.appendChild(item);
      });
      let start = panel.querySelector('[data-start-walkthrough]');
      if (!start) {
        start = document.createElement('button');
        start.type = 'button';
        start.className = 'overview-start';
        start.setAttribute('data-start-walkthrough', '');
        start.textContent = 'Start walkthrough';
        start.addEventListener('click', () => { startWalkthrough(scenario.id); openChapter('walkthrough'); });
      }
      stagesTarget.after(start);
      const trustHeading = trust?.previousElementSibling;
      if (trustHeading?.tagName === 'H3') start.after(trustHeading, trust);

    }
  }

  // What this proposal changes, then what is still open: rows a reader can follow into the chapters.
  const changes = document.getElementById('overview-changes');
  if (changes) {
    const names = list => list.length <= 4 ? list.join(', ') : `${list.slice(0, 4).join(', ')} and ${list.length - 4} more`;
    const byDelta = delta => (ARCH_SPEC.nodes || []).filter(node => node.delta === delta).map(node => node.label || node.id);
    const rows = [['ADDED', '+', 'added'], ['CHANGED', '~', 'changed'], ['MODIFIED', '~', 'changed'], ['REMOVED', '\u2212', 'removed'], ['MOVED', '\u2194', 'moved']]
      .map(([delta, marker, verb]) => [marker, byDelta(delta), verb])
      .filter(([, list]) => list.length)
      .map(([marker, list, verb]) => sheetListItem(marker, `${plural(list.length, 'component')} ${verb}`, names(list), () => openChapter('changes')));
    const list = document.createElement('ul');
    list.className = 'sheet-list';
    list.append(...rows);
    changes.replaceChildren(rows.length ? list : Object.assign(document.createElement('p'), { className: 'rail-muted', textContent: 'This model describes the system as it is; nothing changes.' }));
  }
  const open = document.getElementById('overview-open');
  if (open) {
    const meta = ARCH_SPEC.meta || {};
    const assumptions = ARCH_SPEC.review?.assumptions || meta.assumptions || [];
    const decisions = meta.decisions || [];
    const questions = ARCH_SPEC.review?.unresolvedQuestions || meta.unresolvedQuestions || [];
    const toReview = anchor => () => {
      openChapter('review');
      window.requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
    };
    const list = document.createElement('ul');
    list.className = 'sheet-list';
    if (assumptions.length) list.appendChild(sheetListItem('?', plural(assumptions.length, 'assumption'), 'The design depends on these being true.', toReview('assumptions')));
    if (decisions.length) list.appendChild(sheetListItem('\u2261', plural(decisions.length, 'recorded decision'), decisions.map(d => d.id || d.title).join(', '), () => openChapter('review')));
    list.appendChild(sheetListItem('?', questions.length ? plural(questions.length, 'open question') : 'No open questions recorded',
      questions.length ? questions.slice(0, 2).map(q => (typeof q === 'string' ? q : q.question || q.text || '')).join(' · ') : 'Unresolved questions in the spec would appear here.', toReview('assumptions')));
    open.replaceChildren(list);
  }
}

const CHANGE_DELTAS = [
  ['ADDED', 'Added'],
  ['CHANGED', 'Changed'],
  ['REMOVED', 'Removed'],
  ['MOVED', 'Moved'],
];

function chapterIntro(panel, eyebrow, headline, context) {
  let title = panel.querySelector('h2');
  let label = panel.querySelector('.chapter-eyebrow');
  if (!label) {
    label = document.createElement('p');
    label.className = 'chapter-eyebrow';
    title.before(label);
  }
  label.textContent = eyebrow;
  title.textContent = headline;
  let prose = panel.querySelector('.chapter-context');
  if (!prose) {
    prose = document.createElement('p');
    prose.className = 'chapter-context';
    title.after(prose);
  }
  prose.textContent = context;
}

function chapterHeading(title, count) {
  const heading = document.createElement('h3');
  heading.textContent = title;
  const aside = document.createElement('span');
  aside.className = 'chapter-aside';
  aside.textContent = String(count);
  heading.appendChild(aside);
  return heading;
}

function chapterRow(marker, title, note, aside, tone, onClick) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'sheet-list-row chapter-row';
  row.dataset.tone = tone;
  const mark = document.createElement('span');
  mark.className = 'sheet-list-marker';
  mark.textContent = marker;
  const text = document.createElement('span');
  text.className = 'sheet-list-text';
  const name = document.createElement('span');
  name.className = 'sheet-list-title';
  name.textContent = title;
  const description = document.createElement('span');
  description.className = 'sheet-list-note';
  description.textContent = note;
  text.append(name, description);
  const right = document.createElement('span');
  right.className = 'chapter-aside';
  right.textContent = aside;
  row.append(mark, text, right);
  row.addEventListener('click', onClick);
  return row;
}

function collapseChapterContent(target, title) {
  if (target.parentElement.tagName === 'DETAILS') return;
  const heading = target.previousElementSibling;
  const fold = document.createElement('details');
  fold.className = 'chapter-fold';
  const summary = document.createElement('summary');
  summary.textContent = title;
  target.before(fold);
  fold.append(summary, target);
  if (heading?.tagName === 'H3') heading.remove();
}

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

  const added = changed.filter(entry => entry.delta === 'ADDED');
  const modified = changed.filter(entry => entry.delta === 'CHANGED');
  const removed = changed.filter(entry => entry.delta === 'REMOVED');
  const moved = changed.filter(entry => entry.delta === 'MOVED');
  const newEdges = (ARCH_SPEC.edges || []).filter(edge => edge.delta === 'ADDED');
  const counts = [[added.length, 'added'], [modified.length, 'changed'], [removed.length, 'removed'], [moved.length, 'moved'], [newEdges.length, 'new connections']];
  const nameOf = id => nodesById.get(id)?.label || id;
  const phrases = [];
  if (added.length) phrases.push(`adds ${added.map(entry => nameOf(entry.id)).join(', ')}`);
  if (modified.length) phrases.push(`changes ${modified.map(entry => nameOf(entry.id)).join(', ')}`);
  if (removed.length) phrases.push(`removes ${removed.map(entry => nameOf(entry.id)).join(', ')}`);
  if (moved.length) phrases.push(`moves ${moved.map(entry => nameOf(entry.id)).join(', ')}`);
  chapterIntro(deltas.closest('.rail-panel'), 'CHANGES', counts.filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(', ') || 'No changes',
    phrases.length ? `The proposal ${phrases.join(' and ')}.` : newEdges.length ? `The proposal adds ${plural(newEdges.length, 'connection')} between existing components.` : 'No component additions or changes are recorded.');
  deltas.replaceChildren();
  CHANGE_DELTAS.forEach(([delta, label]) => {
    const components = changed.filter(entry => entry.delta === delta);
    if (!components.length) return;
    const group = document.createElement('section');
    group.className = 'change-group';
    group.dataset.changeDelta = delta;
    group.appendChild(chapterHeading(label, components.length));
    components.forEach(entry => {
      const node = nodesById.get(entry.id) || entry;
      const links = (ARCH_SPEC.edges || []).filter(edge => edge.source === entry.id || edge.target === entry.id).length;
      const button = chapterRow(delta === 'ADDED' ? '+' : delta === 'REMOVED' ? '−' : '~', entry.label || node.label || entry.id,
        node.description || '', `${links} link${links === 1 ? "" : "s"}`, delta === 'ADDED' ? 'ok' : delta === 'REMOVED' ? 'risk' : 'warn', () => openInspectorForNode(entry.id));
      button.classList.add('change-component');
      button.dataset.changeComponent = entry.id;
      group.appendChild(button);
    });
    deltas.appendChild(group);
  });
  if (newEdges.length) {
    deltas.appendChild(chapterHeading('New connections', newEdges.length));
    newEdges.forEach(edge => {
      const row = chapterRow('+', edge.label || edge.id, `${nameOf(edge.source)} → ${nameOf(edge.target)}`, edge.communication || '', 'ok', () => {
        frameModelNodes([edge.source, edge.target], [edge.id]);
        const group = document.getElementById(`edge-${edge.id}`);
        group?.classList.add('chapter-edge-focus');
        window.setTimeout(() => group?.classList.remove('chapter-edge-focus'), 1800);
      });
      row.dataset.changeEdge = edge.id;
      deltas.appendChild(row);
    });
  }

  const blastTarget = document.getElementById('changes-blast');
  if (blastTarget) {
    collapseChapterContent(blastTarget, 'Blast radius');
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
    collapseChapterContent(traceTarget, 'Traceability');
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
  const panel = document.getElementById('chapter-review');
  if (!panel) return;
  const policies = ARCH_SPEC.policies || [];
  const findings = (ARCH_SPEC.findings || []).concat(ARCH_SPEC.review?.policyFindings || []);
  const violatedIds = new Set(findings.filter(finding => finding?.policyId).map(finding => finding.policyId));
  const failing = policies.filter(policy => violatedIds.has(policy.id)).length;
  const failures = (ARCH_SPEC.nodes || []).flatMap(node => (node.details?.failureModes || []).map(failure => ({ node, failure: normalizeFailureMode(failure) })));
  chapterIntro(panel, 'REVIEW', (failing ? `${failing} of ${plural(policies.length, 'rule')} violated` : policies.length ? 'All rules pass' : 'No rules defined') +
    (failures.length ? `, ${plural(failures.length, 'known failure mode')}` : ''),
    'Rules are drawn on the canvas: required paths in green, forbidden ones as red dashed lines that must stay absent.');
  const rules = document.getElementById('section-rules');
  rules.querySelector('h3').replaceWith(chapterHeading('Architecture rules', `${policies.length - failing} of ${policies.length} pass`));
  const target = document.getElementById('review-rules');
  target.replaceChildren();
  const nameOf = id => (ARCH_SPEC.nodes || []).find(node => node.id === id)?.label || id;
  policies.forEach(policy => {
    const violated = violatedIds.has(policy.id);
    const kind = { required_dependency: 'Required path', forbidden_dependency: 'Forbidden path', required_evidence: 'Evidence rule' }[policy.kind] || policy.kind;
    const row = chapterRow(violated ? '!' : '✓', policy.description || policy.id,
      `${kind}${policy.from ? ` · ${nameOf(policy.from)} → ${nameOf(policy.to)}` : ''}`, violated ? 'Violated' : 'Pass', violated ? 'risk' : 'ok', () => {
        selectLens('risk');
        frameModelNodes([policy.from, policy.to].filter(Boolean));
      });
    row.dataset.policyId = policy.id;
    target.appendChild(row);
  });
  if (!policies.length) target.textContent = 'No rules defined.';
  const failureSection = document.getElementById('section-findings');
  let failureTarget = failureSection.querySelector('[data-failure-list]');
  if (!failureTarget) {
    failureTarget = document.createElement('div');
    failureTarget.setAttribute('data-failure-list', '');
    const heading = document.createElement('h3');
    heading.textContent = 'Failure modes';
    failureSection.append(heading, failureTarget);
  }
  failureTarget.replaceChildren();
  failures.forEach(({ node, failure }) => {
    const row = chapterRow('!', failure.failure, `${node.label || node.id} · ${failure.impact || 'Impact not recorded'}. Mitigation: ${failure.mitigation || 'Not recorded'}.`, '', 'warn', () => openInspectorForNode(node.id));
    row.dataset.failureNode = node.id;
    failureTarget.appendChild(row);
  });
  if (!failures.length) failureTarget.textContent = 'None recorded.';

  const decisions = document.getElementById('review-decisions');
  decisions.replaceChildren();
  (ARCH_SPEC.meta?.decisions || []).forEach(decision => {
    const fold = document.createElement('details');
    fold.className = 'chapter-fold';
    const summary = document.createElement('summary');
    summary.textContent = `${decision.id || ''} ${decision.title || ''}`.trim();
    const body = document.createElement('div');
    body.className = 'chapter-fold-body';
    ['Context', 'Decision', 'Consequences'].forEach(label => appendReviewField(body, label, decision[label.toLowerCase()]));
    fold.append(summary, body);
    decisions.appendChild(fold);
  });
  if (!decisions.childElementCount) decisions.textContent = 'None recorded.';
  ['assumptions', 'questions'].forEach(kind => {
    const section = document.getElementById(`section-${kind}`);
    if (kind === 'assumptions') section.querySelector('h3').id = 'assumptions';
    const target = document.getElementById(`review-${kind}`);
    const key = kind === 'questions' ? 'unresolvedQuestions' : 'assumptions';
    const entries = ARCH_SPEC.review?.[key] ?? ARCH_SPEC.meta?.[key] ?? [];
    target.replaceChildren();
    const list = document.createElement('ul');
    list.className = 'sheet-bullets';
    entries.forEach(entry => {
      const item = document.createElement('li');
      item.textContent = typeof entry === 'string' ? entry : entry.text || entry.description || entry.question || reviewValue(entry);
      list.appendChild(item);
    });
    if (entries.length) target.appendChild(list);
    else { target.classList.add('rail-muted'); target.textContent = 'None recorded.'; }
  });
  const gateSection = document.getElementById('section-gate');
  let gate = document.getElementById('gate');
  if (!gate) {
    gate = document.createElement('details');
    gate.id = 'gate';
    gate.className = 'chapter-fold';
    const summary = document.createElement('summary');
    summary.textContent = 'Quality gate';
    const count = document.createElement('span');
    count.className = 'chapter-aside';
    count.textContent = `${QUALITY_GATE.filter(check => check.status === 'PASS').length} pass · ${QUALITY_GATE.filter(check => check.status === 'SKIP').length} skipped`;
    summary.appendChild(count);
    gateSection.querySelector('h3').remove();
    gateSection.querySelector('#gate-line').hidden = true;
    gate.append(summary, gateSection);
    // Trust controls open Review without scrolling to a section. Reveal the gate
    // after their chapter action, including controls recreated by a trust render.
    document.addEventListener('click', event => {
      if (event.target.closest('.trust-pill[data-trust="rules"], .ov-trust-row[data-trust-key="rules"]')) {
        gateSection.scrollIntoView({ block: 'nearest' });
      }
    });
  }
  panel.append(rules, failureSection, document.getElementById('section-decisions'), document.getElementById('section-assumptions'), document.getElementById('section-questions'), gate);
  // Existing trust and palette actions scroll this section; reveal its fold before scrolling.
  gateSection.scrollIntoView = options => {
    gate.open = true;
    gate.scrollIntoView(options);
  };
}
