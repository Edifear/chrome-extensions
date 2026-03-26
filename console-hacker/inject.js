// Runs in MAIN world — has direct access to page's console object

(function() {
  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  let filters = [];

  function shouldFilter(args) {
    if (filters.length === 0) return false;
    const message = Array.from(args).map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a); }
      catch { return String(a); }
    }).join(' ').toLowerCase();
    return filters.some(f => message.includes(f.toLowerCase()));
  }

  console.log = function(...args) {
    if (!shouldFilter(args)) originalConsole.log(...args);
  };
  console.warn = function(...args) {
    if (!shouldFilter(args)) originalConsole.warn(...args);
  };
  console.error = function(...args) {
    if (!shouldFilter(args)) originalConsole.error(...args);
  };

  // Listen for filter updates from content.js (ISOLATED world)
  window.addEventListener('__console-hacker-update', (e) => {
    filters = e.detail.filters || [];
  });
})();
