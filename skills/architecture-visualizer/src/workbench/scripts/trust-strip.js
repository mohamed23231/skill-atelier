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
  if (isOverlayPanels()) setDrawerOpen('rail', true, opener);
  else if (document.querySelector('[data-region="rail"]')?.getAttribute('data-open') !== 'true') setDrawerOpen('rail', true, opener);
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
    label.textContent = entry.label;
    pill.append(dot, label);
    pill.addEventListener('click', () => openTrustChapter(entry.chapter, pill));
    target.appendChild(pill);
  });
}
