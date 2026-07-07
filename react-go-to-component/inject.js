// ── React DevTools Hook: capture fiber roots for annotation ──

const _fiberRoots = new Set();
let _annotationDirty = false;

(function installReactHook() {
  const existing = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;

  function onCommit(rendererID, root) {
    _fiberRoots.add(root);
    _annotationDirty = true;
    if (pickerActive) scheduleAnnotation();
  }

  if (existing) {
    const old = existing.onCommitFiberRoot;
    existing.onCommitFiberRoot = function(rendererID, root, priority, didError) {
      try { onCommit(rendererID, root); } catch(e) { console.warn('[react-goto]', e); }
      if (typeof old === 'function') old.apply(this, arguments);
    };
  } else {
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(),
      supportsFiber: true,
      inject: function() { return 0; },
      onScheduleFiberRoot: function() {},
      onCommitFiberRoot: function(rendererID, root) {
        try { onCommit(rendererID, root); } catch(e) { console.warn('[react-goto]', e); }
      },
      onCommitFiberUnmount: function() {},
    };
  }
})();

// ── Configuration ──

let PROJECT_ROOT = '';
let SHORTCUT_KEYS = ['Alt'];
let SHOW_PREVIEW = true;
let SKIP_DIRS = ['node_modules'];
let DISABLED = false;

function fullPath(fileName) {
  // An absolute path already points at a real on-disk location — e.g. the git
  // worktree the dev server is running from. Use it verbatim; prepending
  // PROJECT_ROOT would produce a doubled, broken path. Only project-relative
  // paths (e.g. Docker "src/..." after the /app strip) get PROJECT_ROOT.
  if (fileName.startsWith('/')) return fileName;
  if (!PROJECT_ROOT) return fileName;
  const root = PROJECT_ROOT.endsWith('/') ? PROJECT_ROOT : PROJECT_ROOT + '/';
  return `${root}${fileName}`;
}

function applySettings(s) {
  if (!s || typeof s !== 'object') return;
  if (s.projectRoot !== undefined) PROJECT_ROOT = s.projectRoot;
  if (s.shortcutKeys !== undefined) SHORTCUT_KEYS = s.shortcutKeys;
  if (s.showPreview !== undefined) {
    SHOW_PREVIEW = s.showPreview;
    if (_ui) _ui.codePreview.style.display = SHOW_PREVIEW ? '' : 'none';
  }
  if (s.skipDirs !== undefined) {
    const extra = s.skipDirs.split(',').map(d => d.trim()).filter(Boolean);
    SKIP_DIRS = ['node_modules', ...extra];
    _annotationDirty = true;
  }
  if (s.disabled !== undefined) {
    DISABLED = !!s.disabled;
    if (DISABLED) deactivate();
  }
}

// ── Plugin registry ──

const _plugins = new Map();

function firePluginHook(hookName, arg) {
  for (const p of _plugins.values()) {
    try { p.hooks[hookName]?.(arg); } catch (e) { console.warn('[react-goto]', p.name, hookName, e); }
  }
}

function awaitPluginHook(hookName, arg) {
  for (const p of _plugins.values()) {
    const fn = p.hooks[hookName];
    if (typeof fn === 'function') {
      try { return Promise.resolve(fn(arg)); }
      catch (e) { return Promise.reject(e); }
    }
  }
  return Promise.reject(new Error(`no plugin handles ${hookName}`));
}

function broadcastStateChange() {
  firePluginHook('onStateChange', { active: pickerActive || tooltipPinned });
}

// ── Typed bridge to ISOLATED world ──
//   inject.js → content.js: __react-goto:to-iso  {type, ...}
//   content.js → inject.js: __react-goto:to-main {type, ...}

const _pendingReqs = new Map();
let _nextReqId = 0;

function sendToIso(msg) {
  document.dispatchEvent(new CustomEvent('__react-goto:to-iso', { detail: msg }));
}

function request(type, payload, timeoutMs) {
  const reqId = ++_nextReqId;
  return new Promise((resolve) => {
    _pendingReqs.set(reqId, resolve);
    sendToIso({ type, reqId, ...payload });
    setTimeout(() => {
      if (_pendingReqs.has(reqId)) {
        _pendingReqs.delete(reqId);
        resolve({ success: false, error: 'timeout' });
      }
    }, timeoutMs);
  });
}

