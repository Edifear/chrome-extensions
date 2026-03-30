const NATIVE_HOST = 'com.react_goto_component.open_in_vscode';
const APP_VERSION = '1.0';

chrome.runtime.onInstalled.addListener(async () => {
  const { appVersion } = await chrome.storage.local.get('appVersion');
  if (appVersion != null && appVersion !== APP_VERSION) {
    await chrome.storage.local.set({ appVersion: APP_VERSION });
    chrome.runtime.reload();
    return;
  }
  await chrome.storage.local.set({ appVersion: APP_VERSION });
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
  const cacheKey = `${origin}${srcPath}`;
  if (sourceMapCache.has(cacheKey)) return sourceMapCache.get(cacheKey);

  try {
    const resp = await fetch(cacheKey);
    if (!resp.ok) { sourceMapCache.set(cacheKey, null); return null; }
    const text = await resp.text();

    // Extract inline source map (data URI)
    const match = text.match(/\/\/[#@]\s*sourceMappingURL=data:[^;]+;base64,(.+)/);
    if (!match) { sourceMapCache.set(cacheKey, null); return null; }

    const json = JSON.parse(atob(match[1]));
    const lineMap = buildLineMap(json.mappings);

    // Build reverse: originalLine -> [generatedLines]
    const origToGen = new Map();
    for (const [gen, info] of lineMap) {
      const key = info.origLine;
      if (!origToGen.has(key)) origToGen.set(key, []);
      origToGen.get(key).push(gen);
    }

    const result = { lineMap, origToGen, sources: json.sources || [] };
    sourceMapCache.set(cacheKey, result);

    // Evict oldest if cache too large
    if (sourceMapCache.size > MAX_CACHE) {
      const first = sourceMapCache.keys().next().value;
      sourceMapCache.delete(first);
    }

    return result;
  } catch {
    sourceMapCache.set(cacheKey, null);
    return null;
  }
}

// Given a _debugSource line (claimed original), verify/correct it via source map.
// The source map maps generatedLine -> originalLine.
// _debugSource should already be in original coordinates, but if the file was edited
// after compilation, the line might be stale. The source map's reverse mapping can
// confirm which generated lines map to this original line.
function correctLineViaSourceMap(sm, claimedLine) {
  if (!sm) return claimedLine;

  // Check if the claimed line exists as an original line in the map
  if (sm.origToGen.has(claimedLine)) return claimedLine; // confirmed correct

  // Line not found — might be stale. Find the closest original line.
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
    const filePath = `${msg.projectRoot}${comp.fileName}:${comp.line}:${comp.col}`;
    chrome.storage.local.get({ editor: '/usr/local/bin/code', editorArgs: ['--goto'] }, (settings) => {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        cmd: 'open',
        file: filePath,
        editor: settings.editor,
        editorArgs: settings.editorArgs
      }, () => {
        if (chrome.runtime.lastError) {
          console.error('Native messaging error:', chrome.runtime.lastError.message);
        }
      });
    });
  }

  if (msg.type === 'READ_SOURCE') {
    // Try source map resolution, then send to native host
    const srcPath = msg.projectRoot ? msg.file.replace(msg.projectRoot, '') : null;

    resolveSourceMap(msg.origin, srcPath).then(sm => {
      const correctedLine = correctLineViaSourceMap(sm, msg.line);

      chrome.runtime.sendNativeMessage(NATIVE_HOST, {
        cmd: 'read',
        file: msg.file,
        line: correctedLine,
        context: msg.context || 5,
        hints: msg.hints || []
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
        hints: msg.hints || []
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
