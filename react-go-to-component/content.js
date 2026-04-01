// Bridge: MAIN world (inject.js) <-> service worker (background.js)

// ── Validation: sanitize CustomEvent data from MAIN world ──

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

function validateComponent(comp) {
  if (!comp || typeof comp !== 'object') return null;
  if (!isNonEmptyString(comp.fileName)) return null;
  if (!isPositiveInt(comp.line)) return null;
  // Reject path traversal
  if (comp.fileName.includes('..')) return null;
  return { fileName: comp.fileName, line: comp.line, col: Number(comp.col) || 0, name: comp.name || '' };
}

function validateReadSource(d) {
  if (!d || typeof d !== 'object') return null;
  if (!isNonEmptyString(d.file)) return null;
  if (!isPositiveInt(d.line)) return null;
  if (d.file.includes('..')) return null;
  // Sanitize hints: only allow short strings
  const hints = Array.isArray(d.hints)
    ? d.hints.filter(h => typeof h === 'string' && h.length < 200)
    : [];
  return {
    file: d.file,
    line: d.line,
    context: Number(d.context) || 5,
    hints,
    origin: isNonEmptyString(d.origin) ? d.origin : '',
    projectRoot: isNonEmptyString(d.projectRoot) ? d.projectRoot : '',
    reqId: d.reqId
  };
}

// ── Settings: push to MAIN world on load and on change ──

function pushSettings(settings) {
  document.dispatchEvent(new CustomEvent('__react-goto-settings', {
    detail: settings
  }));
}

chrome.storage.local.get({
  projectRoot: '',
  shortcutKeys: ['Alt'],
  showPreview: true,
  skipDirs: 'dumb_components, src/components/'
}, pushSettings);

chrome.storage.onChanged.addListener((changes) => {
  const updated = {};
  for (const [key, { newValue }] of Object.entries(changes)) {
    updated[key] = newValue;
  }
  pushSettings(updated);
});

// ── background.js -> inject.js (context menu) ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CONTEXT_MENU_GOTO') {
    document.dispatchEvent(new CustomEvent('__react-goto-context-menu'));
  }
});

// ── inject.js -> background.js (open in VS Code) ──

document.addEventListener('__react-goto-component', (e) => {
  if (!chrome.runtime?.id) return;

  const comp = validateComponent(e.detail?.component);
  if (!comp) return;
  const projectRoot = isNonEmptyString(e.detail?.projectRoot) ? e.detail.projectRoot : '';

  chrome.runtime.sendMessage({
    type: 'OPEN_COMPONENT',
    component: comp,
    projectRoot
  }, (resp) => {
    document.dispatchEvent(new CustomEvent('__react-goto-open-result', {
      detail: resp || { success: false }
    }));
  });
});

// ── inject.js -> background.js -> inject.js (read source preview) ──

document.addEventListener('__react-goto-read-source', (e) => {
  if (!chrome.runtime?.id) return;

  const data = validateReadSource(e.detail);
  if (!data) return;

  chrome.runtime.sendMessage({
    type: 'READ_SOURCE',
    file: data.file,
    line: data.line,
    context: data.context,
    hints: data.hints,
    origin: data.origin,
    projectRoot: data.projectRoot
  }, (resp) => {
    const result = resp || { success: false, error: 'No response' };
    if (data.reqId !== undefined) result.reqId = data.reqId;
    document.dispatchEvent(new CustomEvent('__react-goto-source-result', {
      detail: result
    }));
  });
});
