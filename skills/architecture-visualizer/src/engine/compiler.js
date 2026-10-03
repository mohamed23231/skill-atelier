const fs = require('node:fs');
const path = require('node:path');
const { validateArchitecture } = require('./validator.js');
const { computeLayout } = require('./layout.js');
const { exportToMermaid } = require('../utils/mermaid-exporter.js');
const { displayRepoPath } = require('../utils/repo-inspector.js');

const FILE_LOCATOR_KEYS = ['path', 'file', 'document'];

/**
 * Returns a copy of a spec or model whose file paths are safe to publish: an
 * absolute path is made repo-relative, or reduced to its file name when it is
 * outside the repository. API routes (`locator.path` on api evidence) are kept.
 */
function publishablePaths(source, repoRoot) {
  const copy = JSON.parse(JSON.stringify(source));
  (copy.evidence || []).forEach((record) => {
    if (!record || !record.locator || typeof record.locator !== 'object') return;
    FILE_LOCATOR_KEYS.forEach((key) => {
      if (key === 'path' && record.type === 'api') return;
      if (key in record.locator) record.locator[key] = displayRepoPath(repoRoot, record.locator[key]);
    });
  });
  (copy.nodes || []).forEach((node) => {
    if (!node || !node.details || !Array.isArray(node.details.files)) return;
    node.details.files = node.details.files.map((entry) => {
      if (typeof entry === 'string') return displayRepoPath(repoRoot, entry);
      if (entry && typeof entry === 'object') return { ...entry, path: displayRepoPath(repoRoot, entry.path) };
      return entry;
    });
  });
  return copy;
}

/**
 * Compiles an architecture spec into a self-contained interactive HTML file
 * and a companion Markdown architecture document.
 */
function compileArchitecture(spec, options = {}) {
  const validation = validateArchitecture(spec, {
    repoRoot: options.repoRoot,
    verifyFiles: options.verifyFiles,
  });

  if (options.strict) {
    const blocking = [...validation.errors];
    if (!validation.valid || blocking.length > 0) {
      throw new Error(`Architecture validation failed:\n- ${blocking.join('\n- ')}`);
    }
    if (validation.warnings.length > 0) {
      throw new Error(`Strict mode: ${validation.warnings.length} quality warning(s) must be resolved:\n- ${validation.warnings.join('\n- ')}`);
    }
  } else if (!validation.valid) {
    throw new Error(`Architecture validation failed:\n- ${validation.errors.join('\n- ')}`);
  }

  const repoRoot = options.repoRoot || process.cwd();
  const publishedSpec = publishablePaths(spec, repoRoot);
  const publishedValidation = {
    ...validation,
    model: validation.model ? publishablePaths(validation.model, repoRoot) : validation.model,
    review: validation.review
      ? { ...validation.review, evidenceManifest: publishablePaths({ evidence: validation.review.evidenceManifest || [] }, repoRoot).evidence }
      : validation.review,
  };
  const layout = computeLayout(publishedSpec, options.layoutOverrides);
  const mermaid = exportToMermaid(publishedSpec, { direction: layout.config.direction });
  const markdown = generateMarkdownReport(publishedSpec, publishedValidation, mermaid);
  const payload = {
    ...(publishedValidation.model || publishedSpec),
    findings: validation.findings || [],
    review: publishedValidation.review || null,
  };

  const templatePath = path.join(__dirname, 'template.html');
  const geometryPath = path.join(__dirname, 'geometry.js');
  let html = fs.readFileSync(templatePath, 'utf8');
  const geometryRuntime = fs.readFileSync(geometryPath, 'utf8');

  html = substitutePlaceholders(html, [
    ['__DOCUMENT_TITLE__', escapeHtml(spec.meta?.title || 'System Architecture')],
    ['/* __ARCHITECTURE_SPEC_DATA__ */ {}', embedJson(payload)],
    ['/* __COMPUTED_LAYOUT_DATA__ */ {}', embedJson(layout)],
    ['/* __MERMAID_DATA__ */ {}', embedJson(mermaid)],
    ['/* __MARKDOWN_DATA__ */ ""', embedJson(markdown)],
    ['/* __QUALITY_GATE_DATA__ */ []', embedJson(validation.gate)],
    ['/* __GEOMETRY_RUNTIME__ */', geometryRuntime],
  ]);

  if (options.outputHtml) {
    const outHtmlPath = path.resolve(options.outputHtml);
    fs.mkdirSync(path.dirname(outHtmlPath), { recursive: true });
    fs.writeFileSync(outHtmlPath, html, 'utf8');
  }

  if (options.outputMarkdown) {
    const outMdPath = path.resolve(options.outputMarkdown);
    fs.mkdirSync(path.dirname(outMdPath), { recursive: true });
    fs.writeFileSync(outMdPath, markdown, 'utf8');
  }

  return { html, markdown, validation, layout, mermaid };
}

