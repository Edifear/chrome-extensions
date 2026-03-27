// ── Configuration ──
const PROJECT_ROOT = '/Users/sergii/Projects/medallion/frontend_service';

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
      if (!src.includes('node_modules')) {
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
      if (name && current._debugSource && !current._debugSource.fileName.includes('node_modules')) {
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

function getComponentBounds(comp) {
  // Use the actual hovered element's bounds — more reliable than fiber tree
  // walking, especially with wrapper-heavy components (Affix, Portal, etc.)
  if (comp.hoveredElement) return comp.hoveredElement.getBoundingClientRect();
  return null;
}

// ── Overlay ──

const overlay = document.createElement('div');
overlay.style.cssText = `
  position: fixed;
  pointer-events: none;
  z-index: 2147483647;
  background: rgba(97, 218, 251, 0.15);
  border: 2px solid rgba(97, 218, 251, 0.8);
  border-radius: 4px;
  display: none;
  transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
`;

const tooltip = document.createElement('div');
tooltip.style.cssText = `
  position: absolute;
  bottom: 100%;
  left: -2px;
  margin-bottom: 0;
  max-width: 500px;
  border-radius: 6px 6px 0 0;
  overflow: hidden;
`;

const label = document.createElement('div');
label.style.cssText = `
  padding: 4px 8px;
  background: rgba(97, 218, 251, 0.95);
  color: #1a1a2e;
  font: bold 11px/16px -apple-system, sans-serif;
  white-space: nowrap;
`;

const codePreview = document.createElement('pre');
codePreview.style.cssText = `
  margin: 0;
  padding: 6px 8px;
  background: rgba(30, 30, 46, 0.95);
  color: #cdd6f4;
  font: 10px/14px 'SF Mono', 'JetBrains Mono', monospace;
  white-space: pre;
  overflow: hidden;
  max-height: 112px;
`;

tooltip.appendChild(label);
tooltip.appendChild(codePreview);
overlay.appendChild(tooltip);

let sourceRequestId = 0;

function showOverlay(comp) {
  const rect = getComponentBounds(comp);
  if (!rect) { hideOverlay(); return; }

  const shortFile = comp.fileName.split('/').pop();
  label.textContent = `${comp.name}  ·  ${shortFile}:${comp.line}`;

  // Show overlay immediately, fetch source async
  codePreview.textContent = 'Loading...';
  codePreview.style.display = 'block';

  overlay.style.top = rect.top + 'px';
  overlay.style.left = rect.left + 'px';
  overlay.style.width = rect.width + 'px';
  overlay.style.height = rect.height + 'px';
  overlay.style.display = 'block';

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
    if (reqId !== sourceRequestId) return; // stale response
    const resp = e.detail;
    if (!resp?.success) {
      codePreview.textContent = resp?.error || 'Failed to read source';
      return;
    }

    // Update the matched line for label and click-to-open
    comp.matchedLine = resp.targetLine;
    label.textContent = `${comp.name}  ·  ${shortFile}:${resp.targetLine}`;

    codePreview.innerHTML = '';
    resp.lines.forEach(l => {
      const line = document.createElement('div');
      const isTarget = l.num === resp.targetLine;
      line.style.cssText = isTarget
        ? 'background: rgba(97, 218, 251, 0.2); margin: 0 -8px; padding: 0 8px;'
        : '';
      const numSpan = document.createElement('span');
      numSpan.style.cssText = 'color: #585b70; user-select: none; display: inline-block; width: 3ch; text-align: right; margin-right: 1ch;';
      numSpan.textContent = l.num;
      line.appendChild(numSpan);
      line.appendChild(document.createTextNode(l.text));
      codePreview.appendChild(line);
    });
  };
  document.addEventListener('__react-goto-source-result', handler);
}

function hideOverlay() {
  overlay.style.display = 'none';
}

// ── Option key hold = picker mode ──

let pickerActive = false;
let activeComp = null;

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Alt' || pickerActive) return;
  pickerActive = true;
  document.body.style.cursor = 'crosshair';
  document.documentElement.appendChild(overlay);
}, true);

document.addEventListener('keyup', (e) => {
  if (e.key !== 'Alt') return;
  pickerActive = false;
  document.body.style.cursor = '';
  overlay.remove();
}, true);

// When window loses focus while Option is held, clean up
window.addEventListener('blur', () => {
  if (!pickerActive) return;
  pickerActive = false;
  document.body.style.cursor = '';
  overlay.remove();
});

// ── Hover to highlight ──

let lastTarget = null;
let throttleId = 0;

document.addEventListener('mousemove', (e) => {
  if (!pickerActive) return;
  if (e.target === lastTarget) return;
  lastTarget = e.target;

  cancelAnimationFrame(throttleId);
  throttleId = requestAnimationFrame(() => {
    const comp = getNearestComponent(e.target);
    activeComp = comp;
    if (comp) {
      showOverlay(comp);
    } else {
      hideOverlay();
    }
  });
}, true);

// ── Click to open in VS Code ──

document.addEventListener('click', (e) => {
  if (!e.altKey || !activeComp) return;

  e.preventDefault();
  e.stopPropagation();

  const { fiber, hints, hoveredElement, ...compData } = activeComp;
  // Use the matched line from source search if available
  if (activeComp.matchedLine) compData.line = activeComp.matchedLine;

  document.dispatchEvent(new CustomEvent('__react-goto-component', {
    detail: { component: compData, projectRoot: PROJECT_ROOT }
  }));
}, true);
