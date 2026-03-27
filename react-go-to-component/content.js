// Bridge: MAIN world (inject.js) <-> service worker (background.js)

// inject.js -> background.js (open in VS Code)
document.addEventListener('__react-goto-component', (e) => {
  if (!chrome.runtime?.id) return;

  chrome.runtime.sendMessage({
    type: 'OPEN_COMPONENT',
    component: e.detail.component,
    projectRoot: e.detail.projectRoot
  });
});

// inject.js -> background.js -> inject.js (read source preview)
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
