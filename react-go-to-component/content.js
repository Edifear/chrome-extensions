// Bridge: MAIN world (inject.js) <-> service worker (background.js)

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

// ── inject.js -> background.js (open in VS Code) ──

document.addEventListener('__react-goto-component', (e) => {
  if (!chrome.runtime?.id) return;

  chrome.runtime.sendMessage({
    type: 'OPEN_COMPONENT',
    component: e.detail.component,
    projectRoot: e.detail.projectRoot
  });
});

// ── inject.js -> background.js -> inject.js (read source preview) ──

document.addEventListener('__react-goto-read-source', (e) => {
  if (!chrome.runtime?.id) return;

  chrome.runtime.sendMessage({
    type: 'READ_SOURCE',
    file: e.detail.file,
    line: e.detail.line,
    context: e.detail.context,
    hints: e.detail.hints || []
  }, (resp) => {
    document.dispatchEvent(new CustomEvent('__react-goto-source-result', {
      detail: resp || { success: false, error: 'No response' }
    }));
  });
});
