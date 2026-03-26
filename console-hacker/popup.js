const tabs = document.querySelectorAll('.tab');
const contents = document.querySelectorAll('.tab-content');
const input = document.getElementById('filter-input');
const addBtn = document.getElementById('add-btn');
const list = document.getElementById('filters-list');
const countEl = document.getElementById('filter-count');

// Tab switching
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    contents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

function renderFilters(filters) {
  list.innerHTML = '';
  if (filters.length === 0) {
    list.innerHTML = '<div class="empty-state">No filters yet. Add a string to filter from console.</div>';
    countEl.textContent = '';
    return;
  }
  countEl.textContent = `${filters.length} filter${filters.length === 1 ? '' : 's'} active`;
  filters.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'filter-item';
    li.innerHTML = `<span>"${f}"</span><button data-index="${i}" title="Remove">&times;</button>`;
    list.appendChild(li);
  });
}

function loadFilters() {
  chrome.storage.sync.get({ consoleFilters: [] }, (data) => {
    renderFilters(data.consoleFilters);
  });
}

function addFilter() {
  const value = input.value.trim();
  if (!value) return;
  chrome.storage.sync.get({ consoleFilters: [] }, (data) => {
    const filters = data.consoleFilters;
    if (filters.includes(value)) {
      input.value = '';
      return;
    }
    filters.push(value);
    chrome.storage.sync.set({ consoleFilters: filters }, () => {
      input.value = '';
      renderFilters(filters);
    });
  });
}

function removeFilter(index) {
  chrome.storage.sync.get({ consoleFilters: [] }, (data) => {
    const filters = data.consoleFilters;
    filters.splice(index, 1);
    chrome.storage.sync.set({ consoleFilters: filters }, () => {
      renderFilters(filters);
    });
  });
}

addBtn.addEventListener('click', addFilter);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFilter();
});

list.addEventListener('click', (e) => {
  if (e.target.tagName === 'BUTTON') {
    removeFilter(parseInt(e.target.dataset.index));
  }
});

loadFilters();
