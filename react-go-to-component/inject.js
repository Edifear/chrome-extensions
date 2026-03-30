// ── Configuration (overridden by chrome.storage via content.js) ──
let PROJECT_ROOT = '';
let SHORTCUT_KEYS = ['Alt'];
let SHOW_PREVIEW = true;
let SKIP_DIRS = ['node_modules'];

document.addEventListener('__react-goto-settings', (e) => {
  const s = e.detail;
  if (s.projectRoot !== undefined) PROJECT_ROOT = s.projectRoot;
  if (s.shortcutKeys !== undefined) SHORTCUT_KEYS = s.shortcutKeys;
  if (s.showPreview !== undefined) {
    SHOW_PREVIEW = s.showPreview;
    codePreview.style.display = SHOW_PREVIEW ? '' : 'none';
  }
  if (s.skipDirs !== undefined) {
    const extra = s.skipDirs.split(',').map(d => d.trim()).filter(Boolean);
    SKIP_DIRS = ['node_modules', ...extra];
  }
});

// ── Fiber Walking ──

function getFiber(element) {
  const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
  return key ? element[key] : null;
}

function getElementHints(element) {
  const hints = [];
  // Direct text content (not children's text)
  const directText = Array.from(element.childNodes)
    .filter(n => n.nodeType === 3)
    .map(n => n.textContent.trim())
    .filter(Boolean)
    .join(' ');
  if (directText && directText.length < 80) hints.push(directText);
  // Short textContent as fallback
  const text = element.textContent?.trim();
  if (text && text.length < 40 && text !== directText) hints.push(text);
  // Tag name
  if (element.tagName) hints.push(element.tagName.toLowerCase());
  // Class names (individual)
  if (element.className && typeof element.className === 'string') {
    element.className.split(/\s+/).filter(Boolean).forEach(c => hints.push(c));
  }
  // Key attributes
  for (const attr of ['id', 'name', 'href', 'src', 'alt', 'placeholder', 'aria-label', 'data-testid']) {
    const val = element.getAttribute?.(attr);
    if (val) hints.push(val);
  }
  return hints;
}

