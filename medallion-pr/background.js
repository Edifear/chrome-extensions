const REPO = 'trymedallion/medallion';
const GRAPHQL_URL = 'https://api.github.com/graphql';
const ALARM_NAME = 'medallion-pr-sync';
const SEARCH_QUERY = `
  query($q: String!) {
    search(query: $q, type: ISSUE, first: 50) {
      issueCount
      nodes {
        ... on Issue { number isReadByViewer }
        ... on PullRequest { number isReadByViewer }
      }
    }
  }
`;

chrome.runtime.onInstalled.addListener(async () => {
  await loadEnvToken();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
  syncAll();
});

async function loadEnvToken() {
  try {
    const res = await fetch(chrome.runtime.getURL('.env'));
    if (!res.ok) return;
    const text = await res.text();
    const match = text.match(/^GITHUB_DEV_TOKEN=(.+)$/m);
    if (match) {
      await chrome.storage.local.set({ ghToken: match[1].trim() });
    }
  } catch {
    // .env not present
  }
}

chrome.alarms.get(ALARM_NAME, (alarm) => {
  if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) syncAll();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'syncAll') {
    syncAll().then(sendResponse);
    return true;
  }
  if (msg.type === 'addItem') {
    addItem(msg.query, msg.title).then(sendResponse);
    return true;
  }
  if (msg.type === 'removeItem') {
    removeItem(msg.id).then(sendResponse);
    return true;
  }
});

// Single writer for item mutations to avoid storage races
async function addItem(query, title) {
  if (!query) return { error: 'Empty query' };
  const { items = [] } = await chrome.storage.local.get('items');
  if (items.some((i) => i.query === query)) return { error: 'duplicate' };
  items.push({
    id: crypto.randomUUID().slice(0, 8),
    query,
    title: title || null,
    totalCount: null,
    unreadCount: 0,
    lastChecked: null,
    lastError: null,
  });
  await chrome.storage.local.set({ items });
  return { ok: true };
}

async function removeItem(id) {
  const { items = [] } = await chrome.storage.local.get('items');
  const updated = items.filter((i) => i.id !== id);
  await chrome.storage.local.set({ items: updated });
  updateBadge(updated);
  return { ok: true };
}

async function syncAll() {
  const { ghToken, items } = await chrome.storage.local.get(['ghToken', 'items']);

  if (!items || items.length === 0) {
    return { totalFound: 0, totalUnread: 0 };
  }

  if (!ghToken) {
    // Only write if items don't already have this error
    if (!items.every((i) => i.lastError === 'No token configured')) {
      const updated = items.map((item) => ({ ...item, lastError: 'No token configured' }));
      await chrome.storage.local.set({ items: updated });
      updateBadge(updated);
    }
    return { error: 'No token configured' };
  }

  let totalFound = 0;
  let totalUnread = 0;

  const updated = await Promise.all(items.map(async (item) => {
    try {
      const result = await fetchSearch(ghToken, item.query);
      const unreadCount = result.nodes.filter((n) => n.isReadByViewer === false).length;
      const itemTotalCount = result.issueCount;
      totalFound += itemTotalCount;
      totalUnread += unreadCount;
      return {
        ...item,
        totalCount: itemTotalCount,
        unreadCount,
        lastChecked: new Date().toISOString(),
        lastError: null,
      };
    } catch (err) {
      return {
        ...item,
        lastError: err.message,
        lastChecked: new Date().toISOString(),
      };
    }
  }));

  // Skip write if nothing changed
  const changed = updated.some((u, i) =>
    u.unreadCount !== items[i].unreadCount ||
    u.totalCount !== items[i].totalCount ||
    u.lastError !== items[i].lastError
  );
  if (changed) {
    await chrome.storage.local.set({ items: updated });
    updateBadge(updated);
  }

  return { totalFound, totalUnread };
}

// Split queries with "(A OR B)" into separate calls — GitHub search API
// doesn't support parenthesized OR grouping with qualifiers.
async function fetchSearch(token, query) {
  const orMatch = query.match(/^(.*?)\((.+?)\s+OR\s+(.+?)\)(.*)$/i);
  if (orMatch) {
    const [, prefix, left, right, suffix] = orMatch;
    const q1 = (prefix + left + suffix).replace(/\s+/g, ' ').trim();
    const q2 = (prefix + right + suffix).replace(/\s+/g, ' ').trim();
    const [r1, r2] = await Promise.all([
      fetchSearchSingle(token, q1),
      fetchSearchSingle(token, q2),
    ]);
    const seen = new Set();
    const merged = [];
    for (const node of [...r1.nodes, ...r2.nodes]) {
      if (!seen.has(node.number)) {
        seen.add(node.number);
        merged.push(node);
      }
    }
    return { issueCount: merged.length, nodes: merged };
  }
  return fetchSearchSingle(token, query);
}

async function fetchSearchSingle(token, query) {
  const fullQuery = `repo:${REPO} ${query}`;
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { q: fullQuery } }),
  });

  if (res.status === 401) throw new Error('Invalid token');

  if (res.status === 403) {
    const resetHeader = res.headers.get('X-RateLimit-Reset');
    if (resetHeader) {
      const resetDate = new Date(parseInt(resetHeader) * 1000);
      throw new Error(`Rate limited until ${resetDate.toLocaleTimeString()}`);
    }
    throw new Error('Forbidden');
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const json = await res.json();
  if (json.errors && json.errors.length > 0) throw new Error(json.errors[0].message);
  return json.data.search;
}

function updateBadge(items) {
  const count = items.filter((i) => i.unreadCount > 0).length;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#ff6b6b' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}
