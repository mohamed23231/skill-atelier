// Exports
function slugTitle() {
  return (ARCH_SPEC.meta?.title || 'architecture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function collectStyles() {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += rule.cssText + '\n';
    } catch (err) {
      /* cross-origin stylesheet, nothing to inline */
    }
  }
  return css;
}

function buildExportSvg() {
  const bounds = computeTotalVisualBounds();
  const padding = 60;
  const width = Math.ceil(bounds.maxX - bounds.minX + padding * 2);
  const height = Math.ceil(bounds.maxY - bounds.minY + padding * 2);

  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', width);
  clone.setAttribute('height', height);
  clone.setAttribute('viewBox', `${bounds.minX - padding} ${bounds.minY - padding} ${width} ${height}`);

  const clonedViewport = clone.querySelector('#viewport-group');
  if (clonedViewport) clonedViewport.setAttribute('transform', 'matrix(1 0 0 1 0 0)');
  clone.querySelectorAll('.hidden').forEach(node => node.remove());
  const ghost = clone.querySelector('#ghost-layer');
  if (ghost) ghost.innerHTML = '';

  const computed = getComputedStyle(document.body);
  const varNames = ['--bg-main', '--bg-panel', '--bg-elevated', '--border', '--text-main', '--text-muted', '--text-dim',
    '--accent-blue', '--accent-purple', '--accent-green', '--accent-amber', '--accent-rose', '--edge-sync', '--edge-async',
    '--border-node', '--badge-tint'];
  const varBlock = varNames
    .map(name => `${name}: ${computed.getPropertyValue(name).trim()};`)
    .filter(decl => !decl.endsWith(': ;'))
    .join(' ');

  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `svg { ${varBlock} background: ${computed.getPropertyValue('--bg-main').trim() || '#0b1120'}; }\n${collectStyles()}`;
  clone.insertBefore(style, clone.firstChild);

  return { markup: new XMLSerializer().serializeToString(clone), width, height };
}

function runExport(kind) {
  switch (kind) {
    case 'html':
      downloadBlob(new Blob([document.documentElement.outerHTML], { type: 'text/html' }), `${slugTitle()}.html`);
      break;
    case 'svg': {
      const { markup } = buildExportSvg();
      downloadBlob(new Blob([markup], { type: 'image/svg+xml' }), `${slugTitle()}.svg`);
      break;
    }
    case 'png':
      exportPng();
      break;
    case 'markdown':
      downloadBlob(new Blob([MARKDOWN_REPORT], { type: 'text/markdown' }), `${slugTitle()}.md`);
      break;
    case 'mermaid':
      openModal('Mermaid Source', [MERMAID_DATA.flowchart, MERMAID_DATA.sequence, MERMAID_DATA.er].filter(Boolean).join('\n\n%% ---\n\n'));
      break;
    default:
      break;
  }
}

function exportPng() {
  const { markup, width, height } = buildExportSvg();
  const scale = 2;
  const image = new Image();
  const svgBlob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(image, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob(blob => {
      if (blob) downloadBlob(blob, `${slugTitle()}.png`);
    }, 'image/png');
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    openModal('PNG export failed', 'The browser refused to rasterize the SVG. Use the SVG export instead.');
  };
  image.src = url;
}

function openModal(title, content) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-content').textContent = content;
  document.getElementById('modal').classList.add('open');
}

function closeModal() {
  document.getElementById('modal').classList.remove('open');
}

function copyModalContent() {
  const text = document.getElementById('modal-content').textContent;
  const btn = document.getElementById('modal-copy');
  const done = () => {
    btn.textContent = '✅ Copied';
    window.setTimeout(() => { btn.textContent = '📋 Copy'; }, 1500);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => { btn.textContent = 'Copy failed'; });
  } else {
    btn.textContent = 'Clipboard unavailable';
  }
}