/**
 * Literal (non-regex, non-$-expanding) single replacement.
 */
function replaceOnce(haystack, needle, replacement) {
  const index = haystack.indexOf(needle);
  if (index === -1) {
    throw new Error(`Template placeholder not found: ${needle}`);
  }
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

/**
 * Resolve every placeholder against the PRISTINE template, then splice from the
 * last offset backwards. Substituting left to right lets injected spec content
 * that happens to contain a later placeholder's literal text be rescanned and
 * replaced, which silently produces a broken page.
 */
function substitutePlaceholders(template, pairs) {
  const resolved = pairs.map(([needle, replacement]) => {
    const index = template.indexOf(needle);
    if (index === -1) throw new Error(`Template placeholder not found: ${needle}`);
    if (template.indexOf(needle, index + needle.length) !== -1) {
      throw new Error(`Template placeholder appears more than once: ${needle}`);
    }
    return { index, needle, replacement };
  });

  resolved.sort((a, b) => b.index - a.index);

  let out = template;
  resolved.forEach(({ index, needle, replacement }) => {
    out = out.slice(0, index) + replacement + out.slice(index + needle.length);
  });

  return out;
}

/**
 * JSON safe to inline inside a <script> block.
 */
function embedJson(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * A failure mode may be authored as a plain string or as
 * { failure, impact, mitigation }. Both render; neither prints "undefined".
 */
function normalizeFailureMode(entry) {
  if (typeof entry === 'string') return { failure: entry, impact: '', mitigation: '' };
  if (!entry || typeof entry !== 'object') return { failure: String(entry), impact: '', mitigation: '' };
  return {
    failure: entry.failure || entry.risk || entry.description || '',
    impact: entry.impact || '',
    mitigation: entry.mitigation || '',
  };
}

function generateMarkdownReport(spec, validation, mermaid) {
  const meta = spec.meta || {};
  const lines = [];

  lines.push(`# ${meta.title || 'Architecture Specification'}`);
  lines.push('');
  lines.push(`> **Status:** \`${meta.status || 'PROPOSED'}\` | **Date:** ${meta.date || new Date().toISOString().split('T')[0]} | **Author:** ${meta.author || 'Architect'}`);
  lines.push('');
  lines.push(`## 1. Executive Summary`);
  lines.push('');
  lines.push(meta.description || 'No summary provided.');
  lines.push('');

  if (Array.isArray(meta.assumptions) && meta.assumptions.length > 0) {
    lines.push(`### Assumptions`);
    meta.assumptions.forEach((a) => lines.push(`- ${a}`));
    lines.push('');
  }

  lines.push(`## 2. System Boundaries & Components`);
  lines.push('');
  const boundaryMap = new Map((spec.boundaries || []).map((b) => [b.id, b]));

  (spec.nodes || []).forEach((n) => {
    const boundary = boundaryMap.get(n.boundary);
    const bName = boundary ? boundary.label : 'General';
    const deltaBadge = n.delta && n.delta !== 'UNCHANGED' ? ` \`[${n.delta}]\`` : '';
    const statusBadge = `\`[${n.status || 'VERIFIED'}]\``;

    lines.push(`### ${n.label} ${statusBadge}${deltaBadge}`);
    lines.push(`- **Type:** \`${n.type}\` | **Boundary:** \`${bName}\` | **Technology:** \`${n.technology || 'N/A'}\``);
    if (n.description) lines.push(`- **Description:** ${n.description}`);

    if (n.details?.files?.length) {
      lines.push(`- **Repository Files:**`);
      n.details.files.forEach((f) => {
        const p = typeof f === 'string' ? f : f.path;
        lines.push(`  - \`${p}\``);
      });
    }

    if (n.details?.apis?.length) {
      lines.push(`- **APIs:**`);
      n.details.apis.forEach((a) => {
        lines.push(`  - \`${a.method || 'GET'} ${a.path}\`: ${a.desc || ''}`);
      });
    }

    if (n.details?.failureModes?.length) {
      lines.push(`- **Failure Modes & Mitigations:**`);
      n.details.failureModes.forEach((entry) => {
        const r = normalizeFailureMode(entry);
        const suffix = [r.impact ? `(Impact: *${r.impact}*)` : '', r.mitigation ? `-> Mitigation: ${r.mitigation}` : ''].filter(Boolean).join(' ');
        const headline = suffix ? `**${r.failure}**` : r.failure;
        lines.push(`  - ⚠️ ${headline}${suffix ? ` ${suffix}` : ''}`);
      });
    }

    lines.push('');
  });

  if (Array.isArray(meta.decisions) && meta.decisions.length > 0) {
    lines.push(`## 3. Architecture Decision Records (ADRs)`);
    lines.push('');
    meta.decisions.forEach((d, idx) => {
      lines.push(`### ${d.id || `ADR-${String(idx + 1).padStart(3, '0')}`}: ${d.title}`);
      lines.push(`- **Status:** \`${d.status || 'ACCEPTED'}\``);
      lines.push(`- **Context:** ${d.context}`);
      lines.push(`- **Decision:** ${d.decision}`);
      lines.push(`- **Consequences:** ${d.consequences}`);
      lines.push('');
    });
  }

  if (spec.views?.implementation_plan?.phases?.length) {
    lines.push(`## 4. Phased Implementation Plan`);
    lines.push('');
    spec.views.implementation_plan.phases.forEach((phase, pIdx) => {
      lines.push(`### Phase ${pIdx + 1}: ${phase.name}`);
      (phase.tasks || []).forEach((t) => {
        lines.push(`- [ ] **${t.title}** (\`${t.complexity || 'medium'}\` complexity)`);
        if (t.componentId) lines.push(`  - Target Component: \`${t.componentId}\``);
        if (t.files?.length) lines.push(`  - Files: \`${t.files.join(', ')}\``);
        if (t.risks?.length) lines.push(`  - Risks: ${t.risks.join('; ')}`);
      });
      lines.push('');
    });
  }

  lines.push(`## 5. Diagrams (Mermaid)`);
  lines.push('');
  if (mermaid.flowchart) {
    lines.push('### System Flowchart');
    lines.push('');
    lines.push('```mermaid');
    lines.push(mermaid.flowchart);
    lines.push('```');
    lines.push('');
  }
  if (mermaid.sequence) {
    lines.push('### Sequence');
    lines.push('');
    lines.push('```mermaid');
    lines.push(mermaid.sequence);
    lines.push('```');
    lines.push('');
  }
  if (mermaid.er) {
    lines.push('### Entity Relationships');
    lines.push('');
    lines.push('```mermaid');
    lines.push(mermaid.er);
    lines.push('```');
    lines.push('');
  }

  lines.push(`## 6. Quality Gate`);
  lines.push('');
  lines.push(`| # | Check | Result | Detail |`);
  lines.push(`| - | ----- | ------ | ------ |`);
  (validation.gate || []).forEach((g) => {
    const icon = g.status === 'PASS' ? '✅' : g.status === 'WARN' ? '⚠️' : '➖';
    lines.push(`| ${g.id} | ${g.name} | ${icon} ${g.status} | ${g.detail.replace(/\|/g, '\\|')} |`);
  });
  lines.push('');
  lines.push(
    `Grounding mode: \`${validation.stats.grounding}\` · Nodes: ${validation.stats.totalNodes} · Edges: ${validation.stats.totalEdges} · VERIFIED: ${validation.stats.verifiedCount} · INFERRED: ${validation.stats.inferredCount} · ASSUMED: ${validation.stats.assumedCount}`
  );
  lines.push('');

  appendReviewMarkdown(lines, validation);

  return lines.join('\n');
}

function displayText(value) {
  if (value == null) return '';
  return String(value);
}

function formatIdList(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 'none';
  return ids.map((id) => `\`${displayText(id)}\``).join(', ');
}

function appendReviewMarkdown(lines, validation) {
  const review = validation && validation.review;
  if (!review || typeof review !== 'object') return;

  const changed = Array.isArray(review.changedComponents) ? review.changedComponents : [];
  const blast = Array.isArray(review.blastRadius) ? review.blastRadius : [];
  const assumptions = Array.isArray(review.assumptions) ? review.assumptions : [];
  const questions = Array.isArray(review.unresolvedQuestions) ? review.unresolvedQuestions : [];
  const findings = Array.isArray(validation.findings) ? validation.findings : [];
  const evidence = Array.isArray(review.evidenceManifest) ? review.evidenceManifest : [];
  const trace = review.traceability && typeof review.traceability === 'object' ? review.traceability : null;
  const hasTrace = Boolean(trace && ((trace.changed && trace.changed.length) || (trace.mapped && trace.mapped.length) || (trace.gaps && trace.gaps.length)));

  if (!changed.length && !blast.length && !assumptions.length && !questions.length && !findings.length && !evidence.length && !hasTrace) {
    return;
  }

  lines.push('## 7. Review Summary');
  lines.push('');

  if (changed.length > 0) {
    lines.push('### Changed components');
    changed.forEach((entry) => {
      const id = displayText(entry && entry.id);
      if (!id) return;
      const delta = displayText(entry && entry.delta);
      const label = displayText(entry && entry.label);
      lines.push(`- \`${id}\`${delta ? ` \`${delta}\`` : ''}${label ? ` — ${label}` : ''}`);
    });
    lines.push('');
  }

  if (blast.length > 0) {
    lines.push('### Blast radius');
    blast.forEach((entry) => {
      const id = displayText(entry && entry.nodeId);
      if (!id) return;
      lines.push(`- \`${id}\` upstream: ${formatIdList(entry && entry.upstream)}; downstream: ${formatIdList(entry && entry.downstream)}`);
    });
    lines.push('');
  }

  if (assumptions.length > 0) {
    lines.push('### Assumptions');
    assumptions.forEach((entry) => {
      const text = displayText(entry && entry.text);
      if (!text) return;
      lines.push(`- ${text}`);
    });
    lines.push('');
  }

  if (questions.length > 0) {
    lines.push('### Unresolved questions');
    questions.forEach((entry) => {
      const text = displayText(entry && entry.text);
      if (!text) return;
      lines.push(`- ${text}`);
    });
    lines.push('');
  }

  if (findings.length > 0) {
    lines.push('### Findings');
    findings.forEach((finding) => {
      const policyId = displayText(finding && finding.policyId);
      const severity = displayText(finding && finding.severity);
      const message = displayText(finding && finding.message);
      if (!policyId && !message) return;
      const prefix = policyId ? `\`${policyId}\`${severity ? ` (${severity})` : ''}: ` : '';
      lines.push(`- ${prefix}${message}`);
    });
    lines.push('');
  }

  if (evidence.length > 0) {
    lines.push('### Evidence manifest');
    evidence.forEach((entry) => {
      const id = displayText(entry && entry.id);
      if (!id) return;
      const type = displayText(entry && entry.type);
      const verification = displayText(entry && entry.verification);
      const locator = entry && entry.locator && typeof entry.locator === 'object' ? entry.locator : {};
      const where = displayText(locator.path || locator.table || locator.apiPath || locator.assertion || locator.document || locator.command);
      lines.push(`- \`${id}\`${type ? ` ${type}` : ''}${where ? ` ${where}` : ''}${verification ? ` \`[${verification}]\`` : ''}`);
    });
    lines.push('');
  }

  if (hasTrace) {
    lines.push('### Implementation traceability');
    lines.push(`- Mapped: ${formatIdList(trace.mapped)}`);
    lines.push(`- Gaps: ${formatIdList(trace.gaps)}`);
    lines.push('');
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  normalizeFailureMode,
  substitutePlaceholders,
  compileArchitecture,
  generateMarkdownReport,
  embedJson,
};
