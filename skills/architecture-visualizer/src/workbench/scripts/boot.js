function initMotionPreference() {
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  state.prefersReducedMotion = Boolean(media?.matches);
  if (state.prefersReducedMotion) stopFlowParticles();
  media?.addEventListener?.('change', event => {
    state.prefersReducedMotion = event.matches;
    if (event.matches) {
      stopFlowParticles();
      stopScenarioPlayback();
    }
  });
}

let lastOverlayMode = null;
function syncResponsiveRegions(force) {
  const overlay = isOverlayPanels();
  const railRegion = document.querySelector('[data-region="rail"]');
  if (railRegion) {
    railRegion.setAttribute('aria-modal', overlay && railRegion.getAttribute('data-open') === 'true' ? 'true' : 'false');
  }
  if (!force && overlay === lastOverlayMode) return;
  lastOverlayMode = overlay;
  activeDrawer = null;
  drawerReturnFocus = null;
  if (railRegion) {
    railRegion.setAttribute('data-open', overlay ? 'false' : 'true');
  }
}

// Initialize application
function init() {
  syncResponsiveRegions(true);
  restorePersistedLayout();
  if (ARCH_SPEC.meta) {
    document.getElementById('doc-title').textContent = ARCH_SPEC.meta.title || 'Architecture Visualization';
    const subtitleEl = document.getElementById('doc-subtitle');
    subtitleEl.textContent = ARCH_SPEC.meta.description || '';
    subtitleEl.setAttribute('title', subtitleEl.textContent);
    const statusBadge = document.getElementById('doc-status');
    statusBadge.textContent = ARCH_SPEC.meta.status || 'PROPOSED';
    statusBadge.className = `badge-status ${ARCH_SPEC.meta.status || 'PROPOSED'}`;
  }

  initTheme();
  initMotionPreference();
  setupEventListeners();
  renderDiagram();
  renderReviewNavigator();
  renderScenarioNavigator();
  renderMinimap();
  renderERView();
  renderImplementationPlanView();
  renderQualityGate();
  renderTrustStrip();
  initRail();
  renderOverviewChapter();
  renderChangesChapter();
  renderEvidenceChapter();
  renderReviewChapter();
  applyVisibility();
  fitToScreen();
  const linkNotices = restoreUrlState();
  viewStateReady = true;
  if (window.ResizeObserver) new ResizeObserver(() => { if (holdsLinkedCamera()) applyLinkedCamera(); }).observe(container);
  applyFocusMode();
  document.body.setAttribute('data-ready-ms', String(Math.round(performance.now())));
  announceStatus(['Architecture workbench ready.', ...linkNotices].join(' '));
}

function initTheme() {
  let stored = null;
  try {
    stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch (err) {
    stored = null;
  }
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  actions.setTheme(stored === THEMES.LIGHT || stored === THEMES.DARK
    ? stored
    : (prefersLight ? THEMES.LIGHT : THEMES.DARK));
  applyTheme();
}

function applyTheme() {
  document.body.setAttribute('data-theme', state.theme);
  setIconLabel(document.getElementById('theme-icon'), state.theme === THEMES.DARK ? 'ui-moon' : 'ui-sun');
}

function toggleTheme() {
  actions.setTheme(state.theme === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK);
  applyTheme();
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, state.theme);
  } catch (err) {
    /* storage unavailable (private mode) - theme still applies for this session */
  }
}

function fitFromButton() {
  actions.setCamera({ userMoved: false });
  fitToScreen();
}

function toggleGatePanel() {
  openChapter('review');
  setDrawerOpen('rail', true, document.activeElement);
  const gateSec = document.getElementById('section-gate') || document.getElementById('gate-body');
  gateSec?.scrollIntoView?.({ block: 'nearest' });
}

