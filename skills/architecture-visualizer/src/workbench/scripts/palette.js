// Copies the link to this exact view; the header button and the palette share it.
function copyCurrentLink() {
  updateUrlState();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(location.href)
      .then(() => announceStatus('Link copied.'))
      .catch(() => announceStatus('Copy failed; the link is in the address bar.'));
  } else {
    announceStatus('Copy failed; the link is in the address bar.');
  }
}

// Command Palette
const PALETTE_GROUPS = ['Commands', 'Views', 'Chapters', 'Components', 'Connections', 'Scenario stages', 'Export'];

let paletteOpener = null;
let paletteCurrentItems = [];
let paletteActiveIndex = 0;
let paletteIsOpen = false;

function paletteBuildAllItems() {
  const items = [];

  // 1. Commands
  const commands = [
    {
      id: 'cmd-fit',
      group: 'Commands',
      label: 'Fit diagram',
      hint: 'F',
      icon: 'ui-fit',
      run: () => fitFromButton()
    },
    {
      id: 'cmd-reset',
      group: 'Commands',
      label: 'Reset view',
      hint: '0',
      icon: 'ui-reset',
      run: () => resetView()
    },
    {
      id: 'cmd-presentation',
      group: 'Commands',
      label: 'Presentation mode',
      hint: 'Command',
      icon: 'ui-play',
      run: () => setPresentation(!state.presentation)
    },
    {
      id: 'cmd-fullscreen',
      group: 'Commands',
      label: 'Fullscreen',
      hint: 'Command',
      icon: 'ui-collapse',
      run: () => toggleFullscreen()
    },
    {
      id: 'cmd-animate',
      group: 'Commands',
      label: 'Animate data flow',
      hint: 'A',
      icon: 'ui-play',
      run: () => toggleFlowAnimation()
    },
    {
      id: 'cmd-theme',
      group: 'Commands',
      label: 'Switch theme',
      hint: 'Command',
      icon: state.theme === THEMES.DARK ? 'ui-sun' : 'ui-moon',
      run: () => toggleTheme()
    },
    {
      id: 'cmd-gate',
      group: 'Commands',
      label: 'Quality gate',
      hint: 'Command',
      icon: 'ui-check-circle',
      run: () => toggleGatePanel()
    },
    {
      id: 'cmd-copy-link',
      group: 'Commands',
      label: 'Copy link',
      hint: 'Command',
      icon: 'ui-copy',
      run: () => copyCurrentLink()
    }
  ];

  if (state.selectedNodeId) {
    commands.push(
      {
        id: 'cmd-focus-neighbors',
        group: 'Commands',
        label: 'Show neighbours',
        hint: 'Focus',
        icon: 'ui-link',
        run: () => setFocusMode(FOCUS_MODES.NEIGHBORS)
      },
      {
        id: 'cmd-focus-affected',
        group: 'Commands',
        label: 'Show blast radius',
        hint: 'Impact',
        icon: 'ui-alert',
        run: () => setFocusMode(FOCUS_MODES.AFFECTED)
      }
    );
  }
  items.push(...commands);

  // 2. Views
  const views = [
    {
      id: 'view-architecture',
      group: 'Views',
      label: 'Architecture',
      hint: 'View',
      icon: 'ui-architecture',
      run: () => switchView(VIEWS.ARCHITECTURE)
    },
    {
      id: 'view-before_after',
      group: 'Views',
      label: 'Before vs After',
      hint: 'Delta · View',
      icon: 'ui-delta',
      run: () => switchView(VIEWS.BEFORE_AFTER)
    },
    {
      id: 'view-data_flow',
      group: 'Views',
      label: 'Data Flow',
      hint: 'View',
      icon: 'ui-flow',
      run: () => switchView(VIEWS.DATA_FLOW)
    },
    {
      id: 'view-sequence',
      group: 'Views',
      label: 'Sequence Flow',
      hint: 'Sequence · View',
      icon: 'ui-sequence',
      run: () => switchView(VIEWS.SEQUENCE)
    }
  ];
  items.push(...views);

  // 3. Chapters
  if (typeof availableChapters === 'function') {
    const chapters = availableChapters().map(ch => ({
      id: `chapter-${ch.id}`,
      group: 'Chapters',
      label: ch.label,
      hint: 'Chapter',
      icon: ch.id === 'data' ? 'ui-table' : (ch.id === 'plan' ? 'ui-sequence' : 'ui-file'),
      run: () => openChapter(ch.id)
    }));
    items.push(...chapters);
  }

  // 3. Components
  (LAYOUT_DATA.nodes || []).forEach(node => {
    items.push({
      id: `node-${node.id}`,
      modelId: node.id,
      group: 'Components',
      label: node.label || node.id,
      hint: node.technology || node.type || 'Component',
      icon: getNodeIcon(node.type || node),
      run: () => openInspectorForNode(node.id)
    });
  });

  // 4. Connections
  (LAYOUT_DATA.edges || []).forEach(edge => {
    const sourceNode = nodeById.get(edge.source);
    const targetNode = nodeById.get(edge.target);
    const sourceLabel = sourceNode?.label || edge.source;
    const targetLabel = targetNode?.label || edge.target;
    const edgeLabel = edge.label || edge.packetLabel || '';
    const label = `${sourceLabel} → ${targetLabel}${edgeLabel ? ` · ${edgeLabel}` : ''}`;
    const hint = edge.communication || edge.pathType || 'Connection';
    items.push({
      id: `edge-${edge.id}`,
      modelId: edge.id,
      group: 'Connections',
      label,
      hint,
      icon: 'ui-link',
      run: () => openInspectorForEdge(edge.id)
    });
  });

  // 5. Scenario stages
  (ARCH_SPEC.scenarios || []).forEach(scenario => {
    const stages = flattenScenarioStages(scenario.stages);
    stages.forEach((stage, i) => {
      const stageTitle = stage.name || stage.label || stage.id || `Stage ${i + 1}`;
      items.push({
        id: `stage-${scenario.id}-${stage.id || i}`,
        group: 'Scenario stages',
        label: stageTitle,
        hint: scenario.name || scenario.id,
        keywords: stage.id || '',
        icon: 'ui-sequence',
        run: () => {
          selectScenario(scenario.id);
          actions.setScenarioStage(i);
          renderScenarioStage();
        }
      });
    });
  });

  // 6. Export
  const exports = [
    {
      id: 'export-html',
      group: 'Export',
      label: 'Export Standalone HTML',
      hint: 'Export',
      icon: 'ui-export',
      run: () => runExport('html')
    },
    {
      id: 'export-svg',
      group: 'Export',
      label: 'Export SVG vector',
      hint: 'Export',
      icon: 'ui-export',
      run: () => runExport('svg')
    },
    {
      id: 'export-png',
      group: 'Export',
      label: 'Export PNG image',
      hint: 'Export',
      icon: 'ui-export',
      run: () => runExport('png')
    },
    {
      id: 'export-markdown',
      group: 'Export',
      label: 'Export Markdown report',
      hint: 'Export',
      icon: 'ui-export',
      run: () => runExport('markdown')
    },
    {
      id: 'export-mermaid',
      group: 'Export',
      label: 'Export Mermaid source',
      hint: 'Export',
      icon: 'ui-export',
      run: () => runExport('mermaid')
    }
  ];
  items.push(...exports);

  return items;
}

