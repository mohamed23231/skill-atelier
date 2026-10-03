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
  const navigator = document.querySelector('[data-region="navigator"]');
  const inspectorRegion = document.querySelector('[data-region="inspector"]');
  navigator.setAttribute('aria-modal', overlay ? 'true' : 'false');
  inspectorRegion.setAttribute('aria-modal', overlay && inspectorRegion.getAttribute('data-open') === 'true' ? 'true' : 'false');
  if (!force && overlay === lastOverlayMode) return;
  lastOverlayMode = overlay;
  activeDrawer = null;
  drawerReturnFocus = null;
  navigator.setAttribute('data-open', overlay ? 'false' : 'true');
  inspectorRegion.setAttribute('data-open', 'false');
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
    document.getElementById('doc-grounding').hidden = ARCH_SPEC.meta.grounding !== 'illustrative';
  }

  initTheme();
  initMotionPreference();
  setupEventListeners();
  renderDiagram();
  renderNavigatorOutline();
  renderReviewNavigator();
  renderScenarioNavigator();
  renderMinimap();
  renderERView();
  renderImplementationPlanView();
  renderQualityGate();
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
  document.getElementById('gate-panel').classList.toggle('open');
}

function setupEventListeners() {
  const btnPalette = document.getElementById('btn-palette');
  if (btnPalette) btnPalette.addEventListener('click', () => togglePalette(btnPalette));

  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Tabs bar: vertical mouse wheel scrolls the horizontal tab strip
  const tabsSection = document.querySelector('.tabs-section');
  if (tabsSection) {
    tabsSection.addEventListener('wheel', event => {
      if (tabsSection.scrollWidth <= tabsSection.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      tabsSection.scrollLeft += event.deltaY;
    }, { passive: false });

    // Tabs bar: minimize toggle collapses the strip to the active view only
    const tabsMinToggle = tabsSection.querySelector('[data-action="tabs-minimize"]');
    if (tabsMinToggle) {
      tabsMinToggle.addEventListener('click', () => {
        const minimized = tabsSection.getAttribute('data-minimized') === 'true';
        tabsSection.setAttribute('data-minimized', minimized ? 'false' : 'true');
        tabsMinToggle.setAttribute('aria-pressed', minimized ? 'false' : 'true');
        tabsMinToggle.setAttribute('aria-label', minimized ? 'Minimize view tabs' : 'Expand view tabs');
        tabsMinToggle.setAttribute('title', minimized ? 'Minimize view tabs' : 'Expand view tabs');
        tabsMinToggle.textContent = minimized ? '«' : '»';
      });
    }
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      switchView(btn.dataset.view);
    });
  });

  document.querySelectorAll('.delta-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.delta-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      actions.setDeltaMode(btn.dataset.deltaMode);
      applyVisibility();
    });
  });

  document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(0.8));
  document.getElementById('btn-fit').addEventListener('click', fitFromButton);
  document.getElementById('btn-reset').addEventListener('click', resetView);

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    syncResponsiveRegions();
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

  document.getElementById('btn-animate').addEventListener('click', toggleFlowAnimation);
  const navigatorToggle = document.querySelector('[data-action="navigator-toggle"]');
  const inspectorToggle = document.querySelector('[data-action="inspector-toggle"]');
  navigatorToggle.addEventListener('click', () => toggleDrawer('navigator', navigatorToggle));
  inspectorToggle.addEventListener('click', () => toggleDrawer('inspector', inspectorToggle));
  document.querySelector('[data-action="navigator-close"]').addEventListener('click', () => setDrawerOpen('navigator', false));
  document.querySelector('[data-action="inspector-close"]').addEventListener('click', closeInspector);
  document.querySelector('[data-action="drawer-backdrop"]').addEventListener('click', closeActiveDrawer);
  document.querySelector('[data-region="minimap"]').addEventListener('mousedown', event => event.stopPropagation());
  document.querySelector('[data-region="minimap"]').addEventListener('click', handleMinimapClick);
  document.getElementById('btn-focus-neighbors').addEventListener('click', () => setFocusMode(FOCUS_MODES.NEIGHBORS));
  document.getElementById('btn-focus-affected').addEventListener('click', () => setFocusMode(FOCUS_MODES.AFFECTED));
  document.getElementById('btn-presentation').addEventListener('click', () => setPresentation(!state.presentation));
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    const enabled = Boolean(document.fullscreenElement);
    document.body.setAttribute('data-fullscreen', String(enabled));
    document.getElementById('btn-fullscreen').setAttribute('aria-pressed', String(enabled));
  });
  window.addEventListener('hashchange', () => {
    const notices = restoreUrlState();
    if (notices.length) announceStatus(notices.join(' '));
  });

  document.getElementById('search-box').addEventListener('input', e => {
    actions.setSearchQuery(e.target.value.toLowerCase().trim());
    renderSearchResults(state.searchQuery);
    applyVisibility();
  });

  document.querySelectorAll('.filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      actions.setFilter(chip.dataset.filter);
      applyVisibility();
      updateUrlState();
    });
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

  document.getElementById('btn-gate').addEventListener('click', toggleGatePanel);
  document.getElementById('gate-close').addEventListener('click', () => {
    document.getElementById('gate-panel').classList.remove('open');
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

  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (typing) {
    if (e.key === 'Escape' && activeDrawer) {
      closeActiveDrawer();
      return;
    }
    if (e.key === 'Escape') e.target.blur();
    return;
  }

  switch (e.key) {
    case 'Escape':
      if (state.presentation) { setPresentation(false); break; }
      if (document.fullscreenElement) { document.exitFullscreen?.(); break; }
      if (state.focusMode) { setFocusMode(state.focusMode); break; }
      deactivateScenario();
      closeActiveDrawer();
      closeModal();
      document.getElementById('gate-panel').classList.remove('open');
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
  if (viewName !== VIEWS.SEQUENCE) stopScenarioPlayback();
  if (viewName !== VIEWS.ARCHITECTURE) actions.setScenarioActive(false);
  actions.setView(viewName);
  document.getElementById('delta-bar').classList.toggle('visible', viewName === VIEWS.BEFORE_AFTER);
  document.getElementById('sequence-bar').classList.toggle('visible', viewName === VIEWS.SEQUENCE);
  document.getElementById('view-database-er').classList.toggle('active', viewName === VIEWS.DATABASE_ER);
  document.getElementById('view-implementation-plan').classList.toggle('active', viewName === VIEWS.IMPLEMENTATION_PLAN);
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
