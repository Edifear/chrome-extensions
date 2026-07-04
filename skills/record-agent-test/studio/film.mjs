// Film pass (SPEC §3): interprets the action journal directly and produces a
// human-like annotated demo video + exact per-scene timestamps.
//
//   node studio/film.mjs --journal .run/journal.json --out ~/Recordings/<flow>/
//
// Env: HEADLESS (default 1), PERSONA (calm | snappy).
//
// Writes <out>/recording.webm and <out>/scenes.json. scenes.json is stamped
// DURING filming from a single hrtime origin captured at screencast.start —
// exact by construction, never desyncs. Exits non-zero if any locator or
// assertion fails: a video of a broken flow must never ship.
import { chromium } from 'playwright';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Motion, seedFromString } from './motion.mjs';
import { chapter, highlightBox, stickyBadge } from './overlays.mjs';
import { resolveTarget, autoCaption } from './locators.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.journal || !args.out) {
  console.error('usage: node studio/film.mjs --journal <path> --out <dir>');
  process.exit(2);
}

const HEADLESS = process.env.HEADLESS !== '0';
const PERSONA = process.env.PERSONA === 'snappy' ? 'snappy' : 'calm';
// Annotation policy (post-review): minimal by default — cards only at intro/
// outro with SHORT titles, a scene chip only when the flow has ≥2 scenes, no
// per-action toasts (the cursor, typing and click ripple narrate actions; the
// --note copy lives in the viewer transcript). ANNOTATE=full restores toasts.
const ANNOTATE_FULL = process.env.ANNOTATE === 'full';

const cap = (s, n) => {
  s = String(s ?? '').trim();
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
};

