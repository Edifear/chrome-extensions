const $ = (sel) => document.querySelector(sel);

const KEY_LABELS = { Alt: 'Option', Control: 'Ctrl', Meta: 'Cmd', Shift: 'Shift' };

const DEFAULTS = {
  projectRoot: '',
  editor: '/usr/local/bin/code',
  skipDirs: 'dumb_components, src/components/',
  shortcutKeys: ['Alt'],
  showPreview: true
};

// ── Load ──

chrome.storage.local.get(DEFAULTS, (s) => {
  $('#project-root').value = s.projectRoot;
  $('#editor-path').value = s.editor;
  $('#skip-dirs').value = s.skipDirs;
  $('#show-preview').checked = s.showPreview;
  renderShortcutKeys(s.shortcutKeys);
});

// ── Auto-save text inputs with debounce ──

function bindInput(id, key, fallback) {
  let timer;
  $(id).addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const val = $(id).value.trim();
      chrome.storage.local.set({ [key]: fallback && !val ? fallback : val });
    }, 500);
  });
}

bindInput('#project-root', 'projectRoot');
bindInput('#editor-path', 'editor', DEFAULTS.editor);
bindInput('#skip-dirs', 'skipDirs');

// ── Toggle ──

$('#show-preview').addEventListener('change', () => {
  chrome.storage.local.set({ showPreview: $('#show-preview').checked });
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
  chrome.storage.local.get({ shortcutKeys: DEFAULTS.shortcutKeys }, (s) => {
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