function setupEventListeners() {
  const btnPalette = document.getElementById('btn-palette');
  if (btnPalette) btnPalette.addEventListener('click', () => togglePalette(btnPalette));

  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  document.getElementById('btn-copy-link').addEventListener('click', copyCurrentLink);

  const lensButtons = [...document.querySelectorAll('.lens-switcher [data-lens]')];
  lensButtons.forEach((button, index) => {
    button.addEventListener('click', () => selectLens(button.dataset.lens, { explicit: true }));
    button.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowLeft') next = (index + lensButtons.length - 1) % lensButtons.length;
      else if (event.key === 'ArrowRight') next = (index + 1) % lensButtons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = lensButtons.length - 1;
      else return;
      event.preventDefault();
      event.stopPropagation();
      selectLens(lensButtons[next].dataset.lens, { explicit: true });
      lensButtons[next].focus();
    });
  });
  document.querySelector('.lens-select').addEventListener('change', event => {
    selectLens(event.target.value, { explicit: true });
  });
  selectLens(state.lens, { explicit: false });

  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  document.getElementById('btn-fit').addEventListener('click', fitFromButton);
  document.getElementById('btn-reset').addEventListener('click', resetView);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    syncResponsiveRegions();
    if (!state.userMovedView) fitToScreen();
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { if (!state.userMovedView) fitToScreen(); else updateMinimapViewport(); }, 150);
  });

  container.addEventListener('wheel', handleWheel, { passive: false });
  container.addEventListener('mousedown', handleMouseDown);
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mouseup', handleMouseUp);
  container.addEventListener('touchstart', handleTouchStart, { passive: false });
  container.addEventListener('touchmove', handleTouchMove, { passive: false });
  container.addEventListener('touchend', handleTouchEnd);

  const railToggle = document.querySelector('[data-action="rail-toggle"]');
  if (railToggle) railToggle.addEventListener('click', () => toggleDrawer('rail', railToggle));
  document.querySelector('[data-action="rail-close"]')?.addEventListener('click', () => setDrawerOpen('rail', false));
  document.querySelector('[data-action="sheet-back"]')?.addEventListener('click', hideSheetKeepSelection);
  document.querySelector('[data-action="inspector-close"]').addEventListener('click', closeInspector);
  document.querySelector('[data-action="drawer-backdrop"]').addEventListener('click', closeActiveDrawer);
  document.querySelector('[data-region="minimap"]').addEventListener('mousedown', event => event.stopPropagation());
  document.querySelector('[data-region="minimap"]').addEventListener('click', handleMinimapClick);
  document.getElementById('btn-focus-neighbors').addEventListener('click', () => setFocusMode(FOCUS_MODES.NEIGHBORS));
  document.getElementById('btn-focus-affected').addEventListener('click', () => setFocusMode(FOCUS_MODES.AFFECTED));
  document.addEventListener('fullscreenchange', () => {
    const enabled = Boolean(document.fullscreenElement);
    document.body.setAttribute('data-fullscreen', String(enabled));
  });
  window.addEventListener('hashchange', () => {
    const notices = restoreUrlState();
    if (notices.length) announceStatus(notices.join(' '));
  });

  document.getElementById('ins-btn-highlight').addEventListener('click', () => {
    if (state.selectedNodeId) {
      state.highlightedChain = state.highlightedChain === state.selectedNodeId ? null : state.selectedNodeId;
      applyVisibility();
    }
  });

  document.getElementById('seq-prev').addEventListener('click', () => stepSequence(-1));
  document.getElementById('seq-next').addEventListener('click', () => stepSequence(1));
  document.getElementById('seq-play').addEventListener('click', toggleSequencePlay);
  document.getElementById('seq-slider').addEventListener('input', e => {
    stopSequenceTimer();
    goToSequenceStep(parseInt(e.target.value, 10) - 1);
  });

  document.getElementById('btn-export').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('export-menu').classList.toggle('open');
  });
  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('export-menu').classList.remove('open');
      runExport(btn.dataset.export);
    });
  });


  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-copy').addEventListener('click', copyModalContent);

  document.addEventListener('click', () => document.getElementById('export-menu').classList.remove('open'));
  document.addEventListener('keydown', trapDrawerFocus);
  document.addEventListener('keydown', handleKeyDown);
  svg.addEventListener('click', () => {
    if (!state.dragMoved) closeInspector();
  });
}

