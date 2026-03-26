// Runs in ISOLATED world — has access to chrome.storage
// Communicates with inject.js (MAIN world) via custom DOM events

function sendFiltersToPage(filters) {
  window.dispatchEvent(new CustomEvent('__console-hacker-update', {
    detail: { filters }
  }));
}

// Load initial filters and send to page
chrome.storage.sync.get({ consoleFilters: [] }, (data) => {
  sendFiltersToPage(data.consoleFilters);
});

// Re-send when filters change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.consoleFilters) {
    sendFiltersToPage(changes.consoleFilters.newValue || []);
  }
});