// The film draws its own cursor instead of screencast.showActions: the
// showActions decorator awaits its `duration` animation on EVERY input event
// (~500 ms per mouse.move/keystroke — measured), which multiplies a 60 fps
// bezier travel into minutes, and with duration:0 it renders nothing at all.
// A DOM cursor following the real (CDP-dispatched) mousemove events records
// perfectly and costs nothing.
async function installCursor(page) {
  await page.evaluate(() => {
    if (window.__studioCursor && document.getElementById('__studio_cursor')) return;
    const c = document.createElement('div');
    c.id = '__studio_cursor';
    c.style.cssText = 'position:fixed;left:-40px;top:-40px;width:24px;height:24px;' +
      'pointer-events:none;z-index:2147483647;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45));';
    c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24">' +
      '<path d="M5 2 L5 19 L9.5 15 L12.5 21.5 L15 20.3 L12 14 L18 14 Z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    window.__studioCursor = c;
    document.addEventListener('mousemove', (e) => {
      c.style.left = `${e.clientX - 4}px`;
      c.style.top = `${e.clientY - 2}px`;
    }, true);
    document.addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;width:8px;height:8px;` +
        'border-radius:50%;border:2.5px solid rgba(56,139,253,.9);pointer-events:none;z-index:2147483646;' +
        'transform:translate(-50%,-50%);transition:width .45s ease-out,height .45s ease-out,opacity .45s ease-out;opacity:.95;';
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => {
        r.style.width = '44px'; r.style.height = '44px'; r.style.opacity = '0';
      });
      setTimeout(() => r.remove(), 600);
    }, true);
  });
}

// Bottom-center caption for the current action (our replacement for the
// showActions toasts — same placement, but with the journal's human copy).
async function actionToast(page, text) {
  return page.screencast.showOverlay(`
    <div style="position:absolute;bottom:20px;left:50%;transform:translateX(-50%);
      max-width:70vw;padding:9px 16px;background:rgba(28,30,38,.92);color:#fff;
      border-radius:8px;font:600 13.5px -apple-system,system-ui,sans-serif;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      box-shadow:0 6px 20px rgba(0,0,0,.4);">${text}</div>
  `);
}
const ACTION_VERBS = new Set(['fill', 'select', 'toggle', 'click']);
const log = (...a) => console.log('[film]', ...a);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- runtime estimate + dwell auto-compression (§3.2) ----------
function estimateRuntime(journal, personaDwell, personaSpeed) {
  const typeAvg = PERSONA === 'snappy' ? 55 : 75;
  let fixedMs = 1000 + 2200 + 2600; // orient breathe + intro + outro cards
  let dwellMs = 0;
  const dwellItems = [];
  for (const e of journal.entries) {
    if (e.verb === 'scene') { dwellMs += 300; continue; } // chip swap only
    if (e.verb === 'assert') { dwellMs += 1900; dwellItems.push([`assert "${e.title}"`, 1900]); continue; }
    if (!ACTION_VERBS.has(e.verb)) continue;
    fixedMs += 550 / personaSpeed; // cursor travel + click, uncompressible
    let d = 250 + 1000; // hover dwell + settle
    if (e.verb === 'fill') {
      const text = String(e.value ?? '');
      fixedMs += text.length * typeAvg;
      d += 275 + (text.split(/\s+/).length / 3) * 200;
    }
    if (e.verb === 'select') d += 600;
    d *= personaDwell;
    dwellMs += d;
    dwellItems.push([autoCaption(e), Math.round(d)]);
  }
  return { fixedMs, dwellMs, dwellItems, totalMs: fixedMs + dwellMs };
}

async function main() {
  const journal = JSON.parse(await readFile(path.resolve(args.journal), 'utf8'));
  const outDir = path.resolve(args.out);
  await mkdir(outDir, { recursive: true });

  const flow = journal.flow || 'flow';
  // Card title = the short humanized slug; the summary sentence is card
  // description material, never a headline.
  const title = cap(flow.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), 40);
  const summary = journal.summary ? cap(journal.summary.replace(/^\w/, (c) => c.toUpperCase()), 90) : '';
  const personaDwell = PERSONA === 'snappy' ? 0.6 : 1.0;
  const personaSpeed = PERSONA === 'snappy' ? 1.5 : 1.0;

  const est = estimateRuntime(journal, personaDwell, personaSpeed);
  let dwellScale = 1;
  // The estimate runs ~15% light (real cursor travel and settles outpace the
  // model), so project it up before comparing against the 25–45 s budget.
  const projectedMs = est.totalMs * 1.15;
  if (projectedMs > 47000) {
    dwellScale = Math.max(0.25, (40000 - est.fixedMs) / (est.dwellMs * personaDwell));
    const biggest = est.dwellItems.sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([n, ms]) => `${n} (~${ms} ms)`).join(', ');
    log(`WARNING: projected runtime ${(projectedMs / 1000).toFixed(1)}s > 47s — ` +
      `compressing dwells ×${dwellScale.toFixed(2)} (largest: ${biggest}). ` +
      `Typing and cursor motion are never compressed.`);
  }

  const browser = await chromium.launch({ headless: HEADLESS });
  // Recorded against a prewarmed session → replay with the same auth state.
  const context = await browser.newContext({
    viewport: journal.viewport || { width: 1280, height: 800 },
    ...(journal.auth?.storageState ? { storageState: journal.auth.storageState } : {}),
  });
  if (journal.auth?.sessionStorage?.length) {
    await context.addInitScript((entries) => {
      const e = entries.find((x) => x.origin === location.origin);
      if (e) for (const { name, value } of e.items || []) sessionStorage.setItem(name, value);
    }, journal.auth.sessionStorage);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const motion = new Motion(page, { seed: seedFromString(flow), persona: PERSONA, dwellScale });
  // Cards and callout holds are pauses too — snappy (and the runtime budget)
  // compress them like any other dwell.
  const hold = (ms) => Math.round(ms * personaDwell * dwellScale);

  const scenes = [];
  const scenesPath = path.join(outDir, 'scenes.json');
  const tmpWebm = path.join(outDir, '.recording.tmp.webm');
  const finalWebm = path.join(outDir, 'recording.webm');
  let t0 = null;
  const now = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e7) / 100; // s, 2 decimals
  const pushScene = async (kind, sceneTitle, assertion = null, t = now()) => {
    scenes.push({ t, kind, title: sceneTitle, assertion });
    await writeFile(`${scenesPath}.tmp`, JSON.stringify(scenes, null, 2), 'utf8');
    await rename(`${scenesPath}.tmp`, scenesPath);
  };

  let exitCode = 0;
  let badge = null;
  try {
    await page.goto(journal.url);
    await page.waitForLoadState('networkidle');
    await installCursor(page);

    await page.screencast.start({ path: tmpWebm, size: journal.viewport });
    t0 = process.hrtime.bigint();
    await page.waitForTimeout(hold(1000)); // viewers orient before the first annotation

    // Intro card: short title, summary as the small description line.
    await pushScene('chapter', title);
    await chapter(page, title, summary, hold(2000));

    // A scene chip only earns its pixels when there are scenes to distinguish.
    const useChip = journal.entries.filter((e) => e.verb === 'scene').length >= 2;
    const assertLines = [];
    for (const e of journal.entries) {
      if (e.verb === 'scene') {
        await pushScene('chapter', e.title);
        if (useChip) {
          if (badge) { await badge.dispose().catch(() => {}); badge = null; }
          badge = await stickyBadge(page, esc(cap(e.title, 36)), 'top-right', 'info');
          await page.waitForTimeout(300); // let the swap register on screen
        }
        continue;
      }

      if (e.verb === 'assert') {
        const loc = page.getByTestId(e.testid);
        const assertion = `${e.testid}${e.contains ? ` contains ${JSON.stringify(e.contains)}` : ' visible'}`;
        try {
          await loc.waitFor({ state: 'visible', timeout: 10000 });
          if (e.contains) {
            const deadline = Date.now() + 10000;
            let text = '';
            for (;;) {
              text = (await loc.innerText().catch(() => '')) || '';
              if (text.includes(e.contains)) break;
              if (Date.now() > deadline) throw new Error(
                `text ${JSON.stringify(text.slice(0, 120))} does not contain ${JSON.stringify(e.contains)}`);
              await page.waitForTimeout(200);
            }
          }
        } catch (err) {
          throw new Error(`assertion at journal entry ${e.i} ("${e.title}") never held: ${err.message}`);
        }
        await pushScene('assert', e.title || `${e.testid} verified`, assertion);
        // Highlight the consequence (§3.3): one element — a thin green outline
        // with a small "✓ <title>" tag. The asserted content is INSIDE the box;
        // repeating it in a caption was noise.
        const tag = `✓ ${esc(cap(e.title || e.testid, 36))}`;
        await highlightBox(page, loc, tag, { color: 'rgb(31,136,61)', duration: hold(1800) });
        await page.waitForTimeout(hold(1600));
        assertLines.push(cap(e.title || e.testid, 36));
        continue;
      }

      if (!ACTION_VERBS.has(e.verb)) continue;

      // Sync rules (§3.2): resolve → wait visible → scroll → human primitive → settle.
      const loc = await resolveTarget(page, e.target);
      try {
        await loc.waitFor({ state: 'visible', timeout: 10000 });
      } catch {
        throw new Error(`journal entry ${e.i} (${e.verb}): target never became visible — page changed since drive?`);
      }
      await installCursor(page); // survive any navigation the last action caused
      await motion.humanScroll(loc);
      const before = await motion.bodyText();
      const caption = e.note || autoCaption(e);
      await pushScene('action', caption);
      // Minimal mode: no per-action toast — the caption still names this
      // moment in scenes.json for the viewer's timeline and transcript.
      const toast = ANNOTATE_FULL ? await actionToast(page, esc(cap(caption, 48))) : null;
      try {
        if (e.verb === 'fill') await motion.humanType(loc, e.value);
        else if (e.verb === 'select') await motion.humanSelect(loc, e.option);
        else await motion.humanClick(loc); // toggle + click: plain human click
      } finally {
        await toast?.dispose().catch(() => {});
      }
      await motion.settle(before);
    }

    // Outro card: short verified title + one line per assertion.
    if (badge) { await badge.dispose().catch(() => {}); badge = null; }
    await pushScene('chapter', `✓ ${title}`);
    await chapter(page, `✓ ${title}`,
      assertLines.length ? assertLines.map((l) => `✓ ${l}`).join('  ·  ') : 'Flow completed', hold(2400));

    await page.screencast.stop();
    await rename(tmpWebm, finalWebm);
    log(`filmed ${scenes.length} scenes → ${path.relative(process.cwd(), finalWebm)} ` +
      `(${now().toFixed(1)}s, persona=${PERSONA}${dwellScale < 1 ? `, dwellScale=${dwellScale.toFixed(2)}` : ''})`);
  } catch (err) {
    exitCode = 1;
    console.error('[film] FAILED:', err.message);
    try { await page.screencast.stop(); } catch {}
    // Leave .recording.tmp.webm for diagnosis; never ship it as recording.webm.
  } finally {
    await browser.close().catch(() => {});
  }
  process.exit(exitCode);
}

main().catch((e) => { console.error('[film] fatal:', e); process.exit(1); });