function handleKeyDown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) {
    e.preventDefault();
    togglePalette(document.activeElement);
    return;
  }

  if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const typingTarget = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ||
      e.target instanceof HTMLSelectElement || e.target.isContentEditable;
    if (!typingTarget) {
      e.preventDefault();
      toggleShortcuts(document.activeElement);
      return;
    }
  }

  if (shortcutsOpenState && e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeShortcuts(true);
    return;
  }

  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement || e.target.isContentEditable;
  if (typing) {
    if (e.key === 'Escape' && activeDrawer) {
      closeActiveDrawer();
      return;
    }
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  if (handleWalkthroughKey(e)) return;

  if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-4]$/.test(e.key)) {
    selectLens(LENSES[Number(e.key) - 1], { explicit: true });
    e.preventDefault();
    return;
  }

  switch (e.key) {
    case 'Escape':
      if (state.presentation) { setPresentation(false); break; }
      if (document.fullscreenElement) { document.exitFullscreen?.(); break; }
      if (state.focusMode) { setFocusMode(state.focusMode); break; }
      if (!document.getElementById('component-sheet')?.hidden) { hideSheetKeepSelection(); break; }
      if (state.scenarioActive) { endWalkthrough(); break; }
      closeActiveDrawer();
      closeModal();
      document.getElementById('export-menu').classList.remove('open');
      closeInspector();
      break;
    case '+':
    case '=':
      zoomBy(1.2);
      break;
    case '-':
      zoomBy(0.8);
      break;
    case '0':
      resetView();
      break;
    case 'f':
    case 'F':
      fitToScreen();
      break;
    case 'a':
    case 'A':
      toggleFlowAnimation();
      break;
    case 'ArrowLeft':
      actions.setCamera({ panX: state.panX + 60 }); updateTransform(); e.preventDefault(); break;
    case 'ArrowRight':
      actions.setCamera({ panX: state.panX - 60 }); updateTransform(); e.preventDefault(); break;
    case 'ArrowUp':
      actions.setCamera({ panY: state.panY + 60 }); updateTransform(); e.preventDefault(); break;
    case 'ArrowDown':
      actions.setCamera({ panY: state.panY - 60 }); updateTransform(); e.preventDefault(); break;
    default:
      break;
  }
}

function switchView(viewName) {
  if (viewName === VIEWS.DATABASE_ER) {
    openChapter('data');
    return;
  }
  if (viewName === VIEWS.IMPLEMENTATION_PLAN) {
    openChapter('plan');
    return;
  }
  if (viewName !== VIEWS.SEQUENCE) stopScenarioPlayback();
  // Before/After is the Change lens's canvas mode, and a lens must work during any walkthrough.
  if (viewName !== VIEWS.ARCHITECTURE && viewName !== VIEWS.BEFORE_AFTER) suspendWalkthrough();
  actions.setView(viewName);
  document.getElementById('sequence-bar').classList.toggle('visible', viewName === VIEWS.SEQUENCE);
  document.getElementById('flow-hint').classList.toggle('visible', viewName === VIEWS.DATA_FLOW);

  if (viewName !== VIEWS.SEQUENCE) {
    stopSequencePlayback();
  } else {
    initSequencePlayback();
  }

  if (viewName === VIEWS.DATA_FLOW && !state.animatingFlow) {
    toggleFlowAnimation();
  }
  if (viewName !== VIEWS.DATA_FLOW && state.animatingFlow && viewName !== VIEWS.ARCHITECTURE) {
    toggleFlowAnimation();
  }

  applyVisibility();
  updateUrlState();
}