function paletteFilter(rawQuery) {
  const allItems = paletteBuildAllItems();
  const q = (rawQuery || '').trim().toLowerCase();

  if (!q) {
    const allowed = new Set(['Commands', 'Views', 'Chapters', 'Components']);
    paletteCurrentItems = allItems.filter(item => allowed.has(item.group)).slice(0, 50);
  } else {
    const tokens = q.split(/\s+/).filter(Boolean);
    const matched = [];

    for (const item of allItems) {
      const haystack = `${item.label} ${item.hint || ''} ${item.group} ${item.id} ${item.modelId || ''} ${item.keywords || ''}`.toLowerCase();
      if (!tokens.every(token => haystack.includes(token))) continue;

      const lowerLabel = item.label.toLowerCase();
      let tier = 2;
      if (lowerLabel.startsWith(q)) {
        tier = 0;
      } else if (lowerLabel.includes(q)) {
        tier = 1;
      }
      const groupIdx = PALETTE_GROUPS.indexOf(item.group);
      matched.push({ item, tier, groupIdx });
    }

    matched.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      if (a.groupIdx !== b.groupIdx) return a.groupIdx - b.groupIdx;
      return 0;
    });

    paletteCurrentItems = matched.map(m => m.item).slice(0, 50);
  }

  paletteActiveIndex = 0;
  paletteRenderList();
}

