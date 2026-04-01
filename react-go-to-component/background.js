const NATIVE_HOST = 'com.react_goto_component.open_in_editor';
const APP_VERSION = '1.1';

chrome.runtime.onInstalled.addListener(async () => {
  const { appVersion } = await chrome.storage.local.get('appVersion');
  if (appVersion != null && appVersion !== APP_VERSION) {
    await chrome.storage.local.set({ appVersion: APP_VERSION });
    chrome.runtime.reload();
    return;
  }
  await chrome.storage.local.set({ appVersion: APP_VERSION });

  chrome.contextMenus.create({
    id: 'react-goto-source',
    title: 'Go to source',
    contexts: ['all'],
    documentUrlPatterns: ['http://localhost:*/*']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'react-goto-source' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'CONTEXT_MENU_GOTO' });
  }
});

// ── Minimal source map resolver ──

const sourceMapCache = new Map();
const MAX_CACHE = 30;

const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_DECODE = Object.fromEntries([...VLQ].map((c, i) => [c, i]));

function decodeVLQ(str) {
  const out = [];
  let val = 0, shift = 0;
  for (const ch of str) {
    const digit = VLQ_DECODE[ch];
    val += (digit & 31) << shift;
    shift += 5;
    if (!(digit & 32)) {
      out.push(val & 1 ? -(val >> 1) : val >> 1);
      val = 0; shift = 0;
    }
  }
  return out;
}

function buildLineMap(mappings) {
  // Map<generatedLine (1-based), { origLine (1-based), srcIdx }>
  const map = new Map();
  let srcIdx = 0, origLine = 0, origCol = 0;
  mappings.split(';').forEach((group, genIdx) => {
    if (!group) return;
    let genCol = 0;
    for (const seg of group.split(',')) {
      if (!seg) continue;
      const v = decodeVLQ(seg);
      genCol += v[0];
      if (v.length >= 4) {
        srcIdx += v[1];
        origLine += v[2];
        origCol += v[3];
        if (!map.has(genIdx + 1)) {
          map.set(genIdx + 1, { origLine: origLine + 1, srcIdx });
        }
      }
    }
  });
  return map;
}

async function resolveSourceMap(origin, srcPath) {
  if (!origin || !srcPath) return null;
  // Only fetch JS/map files from the dev server
  if (!/\.(js|mjs|jsx|ts|tsx)(\.map)?$/.test(srcPath.split('?')[0])) return null;
  const cacheKey = `${origin}${srcPath}`;
  if (sourceMapCache.has(cacheKey)) return sourceMapCache.get(cacheKey);

  // Try multiple origins: the page origin may differ from the Vite dev server
  const urls = [`${origin}${srcPath}`];
  // Vite dev server typically on port 3000; page may be on a different port (e.g. Django 8000)
  try {
    const pageOrigin = new URL(origin);
    if (pageOrigin.port !== '3000') {
      urls.unshift(`${pageOrigin.protocol}//${pageOrigin.hostname}:3000${srcPath}`);
    }
  } catch {}

  for (const url of urls) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const text = await resp.text();

      // Extract inline source map (data URI)
      const match = text.match(/\/\/[#@]\s*sourceMappingURL=data:[^;]+;base64,(.+)/);
      if (!match) continue;

      const json = JSON.parse(atob(match[1]));
      const lineMap = buildLineMap(json.mappings);

      // Build reverse: originalLine -> [generatedLines]
      const origToGen = new Map();
      for (const [gen, info] of lineMap) {
        const key = info.origLine;
        if (!origToGen.has(key)) origToGen.set(key, []);
        origToGen.get(key).push(gen);
      }

      // Store served file lines for _debugSource → original line resolution
      const servedLines = text.split('\n');

      const result = { lineMap, origToGen, servedLines, sources: json.sources || [] };
      sourceMapCache.set(cacheKey, result);

      // Evict oldest if cache too large
      if (sourceMapCache.size > MAX_CACHE) {
        const first = sourceMapCache.keys().next().value;
        sourceMapCache.delete(first);
      }

      return result;
    } catch {
      continue;
    }
  }

  sourceMapCache.set(cacheKey, null);
  return null;
}

