// Lens encoding changes marks, never visibility or spotlight state.
function applyLens() {
  const encoding = lensEncoding(state.lens, ARCH_SPEC);
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const group = document.getElementById(`node-${node.id}`);
    const mark = encoding.nodes[node.id];
    if (!group || !mark) return;
    group.dataset.lensStroke = mark.stroke;
    group.dataset.lensStyle = mark.strokeStyle;
    if (mark.fill) group.dataset.lensFill = mark.fill;
    else group.removeAttribute('data-lens-fill');
    group.toggleAttribute('data-lens-muted', mark.mutedText);
    group.toggleAttribute('data-lens-strike', mark.strike);
    renderNodeLensDetails(group, node, mark.badge, mark.marker);
  });
  (LAYOUT_DATA.edges || []).forEach(edge => {
    const path = document.getElementById(`path-${edge.id}`);
    const mark = encoding.edges[edge.id];
    if (!path || !mark) return;
    path.dataset.lensStroke = mark.stroke;
    path.dataset.lensStyle = mark.strokeStyle;
  });
  ghostLayer.querySelectorAll('.policy-ghost').forEach(item => item.remove());
  encoding.ghosts.forEach(ghost => {
    const from = nodeById.get(ghost.from);
    const to = nodeById.get(ghost.to);
    if (!from || !to) return;
    const x1 = from.x + from.width / 2, y1 = from.y + from.height / 2;
    const x2 = to.x + to.width / 2, y2 = to.y + to.height / 2;
    const group = el('g', { class: 'policy-ghost', 'data-policy-id': ghost.policyId });
    group.appendChild(el('line', {
      class: 'policy-ghost-line', x1, y1, x2, y2,
      'data-lens-stroke': ghost.label === 'Forbidden · absent' ? 'risk' : 'warn'
    }));
    const label = el('g', { class: 'edge-label' });
    const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
    const width = estimateLabelWidth(ghost.label);
    label.appendChild(el('rect', { class: 'edge-label-bg', x: x - width / 2, y: y - 9, width, height: 18 }));
    const text = el('text', { class: 'edge-label-text', x, y });
    text.textContent = ghost.label;
    label.appendChild(text);
    group.appendChild(label);
    ghostLayer.appendChild(group);
  });
  renderLensKey(encoding.keyItems);
}

function renderLensKey(items) {
  const key = document.querySelector('.lens-key');
  if (!key) return;
  const signature = JSON.stringify([state.lens, state.currentView, items]);
  if (key.dataset.encoding === signature) return;
  key.dataset.encoding = signature;
  key.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = state.lens.charAt(0).toUpperCase() + state.lens.slice(1);
  key.appendChild(title);
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'lens-key-row';
    const swatch = document.createElement('span');
    swatch.className = 'lens-key-swatch';
    swatch.dataset.lensStroke = item.stroke;
    swatch.dataset.lensStyle = item.strokeStyle;
    swatch.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = item.label;
    row.append(swatch, label);
    key.appendChild(row);
  });
  if (state.lens === 'structure') {
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'Data flow only';
    toggle.setAttribute('aria-pressed', String(state.currentView === VIEWS.DATA_FLOW));
    toggle.addEventListener('click', () => {
      switchView(state.currentView === VIEWS.DATA_FLOW ? VIEWS.ARCHITECTURE : VIEWS.DATA_FLOW);
    });
    key.appendChild(toggle);
  }
}
