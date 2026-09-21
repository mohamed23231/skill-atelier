/**
 * Converts an Architecture Spec into clean Mermaid diagram code
 * Supporting C4/System Flowcharts, Sequence Diagrams, and ER Diagrams.
 */

function exportToMermaid(spec, options = {}) {
  const result = {
    flowchart: generateMermaidFlowchart(spec, options.direction),
    sequence: spec.views?.sequence ? generateMermaidSequence(spec.views.sequence, spec) : null,
    er: spec.views?.database_er ? generateMermaidER(spec.views.database_er) : null
  };
  return result;
}

function generateMermaidFlowchart(spec, direction) {
  const lines = [`flowchart ${direction === 'TB' ? 'TB' : 'LR'}`];

  // Boundaries as subgraphs
  const boundaryMap = new Map();
  (spec.boundaries || []).forEach(b => {
    boundaryMap.set(b.id, { ...b, nodes: [] });
  });

  const unassigned = [];
  (spec.nodes || []).forEach(n => {
    if (n.boundary && boundaryMap.has(n.boundary)) {
      boundaryMap.get(n.boundary).nodes.push(n);
    } else {
      unassigned.push(n);
    }
  });

  boundaryMap.forEach(b => {
    if (b.nodes.length === 0) return;
    const safeId = sanitizeId(b.id);
    lines.push(`  subgraph ${safeId}["${escapeQuotes(b.label)}"]`);
    b.nodes.forEach(n => {
      lines.push(`    ${renderMermaidNode(n)}`);
    });
    lines.push('  end');
  });

  unassigned.forEach(n => {
    lines.push(`  ${renderMermaidNode(n)}`);
  });

  // Edges
  (spec.edges || []).forEach(e => {
    const s = sanitizeId(e.source);
    const t = sanitizeId(e.target);
    const label = escapeQuotes(e.label || e.packetLabel || '');
    const arrow = e.communication === 'async' ? '-.->' : '-->';
    if (label) {
      lines.push(`  ${s} ${arrow}|"${label}"| ${t}`);
    } else {
      lines.push(`  ${s} ${arrow} ${t}`);
    }
  });

  // Delta classes so the exported diagram keeps the before/after semantics
  const deltaClasses = {
    ADDED: 'classDef added fill:#064e3b,stroke:#10b981,color:#ecfdf5;',
    CHANGED: 'classDef changed fill:#451a03,stroke:#f59e0b,color:#fffbeb;',
    REMOVED: 'classDef removed fill:#4c0519,stroke:#f43f5e,color:#fff1f2,stroke-dasharray: 4 3;'
  };
  const byDelta = { ADDED: [], CHANGED: [], REMOVED: [] };
  (spec.nodes || []).forEach(n => {
    if (byDelta[n.delta]) byDelta[n.delta].push(sanitizeId(n.id));
  });
  Object.entries(byDelta).forEach(([delta, ids]) => {
    if (ids.length === 0) return;
    lines.push(`  ${deltaClasses[delta]}`);
    lines.push(`  class ${ids.join(',')} ${delta.toLowerCase()};`);
  });

  return lines.join('\n');
}

function renderMermaidNode(node) {
  const safeId = sanitizeId(node.id);
  const label = escapeQuotes(node.label);
  const tech = node.technology ? `<br/><i>[${escapeQuotes(node.technology)}]</i>` : '';
  const statusBadge = node.status ? ` [${node.status}]` : '';

  switch (node.type) {
    case 'database':
    case 'storage':
      return `${safeId}[("${label}${tech}")]`;
    case 'queue':
    case 'topic':
      return `${safeId}>"${label}${tech}"]`;
    case 'actor':
      return `${safeId}(["${label}${statusBadge}"])`;
    default:
      return `${safeId}["${label}${tech}"]`;
  }
}

function generateMermaidSequence(sequenceView, spec) {
  const lines = ['sequenceDiagram', '  autonumber'];

  // Participants
  const participants = new Set();
  (sequenceView.steps || []).forEach(st => {
    participants.add(st.from);
    participants.add(st.to);
  });

  const nodeMap = new Map((spec.nodes || []).map(n => [n.id, n]));

  participants.forEach(id => {
    const node = nodeMap.get(id);
    const label = node ? node.label : id;
    lines.push(`  participant ${sanitizeId(id)} as ${escapeQuotes(label)}`);
  });

  // Steps
  (sequenceView.steps || []).forEach(st => {
    const from = sanitizeId(st.from);
    const to = sanitizeId(st.to);
    const arrow = st.sync ? '->>' : '-->>';
    const label = escapeQuotes(st.label || 'call');
    lines.push(`  ${from}${arrow}${to}: ${label}`);
    if (st.note) {
      lines.push(`  Note over ${to}: ${escapeQuotes(st.note)}`);
    }
  });

  return lines.join('\n');
}

function generateMermaidER(er) {
  const lines = ['erDiagram'];

  (er.tables || []).forEach(t => {
    lines.push(`  ${sanitizeId(t.name)} {`);
    (t.columns || []).forEach(c => {
      const type = (c.type || 'varchar').replace(/\s+/g, '_');
      const key = c.pk ? 'PK' : (c.fk ? 'FK' : '');
      lines.push(`    ${type} ${sanitizeId(c.name)}${key ? ` ${key}` : ''}`);
    });
    lines.push('  }');
  });

  (er.relations || []).forEach(r => {
    const from = sanitizeId(r.from);
    const to = sanitizeId(r.to);
    const relSym = r.type === '1:1' ? '||--||' : (r.type === 'N:M' ? '}o--o{' : '||--o{');
    const label = escapeQuotes(r.label || 'references');
    lines.push(`  ${from} ${relSym} ${to} : "${label}"`);
  });

  return lines.join('\n');
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeQuotes(str) {
  return String(str || '').replace(/"/g, "'").replace(/\n/g, ' ');
}

module.exports = {
  exportToMermaid,
  generateMermaidFlowchart,
  generateMermaidSequence,
  generateMermaidER
};
