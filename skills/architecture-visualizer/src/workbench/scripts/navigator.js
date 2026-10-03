function renderSearchResults(query) {
  const target = document.querySelector('[data-navigator-section="search"]');
  if (!target) return;
  target.replaceChildren();
  if (!query) {
    target.textContent = 'Type in search to find nodes and relationships.';
    return;
  }
  const matches = [];
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const text = `${node.label || ''} ${node.id || ''} ${node.type || ''} ${node.technology || ''}`.toLowerCase();
    if (text.includes(query)) matches.push({ kind: 'node', id: node.id, label: node.label || node.id });
  });
  (LAYOUT_DATA.edges || []).forEach(edge => {
    const text = `${edge.label || ''} ${edge.packetLabel || ''} ${edge.id || ''} ${edge.source || ''} ${edge.target || ''}`.toLowerCase();
    if (text.includes(query)) matches.push({ kind: 'edge', id: edge.id, label: edge.label || edge.packetLabel || edge.id });
  });
  if (matches.length === 0) {
    target.textContent = 'No matching components or relationships.';
    return;
  }
  matches.forEach(match => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workbench-search-result';
    button.setAttribute('data-search-result', '');
    button.setAttribute('data-model-id', match.id);
    button.setAttribute('data-model-kind', match.kind);
    button.textContent = `${match.kind === 'node' ? 'Component' : 'Relationship'} · ${match.label}`;
    const activateResult = () => {
      if (match.kind === 'node') openInspectorForNode(match.id);
      else openInspectorForEdge(match.id);
    };
    button.addEventListener('click', activateResult);
    button.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateResult();
      }
    });
    target.appendChild(button);
  });
}

function renderNavigatorOutline() {
  const target = document.querySelector('[data-navigator-section="outline"]');
  if (!target) return;
  target.replaceChildren();
  (LAYOUT_DATA.nodes || []).forEach(node => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workbench-outline-item';
    button.textContent = node.label || node.id;
    button.addEventListener('click', () => openInspectorForNode(node.id));
    target.appendChild(button);
  });
}