document.addEventListener('__react-goto:to-main', (e) => {
  const m = e.detail;
  if (!m || typeof m !== 'object') return;
  switch (m.type) {
    case 'settings':
      applySettings(m.settings);
      break;
    case 'contextMenu':
      handleContextMenu();
      break;
    case 'response': {
      const resolve = _pendingReqs.get(m.reqId);
      if (resolve) { _pendingReqs.delete(m.reqId); resolve(m.result || {}); }
      break;
    }
  }
});

// Built-in bridge plugin: routes picker hooks across the world boundary
_plugins.set('iso-bridge', {
  name: 'iso-bridge',
  hooks: {
    onStateChange(state) {
      sendToIso({ type: 'stateChange', active: state.active });
    },
    onRequestOpen(component) {
      return request('open', { component, projectRoot: PROJECT_ROOT }, 3000);
    },
    onRequestReadSource(params) {
      return request('readSource', { ...params, origin: getViteOrigin(), projectRoot: PROJECT_ROOT }, 5000);
    }
  }
});

// ── Public plugin API ──

window.__REACT_GOTO__ = Object.freeze({
  registerPlugin(plugin) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.hooks) throw new Error('invalid plugin');
    _plugins.set(plugin.name, plugin);
    plugin.hooks.onInit?.({ settings: { projectRoot: PROJECT_ROOT, shortcutKeys: SHORTCUT_KEYS, showPreview: SHOW_PREVIEW } });
    return () => _plugins.delete(plugin.name);
  },
  unregisterPlugin(name) {
    _plugins.delete(name);
  },
  activate() { activate(); },
  deactivate() { deactivate(); },
  toggle() { (pickerActive ? deactivate : activate)(); },
  setSettings: applySettings,
  get isActive() { return pickerActive || tooltipPinned; }
});

// ── Fiber Walking ──

function getFiber(element) {
  const key = Object.keys(element).find(k => k.startsWith('__reactFiber$'));
  return key ? element[key] : null;
}

function getElementHints(element) {
  const hints = [];
  const directText = Array.from(element.childNodes)
    .filter(n => n.nodeType === 3)
    .map(n => n.textContent.trim())
    .filter(Boolean)
    .join(' ');
  if (directText && directText.length < 80) hints.push(directText);
  const text = element.textContent?.trim();
  if (text && text.length < 40 && text !== directText) hints.push(text);
  const textToSplit = directText || text || '';
  if (textToSplit) {
    const fragments = textToSplit.split(/[\d]+[\d/:\s.,aApPmM]*/).map(f => f.trim()).filter(f => f.length >= 3);
    for (const frag of fragments) {
      if (!hints.includes(frag)) hints.push(frag);
    }
  }
  if (element.tagName) hints.push(element.tagName.toLowerCase());
  if (element.className && typeof element.className === 'string') {
    element.className.split(/\s+/).filter(Boolean).forEach(c => {
      hints.push(c);
      const parts = c.split(/[-_]/).filter(Boolean);
      if (parts.length >= 2) {
        for (const part of parts) {
          if (part.length >= 4 && !/^[a-z0-9]{3,6}$/.test(part) && !hints.includes(part)) {
            hints.push(part);
          }
        }
      }
    });
  }
  for (const attr of ['id', 'name', 'href', 'src', 'alt', 'placeholder', 'aria-label', 'data-testid']) {
    const val = element.getAttribute?.(attr);
    if (val) hints.push(val);
  }
  return hints;
}

