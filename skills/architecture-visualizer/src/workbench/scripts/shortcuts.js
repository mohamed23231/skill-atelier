let shortcutsOpener = null;
let shortcutsOpenState = false;

function openShortcuts(opener) {
  const scrim = document.getElementById('shortcuts-scrim');
  const dialog = document.getElementById('shortcuts-dialog');
  if (!scrim || !dialog) return;
  shortcutsOpener = opener || document.activeElement;
  shortcutsOpenState = true;
  scrim.removeAttribute('hidden');
  scrim.setAttribute('data-open', 'true');
  scrim.classList.add('open');
  dialog.focus();
}

function closeShortcuts(restoreFocus = true) {
  const scrim = document.getElementById('shortcuts-scrim');
  if (!scrim) return;
  shortcutsOpenState = false;
  scrim.setAttribute('hidden', '');
  scrim.setAttribute('data-open', 'false');
  scrim.classList.remove('open');
  if (restoreFocus && shortcutsOpener && typeof shortcutsOpener.focus === 'function') shortcutsOpener.focus();
}

function toggleShortcuts(opener) {
  if (shortcutsOpenState) closeShortcuts(true);
  else openShortcuts(opener);
}

function shortcutsHandleKeyDown(event) {
  event.stopPropagation();
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeShortcuts(true);
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    document.getElementById('shortcuts-dialog')?.focus();
  }
}

function shortcutsInit() {
  const scrim = document.getElementById('shortcuts-scrim');
  const dialog = document.getElementById('shortcuts-dialog');
  if (!scrim || !dialog || typeof scrim.addEventListener !== 'function') return;
  scrim.addEventListener('click', event => {
    if (event.target === scrim) closeShortcuts(true);
  });
  dialog.addEventListener('keydown', shortcutsHandleKeyDown);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  if (typeof document !== 'undefined' && document.readyState === 'loading') window.addEventListener('DOMContentLoaded', shortcutsInit);
  else shortcutsInit();
}
