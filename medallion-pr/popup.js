const $ = (sel) => document.querySelector(sel);
const itemsContainer = $('#itemsContainer');
const addInput = $('#addInput');
const addTitleInput = $('#addTitleInput');
const btnAdd = $('#btnAdd');
const btnSync = $('#btnSync');
const btnAddNew = $('#btnAddNew');
const addRow = document.querySelector('.add-row');
const btnTheme = $('#btnTheme');
const iconMoon = $('#iconMoon');
const iconSun = $('#iconSun');
const toast = $('#toast');
const toastDot = $('#toastDot');
const toastText = $('#toastText');

let toastTimer = null;
const _esc = document.createElement('span');

document.addEventListener('DOMContentLoaded', () => {
  Promise.all([loadTheme(), renderItems()]);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.items) renderItems(changes.items.newValue);
});

// Event delegation for item actions (bound once, not per render)
itemsContainer.addEventListener('click', (e) => {
  const openBtn = e.target.closest('.btn-open');
  if (openBtn) {
    chrome.tabs.create({ url: openBtn.dataset.url });
    return;
  }
  const removeBtn = e.target.closest('.btn-remove');
  if (removeBtn) {
    chrome.runtime.sendMessage({ type: 'removeItem', id: removeBtn.dataset.id });
    return;
  }
  // Don't toggle on link clicks inside details
  if (e.target.closest('a')) return;
  const body = e.target.closest('.item-body');
  if (body) {
    body.closest('.item').classList.toggle('expanded');
  }
});

async function loadTheme() {
  const { theme } = await chrome.storage.local.get('theme');
  applyTheme(theme || 'dark');
}

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  iconMoon.style.display = theme === 'dark' ? '' : 'none';
  iconSun.style.display = theme === 'light' ? '' : 'none';
}

btnTheme.addEventListener('click', async () => {
  const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await chrome.storage.local.set({ theme: next });
});

async function renderItems(items) {
  if (!items) {
    const data = await chrome.storage.local.get('items');
    items = data.items || [];
  }

  if (items.length === 0) {
    itemsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
        </div>
        <div class="empty-state-text">No search queries yet.<br>Add one above to start tracking.</div>
      </div>`;
    return;
  }

  itemsContainer.innerHTML = items.map((item) => {
    const synced = item.lastChecked != null;
    const hasUnread = item.unreadCount > 0;
    const stateClass = hasUnread ? 'has-unread expanded' : synced ? 'is-clean' : '';
    const countsClass = hasUnread ? 'has-unread' : '';
    const countsText = item.totalCount != null ? `${item.unreadCount || 0}/${item.totalCount}` : '';
    const errorText = item.lastError ? `<span class="item-error truncate" title="${escapeHtml(item.lastError)}">${escapeHtml(item.lastError)}</span>` : '';
    const checkedText = item.lastChecked ? timeAgo(item.lastChecked) : '';
    const issuesUrl = `https://github.com/trymedallion/medallion/pulls?q=${encodeURIComponent(item.query)}`;
    const hasTitle = item.title && item.title.trim();

    const nodes = item.nodes || [];
    const detailsHtml = nodes.length ? nodes.map((n) => {
      const rd = n.reviewDecision;
      const isPR = n.__typename === 'PullRequest';
      let statusClass = 'pending';
      let statusLabel = '?';
      if (isPR && rd === 'APPROVED') { statusClass = 'approved'; statusLabel = '\u2713'; }
      else if (isPR && rd === 'CHANGES_REQUESTED') { statusClass = 'changes'; statusLabel = '\u2717'; }
      else if (isPR && rd === 'REVIEW_REQUIRED') { statusClass = 'pending'; statusLabel = '\u25CB'; }
      else if (!isPR) { statusClass = 'pending'; statusLabel = 'I'; }
      const unread = n.isReadByViewer === false;
      return `<div class="pr-row${unread ? ' pr-unread' : ''}">
        <div class="pr-status ${statusClass}${unread ? ' unread' : ''}">${statusLabel}</div>
        <div class="pr-title truncate"><a href="${escapeHtml(n.url)}" target="_blank">${escapeHtml(n.title)}</a></div>
        <span class="pr-number">#${n.number}</span>
      </div>`;
    }).join('') : '';

    return `
      <div class="item ${stateClass}" data-id="${item.id}">
        ${hasUnread ? '<div class="item-border-glow"></div>' : ''}
        <div class="item-indicator"></div>
        <div class="item-body">
          ${hasTitle ? `<div class="item-title truncate" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>` : ''}
          <div class="item-query truncate ${hasTitle ? '' : 'no-title'}" title="${escapeHtml(item.query)}">${escapeHtml(item.query)}</div>
          <div class="item-meta">
            ${countsText ? `<span class="item-counts ${countsClass}">${countsText}</span>` : ''}
            ${checkedText ? `<span>${checkedText}</span>` : ''}
            ${errorText}
          </div>
          ${detailsHtml ? `<div class="item-details">${detailsHtml}</div>` : ''}
        </div>
        <div class="item-actions">
          <button class="btn-icon btn-open" title="Open in GitHub" data-url="${escapeHtml(issuesUrl)}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 3H3v10h10v-3"/>
              <path d="M9 2h5v5"/>
              <path d="M14 2L7 9"/>
            </svg>
          </button>
          <button class="btn-icon btn-remove" title="Remove" data-id="${item.id}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
        </div>
      </div>`;
  }).join('');
}

btnAddNew.addEventListener('click', () => {
  addRow.classList.toggle('visible');
  if (addRow.classList.contains('visible')) {
    addTitleInput.focus();
  }
});

btnAdd.addEventListener('click', async () => {
  const q = addInput.value.trim();
  const t = addTitleInput.value.trim();
  if (q) {
    const response = await chrome.runtime.sendMessage({ type: 'addItem', query: q, title: t || null });
    if (response && response.error === 'duplicate') {
      showToast('Query already exists', 'red');
    } else {
      addInput.value = '';
      addTitleInput.value = '';
      addRow.classList.remove('visible');
    }
  }
});

addInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnAdd.click();
});

addTitleInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addInput.focus();
});

btnSync.addEventListener('click', async () => {
  btnSync.classList.add('syncing');
  btnSync.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'syncAll' });
    if (response && response.error) {
      showToast(escapeHtml(response.error), 'red');
    } else if (response) {
      const { totalFound, totalUnread } = response;
      showToast(`<span>${totalFound}</span> found, <span>${totalUnread}</span> unread`, totalUnread > 0 ? 'red' : 'green');
    }
  } catch {
    showToast('Sync failed', 'red');
  } finally {
    btnSync.classList.remove('syncing');
    btnSync.disabled = false;
  }
});

function showToast(html, color) {
  clearTimeout(toastTimer);
  toastDot.className = `toast-dot ${color}`;
  toastText.innerHTML = html;
  toast.classList.add('visible');
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

function escapeHtml(str) {
  _esc.textContent = str;
  return _esc.innerHTML;
}

function timeAgo(isoString) {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
