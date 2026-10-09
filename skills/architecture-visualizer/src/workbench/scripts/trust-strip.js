// Trust strip: four pills under the header that say whether to believe this document. Every number
// comes from trustSummary (the validator's embedded output); each pill opens the chapter that explains it.
const TRUST_PILLS = [
  { key: 'grounding', name: 'Grounding' },
  { key: 'evidence', name: 'Evidence' },
  { key: 'rules', name: 'Rules' },
  { key: 'openItems', name: 'Open items' }
];

function openTrustChapter(chapter, opener) {
  openChapter(chapter);
  setDrawerOpen('rail', true);
  if (opener?.closest('[data-chapter-panel]')?.hidden) {
    document.getElementById(`chapter-tab-${state.chapter}`)?.focus();
  }
}

function renderTrustStrip() {
  const target = document.querySelector('[data-trust-pills]');
  if (!target) return;
  const summary = trustSummary(ARCH_SPEC, QUALITY_GATE);
  target.replaceChildren();
  TRUST_PILLS.forEach(({ key, name }) => {
    const entry = summary[key];
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'trust-pill';
    pill.setAttribute('data-trust', key);
    pill.setAttribute('data-state', entry.state);
    if (key === 'grounding' && entry.label === 'Illustrative') pill.setAttribute('data-illustrative', 'true');
    const description = `${name}: ${entry.label}.${entry.detail ? ` ${entry.detail}` : ''}`;
    pill.title = description;
    pill.setAttribute('aria-label', description);
    const dot = document.createElement('span');
    dot.className = 'trust-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    const text = entry.label === 'Illustrative' ? 'Illustrative example' : entry.label;
    const match = text.match(/\b\d+(?:\/\d+)?\b/);
    const lead = match ? match[0] : text.split(' ')[0];
    const offset = match ? match.index : 0;
    label.append(text.slice(0, offset));
    const strong = document.createElement('strong');
    strong.textContent = lead;
    label.append(strong, text.slice(offset + lead.length));
    pill.append(dot, label);
    pill.addEventListener('click', () => openTrustChapter(entry.chapter, pill));
    target.appendChild(pill);
  });
}
