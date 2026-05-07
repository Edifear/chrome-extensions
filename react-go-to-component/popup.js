const $ = (sel) => document.querySelector(sel);

const NATIVE_HOST = 'com.react_goto_component.open_in_editor';
const KEY_LABELS = { Alt: 'Option', Control: 'Ctrl', Meta: 'Cmd', Shift: 'Shift' };

const ORIGIN_DEFAULTS = {
  projectRoot: '',
  editor: '/usr/local/bin/code',
  skipDirs: 'dumb_components, src/components/',
  autoDetectRoot: false
};

const GLOBAL_DEFAULTS = {
  shortcutKeys: ['Alt'],
  showPreview: true,
  disabledOrigins: []
};

let currentOrigin = null;

// ── Determine current tab origin ──

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  let origin = null;
  try { if (tab?.url) origin = new URL(tab.url).origin; } catch {}
  if (origin && /^https?:/.test(origin)) {
    currentOrigin = origin;
    $('#page-origin').textContent = origin.replace(/^https?:\/\//, '');
    $('#page-section-header').style.display = '';
    $('#page-toggle-row').style.display = '';
    $('#page-settings').style.display = '';
  } else {
    $('#no-origin-hint').style.display = '';
  }
  loadAll();
});

// ── Load ──

function loadAll() {
  chrome.storage.local.get({
    ...GLOBAL_DEFAULTS,
    originSettings: {},
    // Legacy flat fields (used as migration defaults for new origins)
    projectRoot: undefined,
    editor: undefined,
    skipDirs: undefined
  }, (s) => {
    $('#show-preview').checked = s.showPreview;
    renderShortcutKeys(s.shortcutKeys);

    if (!currentOrigin) return;

    const cfg = s.originSettings[currentOrigin] || {
      projectRoot: s.projectRoot ?? ORIGIN_DEFAULTS.projectRoot,
      editor: s.editor ?? ORIGIN_DEFAULTS.editor,
      skipDirs: s.skipDirs ?? ORIGIN_DEFAULTS.skipDirs
    };
    $('#project-root').value = cfg.projectRoot || '';
    $('#editor-path').value = cfg.editor || '';
    $('#skip-dirs').value = cfg.skipDirs || '';
    $('#page-enabled').checked = !s.disabledOrigins.includes(currentOrigin);

    const autoDetect = !!cfg.autoDetectRoot;
    $('#auto-detect-root').checked = autoDetect;
    $('#project-root').disabled = autoDetect;
    if (autoDetect) detectAndApplyRoot();
  });
}

// ── Auto-detect project root via native host ──

function setStatus(text, kind) {
  const el = $('#auto-detect-status');
  if (!text) { el.style.display = 'none'; return; }
  el.textContent = text;
  el.className = 'status-hint ' + (kind || 'info');
  el.style.display = '';
}

function detectAndApplyRoot() {
  if (!currentOrigin) return;
  let port;
  try {
    const u = new URL(currentOrigin);
    port = parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80);
  } catch {
    setStatus('Could not parse origin', 'error');
    return;
  }
  setStatus(`Detecting from port ${port}…`, 'info');
  chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'detect_root', port }, (resp) => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, 'error');
      return;
    }
    if (resp?.success && resp.projectRoot) {
      $('#project-root').value = resp.projectRoot;
      saveOriginField('projectRoot', resp.projectRoot);
      setStatus(resp.projectRoot, 'success');
    } else {
      setStatus(resp?.error || 'Detection failed', 'error');
    }
  });
}

$('#auto-detect-root').addEventListener('change', () => {
  const on = $('#auto-detect-root').checked;
  saveOriginField('autoDetectRoot', on);
  $('#project-root').disabled = on;
  if (on) {
    detectAndApplyRoot();
  } else {
    setStatus(null);
  }
});

// ── Save per-origin fields with debounce ──

function saveOriginField(field, value) {
  if (!currentOrigin) return;
  chrome.storage.local.get({ originSettings: {} }, ({ originSettings }) => {
    const cfg = { ...(originSettings[currentOrigin] || {}) };
    cfg[field] = value;
    originSettings[currentOrigin] = cfg;
    chrome.storage.local.set({ originSettings });
  });
}

function bindOriginInput(id, field) {
  let timer;
  $(id).addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      saveOriginField(field, $(id).value.trim());
    }, 500);
  });
}

bindOriginInput('#project-root', 'projectRoot');
bindOriginInput('#editor-path', 'editor');
bindOriginInput('#skip-dirs', 'skipDirs');

// ── Global toggles ──

$('#show-preview').addEventListener('change', () => {
  chrome.storage.local.set({ showPreview: $('#show-preview').checked });
});

// ── Per-page enable toggle ──

$('#page-enabled').addEventListener('change', () => {
  if (!currentOrigin) return;
  const enabled = $('#page-enabled').checked;
  chrome.storage.local.get({ disabledOrigins: [] }, ({ disabledOrigins }) => {
    const set = new Set(disabledOrigins);
    if (enabled) set.delete(currentOrigin); else set.add(currentOrigin);
    chrome.storage.local.set({ disabledOrigins: [...set] });
  });
});

// ── Shortcut recorder ──

const display = $('#shortcut-display');
let recording = false;

display.addEventListener('click', () => {
  recording = true;
  display.classList.add('recording');
  display.innerHTML = '<span class="placeholder">Press keys...</span>';
});

display.addEventListener('keydown', (e) => {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  const keys = [];
  if (e.metaKey) keys.push('Meta');
  if (e.ctrlKey) keys.push('Control');
  if (e.altKey) keys.push('Alt');
  if (e.shiftKey) keys.push('Shift');
  if (!['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) {
    keys.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  }
  if (!keys.length) return;

  recording = false;
  display.classList.remove('recording');
  renderShortcutKeys(keys);
  chrome.storage.local.set({ shortcutKeys: keys });
});

display.addEventListener('blur', () => {
  if (!recording) return;
  recording = false;
  display.classList.remove('recording');
  chrome.storage.local.get({ shortcutKeys: GLOBAL_DEFAULTS.shortcutKeys }, (s) => {
    renderShortcutKeys(s.shortcutKeys);
  });
});

// ── Helpers ──

function renderShortcutKeys(keys) {
  display.innerHTML = keys.map((k, i) => {
    const lbl = KEY_LABELS[k] || k;
    const html = `<span class="shortcut-key">${lbl}</span>`;
    return i < keys.length - 1 ? html + '<span class="shortcut-plus">+</span>' : html;
  }).join('');

  $('#shortcut-hint').textContent = keys.map(k => KEY_LABELS[k] || k).join(' + ');
}