function getNearestComponent(element) {
  let el = element;
  let fiber = null;
  while (el && el !== document.documentElement) {
    fiber = getFiber(el);
    if (fiber) break;
    el = el.parentElement;
  }
  if (!fiber) return null;

  const hints = getElementHints(element);

  let elementSource = null;
  let current = fiber;
  while (current) {
    if (current._debugSource) {
      const src = current._debugSource.fileName;
      if (!SKIP_DIRS.some(d => src.includes(d))) {
        elementSource = {
          fileName: src.replace(/^\/app\//, ''),
          line: current._debugSource.lineNumber,
          col: current._debugSource.columnNumber
        };
        break;
      }
    }
    current = current.return;
  }

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

  const source = elementSource || {
    fileName: componentFiber._debugSource.fileName.replace(/^\/app\//, ''),
    line: componentFiber._debugSource.lineNumber,
    col: componentFiber._debugSource.columnNumber
  };

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
          const fn = src.replace(/^\/app\//, '');
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

// ── Fiber Annotation ──

let _annotationRAF = 0;

function scheduleAnnotation() {
  if (_annotationRAF) return;
  _annotationRAF = requestAnimationFrame(() => {
    _annotationRAF = 0;
    annotateAll();
  });
}

function annotateAll() {
  for (const root of _fiberRoots) {
    if (root.current) walkFiber(root.current, null);
  }
  _annotationDirty = false;
}

function walkFiber(fiber, nearestComponent) {
  if (!fiber) return;

  if (typeof fiber.type === 'function' || (typeof fiber.type === 'object' && fiber.type !== null)) {
    const name = fiber.type?.displayName || fiber.type?.name ||
                 fiber.type?.render?.displayName || fiber.type?.render?.name;
    if (name && fiber._debugSource && !isSkippedPath(fiber._debugSource.fileName)) {
      nearestComponent = name;
    }
  }

  if (fiber.stateNode && fiber.stateNode.nodeType === 1) {
    const src = findDebugSource(fiber);
    if (src) {
      const fn = src.fileName.replace(/^\/app\//, '');
      fiber.stateNode.setAttribute('data-source', `${fn}:${src.lineNumber}:${src.columnNumber || 0}`);
      if (nearestComponent) {
        fiber.stateNode.setAttribute('data-component', nearestComponent);
      }
    }
  }

  let child = fiber.child;
  while (child) {
    walkFiber(child, nearestComponent);
    child = child.sibling;
  }
}

function findDebugSource(fiber) {
  let f = fiber;
  while (f) {
    if (f._debugSource && !isSkippedPath(f._debugSource.fileName)) return f._debugSource;
    f = f.return;
  }
  return null;
}

function isSkippedPath(fileName) {
  return SKIP_DIRS.some(d => fileName.includes(d));
}

function getSourceFromAnnotation(element) {
  let el = element;
  while (el && el !== document.documentElement) {
    const src = el.getAttribute('data-source');
    if (src) {
      const name = inferNameFromPath(src);
      const parsed = parseSourceAttr(src);

      const hints = getElementHints(element);
      if (name && !hints.includes(name)) hints.push(name);

      const alternates = [];
      const seenKeys = new Set([`${parsed.fileName}:${parsed.line}`]);

      const fiber = getFiber(el);
      if (fiber) {
        let f = fiber.return;
        let depth = 0;
        while (f && depth < 15 && alternates.length < 5) {
          if (typeof f.type === 'function' && f._debugSource) {
            const src2 = f._debugSource;
            if (!isSkippedPath(src2.fileName)) {
              const fn = src2.fileName.replace(/^\/app\//, '');
              const ln = src2.lineNumber;
              const key = `${fn}:${ln}`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                const cname = inferNameFromPath(`${fn}:${ln}:0`);
                alternates.push({ name: cname, fileName: fn, line: ln, col: src2.columnNumber || 0 });
              }
            }
          }
          f = f.return;
          depth++;
        }
      }

      let parent = el.parentElement;
      while (parent && parent !== document.documentElement && alternates.length < 5) {
        const ps = parent.getAttribute('data-source');
        if (ps) {
          const pp = parseSourceAttr(ps);
          const key = `${pp.fileName}:${pp.line}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            alternates.push({
              name: inferNameFromPath(ps),
              fileName: pp.fileName, line: pp.line, col: pp.col
            });
          }
        }
        parent = parent.parentElement;
      }

      return {
        name, fileName: parsed.fileName, line: parsed.line, col: parsed.col,
        hoveredElement: element, hints, alternates
      };
    }
    el = el.parentElement;
  }
  return null;
}

function parseSourceAttr(raw) {
  const last = raw.lastIndexOf(':');
  const second = raw.lastIndexOf(':', last - 1);
  return {
    fileName: raw.substring(0, second),
    line: parseInt(raw.substring(second + 1, last), 10),
    col: parseInt(raw.substring(last + 1), 10)
  };
}

function inferNameFromPath(dataSource) {
  const filePath = dataSource.substring(0, dataSource.lastIndexOf(':', dataSource.lastIndexOf(':') - 1));
  const GENERIC = ['src', 'components', 'ui', 'pages', 'containers', 'modules', 'layout', 'dumb_components', 'views', 'features'];
  const parts = filePath.split('/');
  const base = parts[parts.length - 1].replace(/\.[jt]sx?$/, '');
  if (base === 'index') {
    for (let i = parts.length - 2; i >= 0; i--) {
      if (!GENERIC.includes(parts[i])) return parts[i];
    }
  }
  return base;
}

// ── Vite origin detection ──

let _viteOrigin = null;
function getViteOrigin() {
  if (_viteOrigin !== null) return _viteOrigin;
  const viteScript = document.querySelector('script[src*="/@vite/"], script[src*="/@react-refresh"]');
  _viteOrigin = viteScript ? new URL(viteScript.src).origin : location.origin;
  return _viteOrigin;
}

// ── Source-read wrapper ──

function readSource(file, line, context, hints, callback) {
  awaitPluginHook('onRequestReadSource', { file, line, context, hints: hints || [] })
    .then(callback, (e) => callback({ success: false, error: String(e?.message || e) }));
}

// ── Overlay styles (injected lazily) ──

const ANCHOR_NAME = '--react-goto-target';
const OVERLAY_CSS = `
  ._react-goto-highlight {
    position: fixed;
    position-anchor: ${ANCHOR_NAME};
    inset: anchor(top) anchor(right) anchor(bottom) anchor(left);
    pointer-events: none;
    z-index: 2147483647;
    background: rgba(97, 218, 251, 0.15);
    outline: 2px solid rgba(97, 218, 251, 0.8);
    outline-offset: -2px;
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
    display: flex;
    align-items: center;
    padding: 4px 10px;
    cursor: pointer;
    background: rgba(30, 30, 46, 0.95);
  }
  ._react-goto-label:hover {
    background: rgba(40, 40, 56, 0.95);
  }
  ._react-goto-label-text {
    flex: 1;
    font: bold 12px/18px -apple-system, sans-serif;
    color: #61dafb;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ._react-goto-code {
    margin: 0;
    padding: 4px 10px 6px;
    background: rgba(24, 24, 37, 0.95);
    color: #cdd6f4;
    font: 12px/18px 'SF Mono', 'JetBrains Mono', monospace;
    white-space: pre;
    overflow: hidden;
    border-top: 1px solid rgba(88, 91, 112, 0.15);
  }
  ._react-goto-code > div,
  ._react-goto-alt-code > div {
    cursor: pointer;
    margin: 0 -10px;
    padding: 0 10px;
  }
  ._react-goto-code > div:hover,
  ._react-goto-alt-code > div:hover {
    background: rgba(88, 91, 112, 0.3);
  }
  ._react-goto-code-line--target {
    background: rgba(97, 218, 251, 0.2) !important;
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
  ._react-goto-copy {
    background: rgba(97, 218, 251, 0.25);
    border: none;
    color: #61dafb;
    font: bold 11px/1 -apple-system, sans-serif;
    padding: 3px 6px;
    border-radius: 3px;
    cursor: pointer;
    margin-left: 6px;
    flex-shrink: 0;
    opacity: 0;
  }
  ._react-goto-copy:hover {
    background: rgba(97, 218, 251, 0.5);
  }
  ._react-goto-label:hover ._react-goto-copy,
  ._react-goto-alt-header:hover ._react-goto-copy {
    opacity: 1;
  }
  ._react-goto-alt-code {
    padding: 4px 10px 6px;
    font: 12px/18px 'SF Mono', 'JetBrains Mono', monospace;
    color: #cdd6f4;
    white-space: pre;
    overflow: hidden;
    background: rgba(24, 24, 37, 0.95);
    border-top: 1px solid rgba(88, 91, 112, 0.15);
  }
  ._react-goto-loader {
    position: absolute;
    top: 0;
    left: 0;
    width: 0;
    height: 3px;
    background: #61dafb;
    box-shadow: 0 0 8px rgba(97, 218, 251, 0.6);
    border-radius: 2px 2px 0 0;
    animation: _react-goto-fw 0.8s ease-out forwards;
    z-index: 1;
  }
  @keyframes _react-goto-fw {
    0% { width: 0; }
    100% { width: 100%; }
  }
  ._react-goto-error {
    padding: 6px 10px;
    background: rgba(220, 38, 38, 0.9);
    color: #fff;
    font: 11px/16px -apple-system, sans-serif;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;

// ── Lazy UI ──

let _ui = null;

function ensureUI() {
  if (_ui) return _ui;

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;

  const highlight = document.createElement('div');
  highlight.className = '_react-goto-highlight';

  const tooltip = document.createElement('div');
  tooltip.className = '_react-goto-tooltip';

  const label = document.createElement('div');
  label.className = '_react-goto-label';

  const labelText = document.createElement('span');
  labelText.className = '_react-goto-label-text';

  const labelCopyBtn = document.createElement('button');
  labelCopyBtn.className = '_react-goto-copy';
  labelCopyBtn.textContent = '\u2398';

  const labelGoBtn = document.createElement('button');
  labelGoBtn.className = '_react-goto-alt-go';
  labelGoBtn.textContent = '\u2192';

  label.appendChild(labelText);
  label.appendChild(labelCopyBtn);
  label.appendChild(labelGoBtn);

  const codePreview = document.createElement('pre');
  codePreview.className = '_react-goto-code';
  if (!SHOW_PREVIEW) codePreview.style.display = 'none';

  const alternatesContainer = document.createElement('div');
  alternatesContainer.className = '_react-goto-alternates';

  tooltip.appendChild(label);
  tooltip.appendChild(codePreview);
  tooltip.appendChild(alternatesContainer);

  tooltip.addEventListener('mouseleave', () => {
    if (!tooltipPinned) return;
    unpinTimeout = setTimeout(() => {
      if (!tooltipPinned) return;
      if (isMouseOverTooltip()) return;
      unpinTooltip();
    }, 1000);
  });
  tooltip.addEventListener('mouseenter', () => { clearTimeout(unpinTimeout); });

  _ui = { style, highlight, tooltip, label, labelText, labelCopyBtn, labelGoBtn, codePreview, alternatesContainer };
  return _ui;
}

// ── Anchor positioning ──

let prevAnchor = null;

function setAnchor(element) {
  if (prevAnchor) prevAnchor.style.anchorName = '';
  element.style.anchorName = ANCHOR_NAME;
  prevAnchor = element;
}

function clearAnchor() {
  if (prevAnchor) prevAnchor.style.anchorName = '';
  prevAnchor = null;
}

// ── Open in editor with loading indicator ──

function openInEditor(component) {
  const ui = ensureUI();
  const loader = document.createElement('div');
  loader.className = '_react-goto-loader';
  ui.tooltip.insertBefore(loader, ui.tooltip.firstChild);
  ui.tooltip.querySelector('._react-goto-error')?.remove();

  const minTime = new Promise(r => setTimeout(r, 800));
  const responsePromise = awaitPluginHook('onRequestOpen', component)
    .catch((e) => ({ success: false, error: String(e?.message || e) }));

  Promise.all([minTime, responsePromise]).then(([, result]) => {
    loader.remove();
    if (result && !result.success && result.error) {
      const err = document.createElement('div');
      err.className = '_react-goto-error';
      err.textContent = result.error;
      ui.tooltip.insertBefore(err, ui.tooltip.firstChild);
    }
  });
}

// ── Overlay rendering ──

let mainReqId = 0;

function showOverlay(comp) {
  const ui = ensureUI();
  if (!comp.hoveredElement) { hideOverlay(); return; }

  setAnchor(comp.hoveredElement);

  const shortFile = comp.fileName.split('/').pop();
  ui.labelText.textContent = `\u25BE ${comp.name}  \u00B7  ${shortFile}:${comp.line}`;

  ui.highlight.style.display = '';
  ui.tooltip.style.display = '';
  ui.alternatesContainer.innerHTML = '';

  ui.labelCopyBtn.onclick = (e) => {
    e.stopPropagation();
    const path = `${fullPath(comp.fileName)}:${comp.matchedLine || comp.line}`;
    navigator.clipboard.writeText(path);
    ui.labelCopyBtn.textContent = '\u2713';
    setTimeout(() => { ui.labelCopyBtn.textContent = '\u2398'; }, 1000);
  };

  ui.label.onclick = (e) => {
    if (e.target === ui.labelGoBtn || e.target === ui.labelCopyBtn) return;
    e.stopPropagation();
    const collapsing = ui.codePreview.style.display !== 'none';
    ui.codePreview.style.display = collapsing ? 'none' : '';
    ui.labelText.textContent = `${collapsing ? '\u25B8' : '\u25BE'} ${comp.name}  \u00B7  ${shortFile}:${comp.matchedLine || comp.line}`;
  };

  ui.labelGoBtn.onclick = (e) => {
    e.stopPropagation();
    const { hints, hoveredElement, alternates, ...compData } = comp;
    if (comp.matchedLine) compData.line = comp.matchedLine;
    openInEditor(compData);
  };

  if (!SHOW_PREVIEW) {
    ui.codePreview.style.display = 'none';
    ui.alternatesContainer.style.display = 'none';
    return;
  }
  ui.codePreview.style.display = '';
  ui.alternatesContainer.style.display = '';

  const reqId = ++mainReqId;
  readSource(
    `${fullPath(comp.fileName)}`, comp.line, 2, comp.hints,
    (resp) => {
      if (reqId !== mainReqId) return;
      if (!resp?.success) {
        ui.codePreview.textContent = resp?.error || 'Failed to read source';
        return;
      }

      comp.matchedLine = resp.targetLine;
      ui.labelText.textContent = `\u25BE ${comp.name}  \u00B7  ${shortFile}:${resp.targetLine}`;

      const minIndent = resp.lines.reduce((min, l) => {
        if (!l.text) return min;
        const m = l.text.match(/^\s*/);
        return Math.min(min, m[0].length);
      }, Infinity);

      ui.codePreview.innerHTML = '';
      resp.lines.forEach(l => {
        const line = document.createElement('div');
        if (l.num === resp.targetLine) line.className = '_react-goto-code-line--target';
        const numSpan = document.createElement('span');
        numSpan.className = '_react-goto-code-num';
        numSpan.textContent = l.num;
        line.appendChild(numSpan);
        line.appendChild(document.createTextNode(l.text.slice(minIndent)));
        line.addEventListener('click', (e) => {
          e.stopPropagation();
          openInEditor({ name: comp.name, fileName: comp.fileName, line: l.num, col: 0 });
        });
        ui.codePreview.appendChild(line);
      });
    }
  );

  (comp.alternates || []).slice(0, 5).forEach(alt => {
    const altShortFile = alt.fileName.split('/').pop();

    const header = document.createElement('div');
    header.className = '_react-goto-alt-header';

    const altLabel = document.createElement('span');
    altLabel.className = '_react-goto-alt-label';
    altLabel.textContent = `\u25B8 ${alt.name}  \u00B7  ${altShortFile}`;

    const copyBtn = document.createElement('button');
    copyBtn.className = '_react-goto-copy';
    copyBtn.textContent = '\u2398';

    const goBtn = document.createElement('button');
    goBtn.className = '_react-goto-alt-go';
    goBtn.textContent = '\u2192';

    header.appendChild(altLabel);
    header.appendChild(copyBtn);
    header.appendChild(goBtn);
    ui.alternatesContainer.appendChild(header);

    const codeArea = document.createElement('div');
    codeArea.className = '_react-goto-alt-code';
    codeArea.style.display = 'none';
    ui.alternatesContainer.appendChild(codeArea);

    let loaded = false;

    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const path = `${fullPath(alt.fileName)}:${alt.matchedLine || alt.line}`;
      navigator.clipboard.writeText(path);
      copyBtn.textContent = '\u2713';
      setTimeout(() => { copyBtn.textContent = '\u2398'; }, 1000);
    });

    header.addEventListener('click', (e) => {
      if (e.target === goBtn || e.target === copyBtn) return;
      e.stopPropagation();
      const expanding = codeArea.style.display === 'none';
      codeArea.style.display = expanding ? '' : 'none';
      altLabel.textContent = `${expanding ? '\u25BE' : '\u25B8'} ${alt.name}  \u00B7  ${altShortFile}${alt.matchedLine ? ':' + alt.matchedLine : ''}`;

      if (expanding && !loaded) {
        loaded = true;
        codeArea.textContent = '\u2026';
        readSource(
          `${fullPath(alt.fileName)}`, alt.line, 2, [alt.name],
          (resp) => {
            if (!resp?.success) {
              codeArea.textContent = resp?.error || 'Failed';
              return;
            }
            alt.matchedLine = resp.targetLine;
            altLabel.textContent = `\u25BE ${alt.name}  \u00B7  ${altShortFile}:${resp.targetLine}`;
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
              line.addEventListener('click', (e) => {
                e.stopPropagation();
                openInEditor({ name: alt.name, fileName: alt.fileName, line: l.num, col: 0 });
              });
              codeArea.appendChild(line);
            });
          }
        );
      }
    });

    goBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInEditor({ name: alt.name, fileName: alt.fileName, line: alt.matchedLine || alt.line, col: alt.col });
    });
  });
}

function hideOverlay() {
  if (!_ui) return;
  _ui.highlight.style.display = 'none';
  _ui.tooltip.style.display = 'none';
  clearAnchor();
}

// ── Activation / picker state ──

let pickerActive = false;
let activeComp = null;
let tooltipPinned = false;
let lastMouseX = 0;
let lastMouseY = 0;
let unpinTimeout = 0;
let lastMoveTime = 0;
let throttleId = 0;
let switchTimeout = 0;
let _lazyListenersInstalled = false;

function isMouseOverTooltip() {
  if (!_ui) return false;
  const el = document.elementFromPoint(lastMouseX, lastMouseY);
  return el && _ui.tooltip.contains(el);
}

function installLazyListeners() {
  if (_lazyListenersInstalled) return;
  _lazyListenersInstalled = true;

  document.addEventListener('mousemove', (e) => {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  }, true);

  document.addEventListener('mousemove', onPickerMouseMove, true);
  document.addEventListener('click', onPickerClick, true);
  document.addEventListener('keyup', onPickerKeyUp, true);
  window.addEventListener('blur', onWindowBlur);
}

function activate() {
  if (DISABLED) return;
  if (pickerActive) return;
  const ui = ensureUI();
  installLazyListeners();

  pickerActive = true;
  if (_annotationDirty || _fiberRoots.size === 0) annotateAll();
  document.body.style.cursor = 'crosshair';
  document.documentElement.appendChild(ui.style);
  document.documentElement.appendChild(ui.highlight);
  document.documentElement.appendChild(ui.tooltip);
  broadcastStateChange();
}

function deactivate() {
  if (!pickerActive && !tooltipPinned) return;
  const wasActive = pickerActive;
  pickerActive = false;
  document.body.style.cursor = '';
  clearTimeout(switchTimeout);
  clearTimeout(throttleId);
  if (_ui) {
    _ui.highlight.remove();
    if (!tooltipPinned) {
      _ui.tooltip.remove();
      _ui.style.remove();
      clearAnchor();
    }
  }
  if (wasActive) broadcastStateChange();
}

function pinTooltipInPlace() {
  if (!_ui) return;
  const rect = _ui.tooltip.getBoundingClientRect();
  _ui.tooltip.style.positionAnchor = 'unset';
  _ui.tooltip.style.positionArea = 'unset';
  _ui.tooltip.style.marginTop = '0';
  _ui.tooltip.style.top = rect.top + 'px';
  _ui.tooltip.style.left = rect.left + 'px';
  clearAnchor();
}

function unpinTooltip() {
  if (!tooltipPinned) return;
  clearTimeout(unpinTimeout);
  tooltipPinned = false;
  activeComp = null;
  if (_ui) {
    _ui.tooltip.style.positionAnchor = '';
    _ui.tooltip.style.positionArea = '';
    _ui.tooltip.style.marginTop = '';
    _ui.tooltip.style.top = '';
    _ui.tooltip.style.left = '';
    clearAnchor();
    _ui.tooltip.remove();
    _ui.style.remove();
  }
  broadcastStateChange();
}

// ── Shortcut matching ──

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

// ── Eager: keydown (arms picker) ──

document.addEventListener('keydown', (e) => {
  if (DISABLED) return;
  if (tooltipPinned && e.key === 'Escape') { unpinTooltip(); return; }
  if (tooltipPinned && matchesShortcut(e)) unpinTooltip();
  if (pickerActive || !matchesShortcut(e)) return;
  activate();
}, true);

// ── Lazy: keyup, mousemove, click, blur ──

function onPickerKeyUp(e) {
  if (!pickerActive) return;
  if (SHORTCUT_KEYS.includes(e.key) || SHORTCUT_KEYS.includes(e.key.length === 1 ? e.key.toUpperCase() : e.key)) {
    const shouldPin = activeComp && isMouseOverTooltip();

    pickerActive = false;
    document.body.style.cursor = '';
    clearTimeout(switchTimeout);
    clearTimeout(throttleId);
    if (_ui) _ui.highlight.remove();

    if (shouldPin) {
      tooltipPinned = true;
      pinTooltipInPlace();
    } else if (activeComp) {
      tooltipPinned = true;
      pinTooltipInPlace();
      setTimeout(() => {
        if (!tooltipPinned) return;
        if (isMouseOverTooltip()) return;
        unpinTooltip();
      }, 600);
    } else if (_ui) {
      clearAnchor();
      _ui.tooltip.remove();
      _ui.style.remove();
    }
    broadcastStateChange();
  }
}

function onWindowBlur() {
  if (tooltipPinned) { unpinTooltip(); return; }
  if (!pickerActive) return;
  deactivate();
}

function onPickerMouseMove(e) {
  if (!pickerActive) return;

  if (isMouseOverTooltip() || (_ui && e.target === _ui.highlight)) {
    clearTimeout(switchTimeout);
    clearTimeout(throttleId);
    return;
  }

  const now = Date.now();
  clearTimeout(throttleId);

  const run = () => {
    lastMoveTime = Date.now();
    const comp = getSourceFromAnnotation(e.target) || getNearestComponent(e.target);

    if (!activeComp) {
      clearTimeout(switchTimeout);
      activeComp = comp;
      if (comp) showOverlay(comp);
      return;
    }

    if (comp && comp.hoveredElement === activeComp.hoveredElement) {
      clearTimeout(switchTimeout);
      return;
    }

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
}

function onPickerClick(e) {
  if (tooltipPinned) {
    if (_ui && _ui.tooltip.contains(e.target)) return;
    unpinTooltip();
    return;
  }

  if (!pickerActive || !activeComp) return;
  if (_ui && _ui.tooltip.contains(e.target)) return;

  e.preventDefault();
  e.stopPropagation();

  const { fiber, hints, hoveredElement, alternates, ...compData } = activeComp;
  if (activeComp.matchedLine) compData.line = activeComp.matchedLine;

  openInEditor(compData);
}

// ── Context menu (right-click → Go to source) ──

let lastContextTarget = null;
document.addEventListener('contextmenu', (e) => {
  lastContextTarget = e.target;
}, true);

function handleContextMenu() {
  if (DISABLED) return;
  if (!lastContextTarget) return;

  if (_annotationDirty || _fiberRoots.size === 0) annotateAll();

  const comp = getSourceFromAnnotation(lastContextTarget) || getNearestComponent(lastContextTarget);
  if (!comp) return;

  readSource(
    `${fullPath(comp.fileName)}`, comp.line, 0, comp.hints,
    (resp) => {
      const line = resp?.targetLine || comp.line;
      openInEditor({ name: comp.name, fileName: comp.fileName, line, col: comp.col || 0 });
    }
  );
}
