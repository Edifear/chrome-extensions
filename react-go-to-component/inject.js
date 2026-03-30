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

  // Collect alternates: other unique source locations in the fiber chain
  const alternates = [];
  const primaryKey = `${source.fileName}:${source.line}`;
  const seenKeys = new Set([primaryKey]);
  current = fiber;
  while (current) {
    if (typeof current.type === 'function' && current._debugSource) {
      const src = current._debugSource.fileName;
      if (!SKIP_DIRS.some(d => src.includes(d))) {
        const name = current.type.displayName || current.type.name;
        if (name) {
          const fn = src.replace(/^\/app\//, '/');
          const ln = current._debugSource.lineNumber;
          const key = `${fn}:${ln}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            alternates.push({ name, fileName: fn, line: ln, col: current._debugSource.columnNumber });
          }
        }
      }
    }
    current = current.return;
  }

  return {
    name: componentName,
    fileName: source.fileName,
    line: source.line,
    col: source.col,
    fiber: componentFiber || fiber,
    hoveredElement: element,
    hints,
    alternates
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
    position-area: bottom center;
    position-try-fallbacks: top center;
    pointer-events: auto;
    cursor: crosshair;
    z-index: 2147483647;
    max-width: 600px;
    border-radius: 6px;
    overflow: hidden;
    margin-top: 4px;
  }
  ._react-goto-label {
    padding: 6px 10px;
    background: rgba(97, 218, 251, 0.95);
    color: #1a1a2e;
    font: bold 13px/18px -apple-system, sans-serif;
    white-space: nowrap;
  }
  ._react-goto-code {
    margin: 0;
    padding: 8px 10px;
    background: rgba(30, 30, 46, 0.95);
    color: #cdd6f4;
    font: 12px/18px 'SF Mono', 'JetBrains Mono', monospace;
    white-space: pre;
    overflow: hidden;
  }
  ._react-goto-code-line--target {
    background: rgba(97, 218, 251, 0.2);
    margin: 0 -10px;
    padding: 0 10px;
  }
  ._react-goto-code-num {
    color: #585b70;
    user-select: none;
    display: inline-block;
    width: 4ch;
    text-align: right;
    margin-right: 1ch;
  }
  ._react-goto-alternates {
    background: rgba(30, 30, 46, 0.95);
    pointer-events: auto;
    cursor: default;
  }
  ._react-goto-alternates:empty {
    display: none;
  }
  ._react-goto-alt-header {
    display: flex;
    align-items: center;
    padding: 4px 10px;
    cursor: pointer;
    border-top: 1px solid rgba(88, 91, 112, 0.3);
  }
  ._react-goto-alt-header:hover {
    background: rgba(88, 91, 112, 0.15);
  }
  ._react-goto-alt-label {
    flex: 1;
    font: 12px/18px -apple-system, sans-serif;
    color: #a6adc8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ._react-goto-alt-go {
    background: rgba(97, 218, 251, 0.25);
    border: none;
    color: #61dafb;
    font: bold 11px/1 -apple-system, sans-serif;
    padding: 3px 6px;
    border-radius: 3px;
    cursor: pointer;
    margin-left: 6px;
    flex-shrink: 0;
  }
  ._react-goto-alt-go:hover {
    background: rgba(97, 218, 251, 0.5);
  }
  ._react-goto-alt-code {
    padding: 4px 10px 6px;
    font: 12px/18px 'SF Mono', 'JetBrains Mono', monospace;
    color: #cdd6f4;
    white-space: pre;
    overflow: hidden;
    background: rgba(24, 24, 37, 0.5);
    border-top: 1px solid rgba(88, 91, 112, 0.15);
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

const alternatesContainer = document.createElement('div');
alternatesContainer.className = '_react-goto-alternates';

tooltip.appendChild(label);
tooltip.appendChild(codePreview);
tooltip.appendChild(alternatesContainer);

let nextReqId = 0;
let mainReqId = 0;

function readSource(file, line, context, hints, callback) {
  const reqId = ++nextReqId;
  const handler = (e) => {
    if (e.detail?.reqId !== reqId) return;
    document.removeEventListener('__react-goto-source-result', handler);
    callback(e.detail);
  };
  document.addEventListener('__react-goto-source-result', handler);
  document.dispatchEvent(new CustomEvent('__react-goto-read-source', {
    detail: { file, line, context, hints: hints || [], reqId, origin: location.origin, projectRoot: PROJECT_ROOT }
  }));
  return reqId;
}

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
  alternatesContainer.innerHTML = '';

  if (!SHOW_PREVIEW) {
    codePreview.style.display = 'none';
    alternatesContainer.style.display = 'none';
    return;
  }
  codePreview.style.display = '';
  alternatesContainer.style.display = '';

  // Request target line + 1 above and 1 below
  const reqId = readSource(
    `${PROJECT_ROOT}${comp.fileName}`, comp.line, 1, comp.hints,
    (resp) => {
      if (reqId !== mainReqId) return;
      if (!resp?.success) {
        codePreview.textContent = resp?.error || 'Failed to read source';
        return;
      }

      comp.matchedLine = resp.targetLine;
      label.textContent = `${comp.name}  ·  ${shortFile}:${resp.targetLine}`;

      // Strip common leading whitespace
      const minIndent = resp.lines.reduce((min, l) => {
        if (!l.text) return min;
        const m = l.text.match(/^\s*/);
        return Math.min(min, m[0].length);
      }, Infinity);

      codePreview.innerHTML = '';
      resp.lines.forEach(l => {
        const line = document.createElement('div');
        if (l.num === resp.targetLine) line.className = '_react-goto-code-line--target';
        const numSpan = document.createElement('span');
        numSpan.className = '_react-goto-code-num';
        numSpan.textContent = l.num;
        line.appendChild(numSpan);
        line.appendChild(document.createTextNode(l.text.slice(minIndent)));
        codePreview.appendChild(line);
      });
    }
  );
  mainReqId = reqId;

  // Render alternates
  (comp.alternates || []).slice(0, 5).forEach(alt => {
    const altShortFile = alt.fileName.split('/').pop();

    const header = document.createElement('div');
    header.className = '_react-goto-alt-header';

    const altLabel = document.createElement('span');
    altLabel.className = '_react-goto-alt-label';
    altLabel.textContent = `▸ ${alt.name}  ·  ${altShortFile}:${alt.line}`;

    const goBtn = document.createElement('button');
    goBtn.className = '_react-goto-alt-go';
    goBtn.textContent = '→';

    header.appendChild(altLabel);
    header.appendChild(goBtn);
    alternatesContainer.appendChild(header);

    const codeArea = document.createElement('div');
    codeArea.className = '_react-goto-alt-code';
    codeArea.style.display = 'none';
    alternatesContainer.appendChild(codeArea);

    let loaded = false;

    header.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanding = codeArea.style.display === 'none';
      codeArea.style.display = expanding ? '' : 'none';
      altLabel.textContent = `${expanding ? '▾' : '▸'} ${alt.name}  ·  ${altShortFile}:${alt.matchedLine || alt.line}`;

      if (expanding && !loaded) {
        loaded = true;
        codeArea.textContent = '…';
        readSource(
          `${PROJECT_ROOT}${alt.fileName}`, alt.line, 1, [alt.name],
          (resp) => {
            if (!resp?.success) {
              codeArea.textContent = resp?.error || 'Failed';
              return;
            }
            alt.matchedLine = resp.targetLine;
            altLabel.textContent = `▾ ${alt.name}  ·  ${altShortFile}:${resp.targetLine}`;
            const minIndent = resp.lines.reduce((min, l) => {
              if (!l.text) return min;
              return Math.min(min, l.text.match(/^\s*/)[0].length);
            }, Infinity);
            codeArea.textContent = '';
            resp.lines.forEach(l => {
              const line = document.createElement('div');
              if (l.num === resp.targetLine) line.className = '_react-goto-code-line--target';
              const numSpan = document.createElement('span');
              numSpan.className = '_react-goto-code-num';
              numSpan.textContent = l.num;
              line.appendChild(numSpan);
              line.appendChild(document.createTextNode(l.text.slice(minIndent)));
              codeArea.appendChild(line);
            });
          }
        );
      }
    });

    const goToAlt = () => {
      document.dispatchEvent(new CustomEvent('__react-goto-component', {
        detail: {
          component: { name: alt.name, fileName: alt.fileName, line: alt.matchedLine || alt.line, col: alt.col },
          projectRoot: PROJECT_ROOT
        }
      }));
    };

    goBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      goToAlt();
    });

    codeArea.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      goToAlt();
    });
  });
}

function hideOverlay() {
  highlight.style.display = 'none';
  tooltip.style.display = 'none';
  clearAnchor();
}

// ── Option key hold = picker mode ──

let pickerActive = false;
let activeComp = null;
let tooltipPinned = false;
let lastMouseX = 0;
let lastMouseY = 0;

document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
}, true);

function isMouseOverTooltip() {
  const el = document.elementFromPoint(lastMouseX, lastMouseY);
  return el && tooltip.contains(el);
}

function unpinTooltip() {
  if (!tooltipPinned) return;
  tooltipPinned = false;
  activeComp = null;
  clearAnchor();
  tooltip.remove();
  style.remove();
}

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
  if (tooltipPinned && e.key === 'Escape') { unpinTooltip(); return; }
  if (tooltipPinned) unpinTooltip();
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
    // Check BEFORE any DOM changes (clearAnchor would move the tooltip)
    const shouldPin = activeComp && isMouseOverTooltip();

    pickerActive = false;
    document.body.style.cursor = '';
    clearTimeout(switchTimeout);
    clearTimeout(throttleId);
    highlight.remove();

    if (shouldPin) {
      // Keep anchor + tooltip in place, just remove highlight
      tooltipPinned = true;
    } else {
      activeComp = null;
      clearAnchor();
      tooltip.remove();
      style.remove();
    }
  }
}, true);

// When window loses focus while Option is held, clean up
window.addEventListener('blur', () => {
  if (tooltipPinned) { unpinTooltip(); return; }
  if (!pickerActive) return;
  pickerActive = false;
  document.body.style.cursor = '';
  clearTimeout(switchTimeout);
  clearTimeout(throttleId);
  clearAnchor();
  highlight.remove();
  tooltip.remove();
  style.remove();
});

// ── Hover to highlight ──

let lastMoveTime = 0;
let throttleId = 0;
let switchTimeout = 0;

document.addEventListener('mousemove', (e) => {
  if (!pickerActive) return;

  // Mouse over our overlay — cancel any pending switch, keep current
  if (isMouseOverTooltip() || e.target === highlight) {
    clearTimeout(switchTimeout);
    clearTimeout(throttleId);
    return;
  }

  const now = Date.now();
  clearTimeout(throttleId);

  const run = () => {
    lastMoveTime = Date.now();
    const comp = getNearestComponent(e.target);

    // No active overlay — show immediately
    if (!activeComp) {
      clearTimeout(switchTimeout);
      activeComp = comp;
      if (comp) showOverlay(comp);
      return;
    }

    // Same element — keep current
    if (comp && comp.hoveredElement === activeComp.hoveredElement) {
      clearTimeout(switchTimeout);
      return;
    }

    // Different element — grace period before switching
    clearTimeout(switchTimeout);
    switchTimeout = setTimeout(() => {
      activeComp = comp;
      if (comp) showOverlay(comp);
      else hideOverlay();
    }, 300);
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
  // Pinned tooltip: click outside dismisses, click on label/code opens file
  if (tooltipPinned) {
    if (alternatesContainer.contains(e.target)) return;
    if (tooltip.contains(e.target) && activeComp) {
      e.preventDefault();
      e.stopPropagation();
      const { fiber, hints, hoveredElement, alternates, ...compData } = activeComp;
      if (activeComp.matchedLine) compData.line = activeComp.matchedLine;
      document.dispatchEvent(new CustomEvent('__react-goto-component', {
        detail: { component: compData, projectRoot: PROJECT_ROOT }
      }));
    }
    unpinTooltip();
    return;
  }

  if (!pickerActive || !activeComp) return;
  if (alternatesContainer.contains(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  const { fiber, hints, hoveredElement, alternates, ...compData } = activeComp;
  if (activeComp.matchedLine) compData.line = activeComp.matchedLine;

  document.dispatchEvent(new CustomEvent('__react-goto-component', {
    detail: { component: compData, projectRoot: PROJECT_ROOT }
  }));
}, true);
