// DOM Elements
const svg = document.getElementById('arch-svg');
const viewport = document.getElementById('viewport-group');
const boundariesLayer = document.getElementById('boundaries-layer');
const edgesLayer = document.getElementById('edges-layer');
const particlesLayer = document.getElementById('particles-layer');
const nodesLayer = document.getElementById('nodes-layer');
const ghostLayer = document.getElementById('ghost-layer');
const inspector = document.getElementById('inspector');
const container = document.getElementById('canvas-container');
const SVG_NS = 'http://www.w3.org/2000/svg';

const nodeById = new Map((LAYOUT_DATA.nodes || []).map(n => [n.id, n]));
const edgeById = new Map((LAYOUT_DATA.edges || []).map(e => [e.id, e]));
const boundaryById = new Map((LAYOUT_DATA.boundaries || []).map(b => [b.id, b]));
const isLRLayout = LAYOUT_DATA.config?.direction !== 'TB';

function normalizeFailureMode(entry) {

  if (typeof entry === 'string') return { failure: entry, impact: '', mitigation: '' };

  if (!entry || typeof entry !== 'object') return { failure: String(entry), impact: '', mitigation: '' };

  return {

    failure: entry.failure || entry.risk || entry.description || '',

    impact: entry.impact || '',

    mitigation: entry.mitigation || ''

  };

}


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
  return node;
}

// Text measuring for SVG labels, which never wrap on their own.
let textMeasure = null;
function cssToken(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}
function measureText(text, font) {
  if (!textMeasure) textMeasure = document.createElement('canvas').getContext('2d');
  textMeasure.font = font;
  return textMeasure.measureText(text).width;
}
// Break text into at most maxLines lines of maxWidth; the last line ends with an ellipsis when text remains.
function wrapText(text, font, maxWidth, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const candidate = line ? `${line} ${words[i]}` : words[i];
    if (measureText(candidate, font) <= maxWidth || !line) {
      line = candidate;
      continue;
    }
    if (lines.length === maxLines - 1) {
      // No line left to break onto: the rest joins the last line, which is ellipsized below.
      line = [line, ...words.slice(i)].join(' ');
      break;
    }
    lines.push(line);
    line = words[i];
  }
  if (line) lines.push(line);
  const last = lines.length - 1;
  for (let index = 0; index <= last; index++) {
    if (measureText(lines[index], font) <= maxWidth) continue;
    let cut = lines[index];
    while (cut.length > 1 && measureText(`${cut}…`, font) > maxWidth) cut = cut.slice(0, -1).trimEnd();
    lines[index] = `${cut}…`;
  }
  return lines;
}
function fitText(text, font, maxWidth) {
  return wrapText(text, font, maxWidth, 1)[0] || '';
}

// Inline icon markup from the shared sprite; decorative, so it is hidden from assistive technology.
function iconMarkup(id, className = 'icon') {
  return `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true"><use href="#${id}"></use></svg>`;
}

// Replace a button's content with an icon and an optional text label.
function setIconLabel(target, iconId, text) {
  target.innerHTML = iconMarkup(iconId) + (text ? `<span>${escapeHtml(text)}</span>` : '');
}

function withTooltip(parent, text) {
  if (!text) return parent;
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = text;
  parent.appendChild(title);
  return parent;
}

// "1 step", "2 steps": every count the page prints goes through this, so any model reads correctly.
function plural(count, word, many) {
  return `${count} ${count === 1 ? word : many || `${word}s`}`;
}
