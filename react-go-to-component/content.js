// Bridge: MAIN world (inject.js) <-> service worker (background.js)
//
// Protocol (typed CustomEvents):
//   inject.js → content.js: '__react-goto:to-iso'  {type, reqId?, ...}
//   content.js → inject.js: '__react-goto:to-main' {type, reqId?, ...}
//
// Request/response: inject includes reqId; content replies with {type:'response', reqId, result}.

const PAGE_ORIGIN = window.location.origin;

// ── Validation ──

function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }
function isPositiveInt(v) { return Number.isInteger(v) && v > 0; }

function validateComponent(comp) {
  if (!comp || typeof comp !== 'object') return null;
  if (!isNonEmptyString(comp.fileName)) return null;
  if (!isPositiveInt(comp.line)) return null;
  if (comp.fileName.includes('..')) return null;
  return { fileName: comp.fileName, line: comp.line, col: Number(comp.col) || 0, name: comp.name || '' };
}

function validateReadSource(d) {
  if (!d || typeof d !== 'object') return null;
  if (!isNonEmptyString(d.file)) return null;
  if (!isPositiveInt(d.line)) return null;
  if (d.file.includes('..')) return null;
  const hints = Array.isArray(d.hints)
    ? d.hints.filter(h => typeof h === 'string' && h.length < 200)
    : [];
  return {
    file: d.file,
    line: d.line,
    context: Number(d.context) || 5,
    hints,
    origin: isNonEmptyString(d.origin) ? d.origin : '',
    projectRoot: isNonEmptyString(d.projectRoot) ? d.projectRoot : ''
  };
}

// ── Typed bridge ──

function sendToMain(msg) {
  document.dispatchEvent(new CustomEvent('__react-goto:to-main', { detail: msg }));
}

function respond(reqId, result) {
  sendToMain({ type: 'response', reqId, result });
}

document.addEventListener('__react-goto:to-iso', (e) => {
  const m = e.detail;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'open':
      handleOpen(m);
      break;
    case 'readSource':
      handleReadSource(m);
      break;
    case 'stateChange':
      handleStateChange(m);
      break;
  }
});

// ── Request handlers ──

function handleOpen(m) {
  if (!chrome.runtime?.id) { respond(m.reqId, { success: false, error: 'Extension context lost' }); return; }

  const comp = validateComponent(m.component);
  if (!comp) { respond(m.reqId, { success: false, error: 'Invalid component' }); return; }
  const projectRoot = isNonEmptyString(m.projectRoot) ? m.projectRoot : '';

  chrome.runtime.sendMessage({
    type: 'OPEN_COMPONENT',
    component: comp,
    projectRoot,
    origin: PAGE_ORIGIN
  }, (resp) => {
    respond(m.reqId, resp || { success: false, error: 'No response' });
  });
}

function handleReadSource(m) {
  if (!chrome.runtime?.id) { respond(m.reqId, { success: false, error: 'Extension context lost' }); return; }

  const data = validateReadSource(m);
  if (!data) { respond(m.reqId, { success: false, error: 'Invalid read-source request' }); return; }

  chrome.runtime.sendMessage({
    type: 'READ_SOURCE',
    file: data.file,
    line: data.line,
    context: data.context,
    hints: data.hints,
    origin: data.origin,
    projectRoot: data.projectRoot
  }, (resp) => {
    respond(m.reqId, resp || { success: false, error: 'No response' });
  });
}

function handleStateChange(m) {
  if (!chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ type: 'STATE_CHANGE', active: !!m.active });
}

// Clear any stale badge from a previous page's active picker.
if (chrome.runtime?.id) {
  chrome.runtime.sendMessage({ type: 'STATE_CHANGE', active: false });
}

// ── Settings (content → inject): push on load + on storage change ──

function pushSettings(settings) {
  sendToMain({ type: 'settings', settings });
}

function resolveForOrigin(s) {
  const cfg = s.originSettings?.[PAGE_ORIGIN] || {};
  return {
    projectRoot: cfg.projectRoot !== undefined ? cfg.projectRoot : s.projectRoot,
    editor: cfg.editor !== undefined ? cfg.editor : s.editor,
    skipDirs: cfg.skipDirs !== undefined ? cfg.skipDirs : s.skipDirs,
    shortcutKeys: s.shortcutKeys,
    showPreview: s.showPreview,
    disabled: Array.isArray(s.disabledOrigins) && s.disabledOrigins.includes(PAGE_ORIGIN)
  };
}

chrome.storage.local.get({
  projectRoot: '',
  editor: '/usr/local/bin/code',
  skipDirs: 'dumb_components, src/components/',
  shortcutKeys: ['Alt'],
  showPreview: true,
  originSettings: {},
  disabledOrigins: []
}, (s) => pushSettings(resolveForOrigin(s)));

chrome.storage.onChanged.addListener((changes) => {
  const updated = {};
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key === 'disabledOrigins') {
      updated.disabled = Array.isArray(newValue) && newValue.includes(PAGE_ORIGIN);
    } else if (key === 'originSettings') {
      const cfg = (newValue || {})[PAGE_ORIGIN] || {};
      if (cfg.projectRoot !== undefined) updated.projectRoot = cfg.projectRoot;
      if (cfg.editor !== undefined) updated.editor = cfg.editor;
      if (cfg.skipDirs !== undefined) updated.skipDirs = cfg.skipDirs;
    } else {
      updated[key] = newValue;
    }
  }
  if (Object.keys(updated).length) pushSettings(updated);
});

// ── background.js → inject.js (context-menu trigger) ──

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CONTEXT_MENU_GOTO') {
    sendToMain({ type: 'contextMenu' });
  }
});
