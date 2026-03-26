// Service worker - notify all tabs when filters change so content scripts re-inject
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.consoleFilters) {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'filtersUpdated',
          filters: changes.consoleFilters.newValue || []
        }).catch(() => {}); // ignore tabs without content script
      });
    });
  }
});