function paletteRenderList() {
  const list = document.getElementById('palette-list');
  const input = document.getElementById('palette-input');
  if (!list || !input) return;

  list.replaceChildren();

  if (paletteCurrentItems.length === 0) {
    paletteActiveIndex = -1;
    input.removeAttribute('aria-activedescendant');
    const emptyRow = document.createElement('div');
    emptyRow.className = 'palette-empty';
    emptyRow.textContent = 'No matches';
    list.appendChild(emptyRow);
    return;
  }

  if (paletteActiveIndex < 0 || paletteActiveIndex >= paletteCurrentItems.length) {
    paletteActiveIndex = 0;
  }

  input.setAttribute('aria-activedescendant', `palette-opt-${paletteActiveIndex}`);

  paletteCurrentItems.forEach((item, index) => {
    const row = document.createElement('div');
    row.id = `palette-opt-${index}`;
    row.className = `palette-row${index === paletteActiveIndex ? ' active' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', index === paletteActiveIndex ? 'true' : 'false');
    if (item.modelId) {
      row.setAttribute('data-model-id', item.modelId);
      row.setAttribute('data-model-kind', item.group === 'Components' ? 'node' : 'edge');
    }
    row.setAttribute('data-index', String(index));

    const iconSpan = document.createElement('span');
    iconSpan.className = 'palette-row-icon';
    iconSpan.innerHTML = iconMarkup(item.icon);

    const labelSpan = document.createElement('span');
    labelSpan.className = 'palette-row-label';
    labelSpan.textContent = item.label;

    const hintSpan = document.createElement('span');
    hintSpan.className = 'palette-row-hint';
    hintSpan.textContent = item.hint || '';

    row.appendChild(iconSpan);
    row.appendChild(labelSpan);
    row.appendChild(hintSpan);

    row.addEventListener('click', () => {
      paletteRunItem(item);
    });

    row.addEventListener('mouseenter', () => {
      paletteSetActive(index);
    });

    list.appendChild(row);
  });
}

function paletteSetActive(index) {
  if (paletteCurrentItems.length === 0) return;
  paletteActiveIndex = Math.max(0, Math.min(index, paletteCurrentItems.length - 1));
  const input = document.getElementById('palette-input');
  if (input) {
    input.setAttribute('aria-activedescendant', `palette-opt-${paletteActiveIndex}`);
  }
  const rows = document.querySelectorAll('#palette-list .palette-row');
  rows.forEach((row, i) => {
    const isAct = i === paletteActiveIndex;
    row.setAttribute('aria-selected', isAct ? 'true' : 'false');
    row.classList.toggle('active', isAct);
    if (isAct) {
      row.scrollIntoView({ block: 'nearest' });
    }
  });
}

function paletteMoveActive(delta) {
  if (paletteCurrentItems.length === 0) return;
  const count = paletteCurrentItems.length;
  const newIndex = (paletteActiveIndex + delta + count) % count;
  paletteSetActive(newIndex);
}

function paletteRunActive() {
  if (paletteCurrentItems.length === 0 || paletteActiveIndex < 0 || paletteActiveIndex >= paletteCurrentItems.length) {
    return;
  }
  paletteRunItem(paletteCurrentItems[paletteActiveIndex]);
}

function paletteRunItem(item) {
  const returnTarget = paletteOpener;
  closePalette(false);
  item.run();
  if (!document.activeElement || document.activeElement === document.body || document.getElementById('palette-dialog')?.contains(document.activeElement)) {
    if (returnTarget && typeof returnTarget.focus === 'function') {
      returnTarget.focus();
    }
  }
}

function openPalette(opener) {
  const scrim = document.getElementById('palette-scrim');
  const input = document.getElementById('palette-input');
  if (!scrim || !input) return;

  paletteOpener = (opener && opener !== input) ? opener : document.activeElement;
  paletteIsOpen = true;

  scrim.removeAttribute('hidden');
  scrim.setAttribute('data-open', 'true');
  scrim.classList.add('open');

  input.value = '';
  paletteFilter('');

  input.focus();
  input.select();
}

function closePalette(restoreFocus = true) {
  const scrim = document.getElementById('palette-scrim');
  if (!scrim) return;

  paletteIsOpen = false;
  scrim.setAttribute('hidden', '');
  scrim.setAttribute('data-open', 'false');
  scrim.classList.remove('open');

  const target = paletteOpener;
  if (restoreFocus && target && typeof target.focus === 'function') {
    target.focus();
  }
}

function togglePalette(opener) {
  if (paletteIsOpen) {
    closePalette(true);
  } else {
    openPalette(opener);
  }
}

function paletteHandleKeyDown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK')) {
    e.preventDefault();
    e.stopPropagation();
    closePalette(true);
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePalette(true);
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteMoveActive(1);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteMoveActive(-1);
    return;
  }
  if (e.key === 'Home') {
    e.preventDefault();
    paletteSetActive(0);
    return;
  }
  if (e.key === 'End') {
    e.preventDefault();
    paletteSetActive(paletteCurrentItems.length - 1);
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    paletteRunActive();
    return;
  }
}

function paletteInit() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function' || typeof document.getElementById !== 'function') {
    return;
  }
  const kbd = document.querySelector('#btn-palette kbd');
  if (kbd) {
    const isMac = Boolean(typeof navigator !== 'undefined' && (navigator.platform || '').includes('Mac'));
    kbd.textContent = isMac ? '⌘K' : 'Ctrl K';
  }
  const scrim = document.getElementById('palette-scrim');
  const dialog = document.getElementById('palette-dialog');
  const input = document.getElementById('palette-input');

  if (scrim) {
    scrim.addEventListener('click', e => {
      if (e.target === scrim) {
        closePalette(true);
      }
    });
  }
  if (dialog) {
    dialog.addEventListener('keydown', paletteHandleKeyDown);
  }
  if (input) {
    input.addEventListener('input', () => {
      paletteFilter(input.value);
    });
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', paletteInit);
  } else {
    paletteInit();
  }
}