// Map a _debugSource line number to the correct original source line.
// _debugSource lines are in "Babel-input" coordinates (original + Vite preamble),
// NOT original source coordinates. We find the jsxDEV __source reference in the
// served file and use the source map to get the true original line.
function correctLineViaSourceMap(sm, claimedLine) {
  if (!sm) return claimedLine;

  // Strategy 1: Search the served file for "lineNumber: X" to find which
  // generated line contains this __source reference, then use the source map.
  if (sm.servedLines) {
    const needle = 'lineNumber: ' + claimedLine;
    for (let i = 0; i < sm.servedLines.length; i++) {
      if (sm.servedLines[i].includes(needle)) {
        // Walk backwards to find the nearest mapped generated line
        // (the jsxDEV call is usually a few lines before lineNumber: X)
        for (let j = i; j >= Math.max(0, i - 5); j--) {
          const mapping = sm.lineMap.get(j + 1);
          if (mapping) return mapping.origLine;
        }
      }
    }
  }

  // Strategy 2: Compute the Babel preamble offset from the source map.
  // Find the first mapping to origLine=1 — that generated line tells us the served preamble.
  // Then search near that line for the actual Babel preamble by looking for the first import.
  if (sm.servedLines) {
    let servedPreamble = 0;
    for (const [gen, info] of sm.lineMap) {
      if (info.origLine === 1) { servedPreamble = gen - 1; break; }
    }
    if (servedPreamble > 0) {
      // Count the Babel-added lines (e.g. $RefreshSig$ calls) that appear
      // between the served preamble start and the first original import
      let babelExtra = 0;
      for (let i = 0; i < servedPreamble; i++) {
        const line = sm.servedLines[i];
        if (line && (line.includes('$RefreshSig$') || line.includes('$RefreshReg$')) && !line.includes('import')) {
          babelExtra++;
        }
      }
      const preambleOffset = servedPreamble + babelExtra;
      const corrected = claimedLine - preambleOffset;
      if (corrected > 0 && sm.origToGen.has(corrected)) return corrected;
    }
  }

  // Strategy 3: Legacy fallback — check if claimed line exists as original
  if (sm.origToGen.has(claimedLine)) return claimedLine;

  // Find closest original line
  let closest = claimedLine, minDist = Infinity;
  for (const origLine of sm.origToGen.keys()) {
    const dist = Math.abs(origLine - claimedLine);
    if (dist < minDist) { minDist = dist; closest = origLine; }
  }
  return closest;
}

// ── Message handling ──

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_COMPONENT') {
    const comp = msg.component;
    if (!comp) return;
    // Validate fileName doesn't escape projectRoot via path traversal
    const normalizedName = comp.fileName.replace(/\.\.\//g, '');
    const filePath = `${msg.projectRoot}${normalizedName}:${comp.line}:${comp.col}`;
    chrome.storage.local.get({ editor: '/usr/local/bin/code', editorArgs: ['--goto'] }, (settings) => {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        cmd: 'open',
        file: filePath,
        editor: settings.editor,
        editorArgs: settings.editorArgs,
        projectRoot: msg.projectRoot
      }, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp || { success: false, error: 'No response from native host' });
        }
      });
    });
    return true;
  }

  if (msg.type === 'READ_SOURCE') {
    // Try source map resolution, then send to native host
    const srcPath = msg.projectRoot ? msg.file.replace(msg.projectRoot, '') : null;

    resolveSourceMap(msg.origin, srcPath).then(sm => {
      const correctedLine = correctLineViaSourceMap(sm, msg.line);

      // When source map corrected the line, we have the exact original line —
      // skip hint matching to prevent false overrides (e.g. "progress" matching progressRed).
      // Only use hints when source map couldn't help (correctedLine unchanged).
      const smWorked = sm && correctedLine !== msg.line;

      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        cmd: 'read',
        file: msg.file,
        line: correctedLine,
        context: msg.context || 5,
        hints: smWorked ? [] : (msg.hints || []),
        projectRoot: msg.projectRoot
      }, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      });
    }).catch(() => {
      // Source map failed — proceed with original line
      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        cmd: 'read',
        file: msg.file,
        line: msg.line,
        context: msg.context || 5,
        hints: msg.hints || [],
        projectRoot: msg.projectRoot
      }, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp);
        }
      });
    });

    return true; // keep sendResponse channel open for async reply
  }
});