function getNearestComponent(element) {
  // Walk up the DOM until we find an element with a React fiber
  let el = element;
  let fiber = null;
  while (el && el !== document.documentElement) {
    fiber = getFiber(el);
    if (fiber) break;
    el = el.parentElement;
  }
  if (!fiber) return null;

  const hints = getElementHints(element);

  // Step 1: Find the best source location from the element's own fiber chain.
  // Host fibers (div, span, etc.) have _debugSource pointing to where the
  // element is WRITTEN in source — more precise than the component's _debugSource
  // which points to where the component is USED.
  let elementSource = null;
  let current = fiber;
  while (current) {
    if (current._debugSource) {
      const src = current._debugSource.fileName;
      if (!SKIP_DIRS.some(d => src.includes(d))) {
        elementSource = {
          fileName: src.replace(/^\/app\//, '/'),
          line: current._debugSource.lineNumber,
          col: current._debugSource.columnNumber
        };
        break;
      }
    }
    current = current.return;
  }

  // Step 2: Walk up to find the nearest user component for the name
  let componentName = 'Anonymous';
  let componentFiber = null;
  current = fiber;
  while (current) {
    if (typeof current.type === 'function') {
      const name = current.type.displayName || current.type.name;
      if (name && current._debugSource && !SKIP_DIRS.some(d => current._debugSource.fileName.includes(d))) {
        componentName = name;
        componentFiber = current;
        break;
      }
    }
    current = current.return;
  }

  if (!elementSource && !componentFiber) return null;

  // Prefer the element's own source (more precise), fall back to component's
  const source = elementSource || {
    fileName: componentFiber._debugSource.fileName.replace(/^\/app\//, '/'),
    line: componentFiber._debugSource.lineNumber,
    col: componentFiber._debugSource.columnNumber
  };

  return {
    name: componentName,
    fileName: source.fileName,
    line: source.line,
    col: source.col,
    fiber: componentFiber || fiber,
    hoveredElement: element,
    hints
  };
}

// ── Overlay (CSS Anchor Positioning) ──

const ANCHOR_NAME = '--react-goto-target';
let prevAnchor = null;

// Inject styles for anchor positioning
const style = document.createElement('style');
style.textContent = `
  ._react-goto-highlight {
    position: fixed;
    position-anchor: ${ANCHOR_NAME};
    inset: anchor(top) anchor(right) anchor(bottom) anchor(left);
    pointer-events: none;
    z-index: 2147483647;
    background: rgba(97, 218, 251, 0.15);
    border: 2px solid rgba(97, 218, 251, 0.8);
    border-radius: 4px;
  }
  ._react-goto-tooltip {
    position: fixed;
    position-anchor: ${ANCHOR_NAME};
    position-area: top left;
    position-try-fallbacks: flip-block;
    pointer-events: none;
    z-index: 2147483647;
    max-width: 500px;
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 4px;
  }
  ._react-goto-label {
    padding: 4px 8px;
    background: rgba(97, 218, 251, 0.95);
    color: #1a1a2e;
    font: bold 11px/16px -apple-system, sans-serif;
    white-space: nowrap;
  }
  ._react-goto-code {
    margin: 0;
    padding: 6px 8px;
    background: rgba(30, 30, 46, 0.95);
    color: #cdd6f4;
    font: 10px/14px 'SF Mono', 'JetBrains Mono', monospace;
    white-space: pre;
    overflow: hidden;
    max-height: 112px;
  }
  ._react-goto-code-line--target {
    background: rgba(97, 218, 251, 0.2);
    margin: 0 -8px;
    padding: 0 8px;
  }
  ._react-goto-code-num {
    color: #585b70;
    user-select: none;
    display: inline-block;
    width: 3ch;
    text-align: right;
    margin-right: 1ch;
  }
`;

const highlight = document.createElement('div');
highlight.className = '_react-goto-highlight';

const tooltip = document.createElement('div');
tooltip.className = '_react-goto-tooltip';

const label = document.createElement('div');
label.className = '_react-goto-label';

const codePreview = document.createElement('pre');
codePreview.className = '_react-goto-code';

tooltip.appendChild(label);
tooltip.appendChild(codePreview);

let sourceRequestId = 0;

function setAnchor(element) {
  if (prevAnchor) prevAnchor.style.anchorName = '';
  element.style.anchorName = ANCHOR_NAME;
  prevAnchor = element;
}

function clearAnchor() {
  if (prevAnchor) prevAnchor.style.anchorName = '';
  prevAnchor = null;
}

function showOverlay(comp) {
  if (!comp.hoveredElement) { hideOverlay(); return; }

  setAnchor(comp.hoveredElement);

  const shortFile = comp.fileName.split('/').pop();
  label.textContent = `${comp.name}  ·  ${shortFile}:${comp.line}`;

  highlight.style.display = '';
  tooltip.style.display = '';

  if (!SHOW_PREVIEW) {
    codePreview.style.display = 'none';
    return;
  }
  codePreview.style.display = '';

  // Request original source from disk with hints for precise matching
  const reqId = ++sourceRequestId;
  document.dispatchEvent(new CustomEvent('__react-goto-read-source', {
    detail: {
      file: `${PROJECT_ROOT}${comp.fileName}`,
      line: comp.line,
      context: 4,
      hints: comp.hints || []
    }
  }));

  // Listen for response (one-shot)
  const handler = (e) => {
    document.removeEventListener('__react-goto-source-result', handler);
    if (reqId !== sourceRequestId) return;
    const resp = e.detail;
    if (!resp?.success) {
      codePreview.textContent = resp?.error || 'Failed to read source';
      return;
    }

    comp.matchedLine = resp.targetLine;
    label.textContent = `${comp.name}  ·  ${shortFile}:${resp.targetLine}`;

    codePreview.innerHTML = '';
    resp.lines.forEach(l => {
      const line = document.createElement('div');
      if (l.num === resp.targetLine) line.className = '_react-goto-code-line--target';
      const numSpan = document.createElement('span');
      numSpan.className = '_react-goto-code-num';
      numSpan.textContent = l.num;
      line.appendChild(numSpan);
      line.appendChild(document.createTextNode(l.text));
      codePreview.appendChild(line);
    });
  };
  document.addEventListener('__react-goto-source-result', handler);
}

function hideOverlay() {
  highlight.style.display = 'none';
  tooltip.style.display = 'none';
  clearAnchor();
}

// ── Option key hold = picker mode ──

let pickerActive = false;
let activeComp = null;

function matchesShortcut(e) {
  const pressed = new Set();
  if (e.metaKey) pressed.add('Meta');
  if (e.ctrlKey) pressed.add('Control');
  if (e.altKey) pressed.add('Alt');
  if (e.shiftKey) pressed.add('Shift');
  const nonModifier = !['Meta', 'Control', 'Alt', 'Shift'].includes(e.key);
  if (nonModifier) pressed.add(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  if (pressed.size !== SHORTCUT_KEYS.length) return false;
  return SHORTCUT_KEYS.every(k => pressed.has(k));
}

function hasShortcutModifiers(e) {
  // Check if the shortcut's modifier keys are still held
  for (const k of SHORTCUT_KEYS) {
    if (k === 'Alt' && !e.altKey) return false;
    if (k === 'Meta' && !e.metaKey) return false;
    if (k === 'Control' && !e.ctrlKey) return false;
    if (k === 'Shift' && !e.shiftKey) return false;
  }
  return true;
}

document.addEventListener('keydown', (e) => {
  if (pickerActive || !matchesShortcut(e)) return;
  pickerActive = true;
  document.body.style.cursor = 'crosshair';
  document.documentElement.appendChild(style);
  document.documentElement.appendChild(highlight);
  document.documentElement.appendChild(tooltip);
}, true);

document.addEventListener('keyup', (e) => {
  if (!pickerActive) return;
  // Deactivate when any of the shortcut keys is released
  if (SHORTCUT_KEYS.includes(e.key) || SHORTCUT_KEYS.includes(e.key.length === 1 ? e.key.toUpperCase() : e.key)) {
    pickerActive = false;
    document.body.style.cursor = '';
    clearAnchor();
    highlight.remove();
    tooltip.remove();
    style.remove();
  }
}, true);

// When window loses focus while Option is held, clean up
window.addEventListener('blur', () => {
  if (!pickerActive) return;
  pickerActive = false;
  document.body.style.cursor = '';
  overlay.remove();
});

// ── Hover to highlight ──

let lastMoveTime = 0;
let throttleId = 0;

document.addEventListener('mousemove', (e) => {
  if (!pickerActive) return;

  const now = Date.now();
  clearTimeout(throttleId);

  const run = () => {
    lastMoveTime = Date.now();
    const comp = getNearestComponent(e.target);
    activeComp = comp;
    if (comp) {
      showOverlay(comp);
    } else {
      hideOverlay();
    }
  };

  const elapsed = now - lastMoveTime;
  if (elapsed >= 100) {
    run();
  } else {
    throttleId = setTimeout(run, 100 - elapsed);
  }
}, true);

// ── Click to open in VS Code ──

document.addEventListener('click', (e) => {
  if (!pickerActive || !activeComp) return;

  e.preventDefault();
  e.stopPropagation();

  const { fiber, hints, hoveredElement, ...compData } = activeComp;
  // Use the matched line from source search if available
  if (activeComp.matchedLine) compData.line = activeComp.matchedLine;

  document.dispatchEvent(new CustomEvent('__react-goto-component', {
    detail: { component: compData, projectRoot: PROJECT_ROOT }
  }));
}, true);
