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

function withTooltip(parent, text) {
  if (!text) return parent;
  const title = document.createElementNS(SVG_NS, 'title');
  title.textContent = text;
  parent.appendChild(title);
  return parent;
}
