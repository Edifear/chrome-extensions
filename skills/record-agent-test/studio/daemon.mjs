// Agent Flow Studio — persistent session daemon (SPEC §2.2).
//
// Holds the ONE warm CDP connection to the recorder's browser and executes
// verbs sent by the thin client (session.mjs) over a unix socket. Every verb
// appends to the action journal (the film's source of truth) and updates
// .run/progress.json. `finish` orchestrates: stop recorder → enrich spec →
// assert pass ∥ film pass → package → frame check.
//
// This is the only studio file that imports playwright.
import { chromium } from 'playwright';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, existsSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { mkdir, rm, readFile, writeFile, copyFile, rename, access, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { captureSnapshot, formatSnapshot, diffSnapshot } from './snapshot.mjs';
import { resolveTarget, autoCaption } from './locators.mjs';
import { enrichTest } from '../postprocess.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');

const formPort = Number(process.env.FORM_PORT || 5188);
const cfg = {
  runDir: path.join(ROOT, '.run'),
  formPort,
  cdpPort: Number(process.env.CDP_PORT || 9333),
  formUrl: process.env.FORM_URL || `http://localhost:${formPort}/`,
  outFile: path.resolve(ROOT, process.env.OUT_FILE || 'tests/generated.spec.ts'),
  headless: process.env.HEADLESS || '1',
  pace: Number(process.env.PACE_MS || 450),
  // Minimum gap between consecutive DOM events. Capture correctness does not
  // need more: the injected recorder commits a pending action on the next
  // input event regardless of spacing (verified in the antd-lab).
  minGap: Number(process.env.STEP_GAP_MS || 200),
  idleMs: Number(process.env.RECORDER_IDLE_TIMEOUT_MS || 1800000),
  socket: process.env.STUDIO_SOCKET
    ? path.resolve(ROOT, process.env.STUDIO_SOCKET)
    : path.join(ROOT, '.run', 'session.sock'),
  // Prewarmed auth (md-session contract): a dir holding storageState.json +
  // session.json, or a direct path to a storageState.json.
  authState: process.env.AUTH_STATE ? path.resolve(ROOT, process.env.AUTH_STATE) : null,
  // Where finished packages land. Outside the repo by default — recordings
  // are review artifacts, not source. Specs still land in tests/ (replay
  // needs this repo's Playwright config).
  recordingsDir: process.env.RECORDINGS_DIR
    ? path.resolve(ROOT, process.env.RECORDINGS_DIR)
    : path.join(os.homedir(), 'Recordings'),
  formUrlExplicit: !!process.env.FORM_URL,
};
cfg.readyFile = path.join(cfg.runDir, 'recorder-ready');
cfg.stopFile = path.join(cfg.runDir, 'stop');
cfg.sessionFile = path.join(cfg.runDir, 'session.json');
cfg.journalFile = path.join(cfg.runDir, 'journal.json');
cfg.progressFile = path.join(cfg.runDir, 'progress.json');
cfg.serverLog = path.join(cfg.runDir, 'server.log');
cfg.recorderLog = path.join(cfg.runDir, 'recorder.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- state ----------
const state = {
  browser: null,
  page: null,
  recorderPid: null,
  serverPid: null,
  prevSnap: null,           // parsed snapshot for diffing (§2.3)
  journal: null,
  logLines: [],
  finishing: false,
  idleTimer: null,
  lastActionAt: 0,
};

function log(...a) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${a.join(' ')}`;
  state.logLines.push(line);
  console.log(line);
}

// ---------- atomic file writes (§2.2 crash safety) ----------
async function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}
const writeJournal = () => atomicWrite(cfg.journalFile, JSON.stringify(state.journal, null, 2));

// ---------- progress (§6) ----------
const progress = {
  flow: null,
  phase: 'drive',
  phases: {
    drive: { state: 'running', steps: 0, ms: 0, startedAt: new Date().toISOString() },
    assert: { state: 'pending' },
    film: { state: 'pending' },
    package: { state: 'pending' },
  },
};
async function saveProgress() {
  await atomicWrite(cfg.progressFile, JSON.stringify(progress, null, 2));
}

// ---------- process helpers ----------
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
function killPid(pid) {
  if (isAlive(pid)) { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
function spawnDetached(script, env, logFile) {
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  return child.pid;
}
function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}
async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await httpOk(url)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${url}`);
}
async function waitForFile(file, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${file} — check ${path.relative(ROOT, cfg.recorderLog)}`);
}
function run(cmd, args, { env = {}, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, out: String(err) }); });
  });
}

// ---------- CDP connection (made ONCE at start) ----------
async function connectCdp() {
  let lastErr;
  for (let i = 0; i < 40; i++) {
    try {
      state.browser = await chromium.connectOverCDP(`http://localhost:${cfg.cdpPort}`);
      break;
    } catch (e) { lastErr = e; await sleep(300); }
  }
  if (!state.browser) throw lastErr;
  for (let i = 0; i < 40; i++) {
    const ctx = state.browser.contexts()[0];
    const p = ctx?.pages().find((pg) => pg.url().startsWith('http')) || ctx?.pages()[0];
    if (p) {
      // Fail fast on bad targets: Playwright's 30 s default would outlive the
      // client's own timeout; 5 s is plenty for a live, already-rendered page.
      p.setDefaultTimeout(5000);
      state.page = p;
      return;
    }
    await sleep(300);
  }
  throw new Error('could not find a page over CDP');
}

// ---------- snapshots ----------
async function snap({ full = false } = {}) {
  const data = await captureSnapshot(state.page);
  const text = full || !state.prevSnap ? formatSnapshot(data) : diffSnapshot(state.prevSnap, data);
  state.prevSnap = data;
  return text;
}
async function fullSnapSafe() {
  try {
    const data = await captureSnapshot(state.page);
    state.prevSnap = data;
    return formatSnapshot(data);
  } catch (e) { return `(snapshot failed: ${e.message})`; }
}

// ---------- journal ----------
function journalEntry(entry) {
  entry.i = state.journal.entries.length + 1;
  state.journal.entries.push(entry);
  return entry;
}

// ---------- verb execution (recorder-fidelity bodies from old session.mjs) ----------
// Recorder pacing, confirmation-based: the honest "recorder is done with the
// previous action" signal is the generated spec itself — codegen's RecorderApp
// flushes the captured action to OUT_FILE (throttled ~250 ms) only after it has
// processed the event and run the delayed default action. So instead of fixed
// PACE_MS sleeps we watch the file: proceed the moment it changes, with PACE_MS
// as the fallback cap (an action that emits no spec line degrades to the old
// behavior, never worse).
async function specStat() {
  try { const s = await stat(cfg.outFile); return `${s.mtimeMs}:${s.size}`; }
  catch { return null; }
}
async function waitForSpecFlush(baseline, capMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < capMs) {
    if ((await specStat()) !== baseline) return Date.now() - t0;
    await sleep(25);
  }
  return Date.now() - t0;
}

// Pace as debt: enforce only a small human-plausible gap between DOM events.
// Codegen does not need more — a pending click is committed by the NEXT input
// event, so spacing has no effect on capture correctness (lab-verified). Agent
// think-time between turns covers the gap entirely; in-plan steps pay ≤minGap.
async function payPaceDebt() {
  if (!state.lastActionAt) return;
  const gap = Date.now() - state.lastActionAt;
  if (gap < cfg.minGap) await sleep(cfg.minGap - gap);
}

async function performAction(verb, args) {
  const page = state.page;
  const tPace = Date.now();
  await payPaceDebt();
  const paceMs = Date.now() - tPace;
  const baseline = await specStat();
  const started = process.hrtime.bigint();
  let target, extra = {};
  switch (verb) {
    case 'fill': {
      if (!args.label || args.value === undefined) throw new Error('fill needs --label and --value');
      target = { kind: 'label', label: args.label };
      const loc = await resolveTarget(page, target);
      // AntD DatePicker (rc-picker): the input is readonly until focused, and a
      // programmatic fill never commits (blur reverts). rc-picker parses the
      // text on input events and commits on Enter — so click (typing mode) →
      // fill → Enter does the whole job in one verb, and codegen records
      // fill + press('Enter') with robust locators (no calendar-cell click).
      const isPicker = await loc.evaluate((el) => !!el.closest('.ant-picker')).catch(() => false);
      if (isPicker) {
        await loc.click();
        await loc.fill(String(args.value));
        await loc.press('Enter');
        extra = { value: String(args.value), commit: 'enter' };
      } else {
        await loc.fill(String(args.value));
        extra = { value: String(args.value) };
      }
      break;
    }
    case 'select': {
      if (!args.label || args.option === undefined) throw new Error('select needs --label and --option');
      target = { kind: 'label', label: args.label };
      const loc = await resolveTarget(page, target);
      await loc.click(); // anchor the recorder to the <select> before setting the value
      try { await loc.selectOption({ label: String(args.option) }); }
      catch { await loc.selectOption(String(args.option)); }
      extra = { option: String(args.option) };
      break;
    }
    case 'toggle': {
      if (!args.label) throw new Error('toggle needs --label');
      target = { kind: 'label', label: args.label };
      const loc = await resolveTarget(page, target);
      await loc.click(); // plain click, not .check() — recorder delays the default action
      await sleep(300);
      if (!(await loc.isChecked().catch(() => true))) {
        await loc.focus();
        await page.keyboard.press('Space');
      }
      break;
    }
    case 'click': {
      if (args.selector) target = { kind: 'css', selector: args.selector };
      else if (args.text) target = { kind: 'text', text: args.text };
      else if (args.name) target = { kind: 'button', name: args.name };
      else throw new Error('click needs --name, --selector, or --text');
      const loc = await resolveTarget(page, target);
      await loc.click();
      break;
    }
    default:
      throw new Error(`unknown action verb: ${verb}`);
  }
  const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  state.lastActionAt = Date.now();
  // Clicks only: the recorder delays a click's default action, so an immediate
  // snapshot can read a stale DOM (the "modal still hidden" false negative).
  // The spec flush is the WRONG signal here — codegen holds a click in its
  // navigation-attribution window until the next input event. The right signal
  // is the DOM itself: wait for mutation activity to go quiet (120 ms with no
  // mutations after the first one), capped at PACE_MS.
  let settleMs = 0;
  if (verb === 'click') {
    const t = Date.now();
    await page.evaluate(({ quiet, cap }) => new Promise((resolve) => {
      let quietTimer = null;
      const capTimer = setTimeout(done, cap);
      const mo = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(done, quiet);
      });
      function done() { mo.disconnect(); clearTimeout(capTimer); clearTimeout(quietTimer); resolve(); }
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      // No mutation at all within `quiet`×2 → the click changed nothing; go.
      quietTimer = setTimeout(done, quiet * 2);
    }), { quiet: 120, cap: cfg.pace }).catch(() => sleep(cfg.pace));
    settleMs = Date.now() - t;
  }
  state.pendingBaseline = baseline;
  const entry = journalEntry({ verb, target, ...extra, ...(args.note ? { note: args.note } : {}), ms, paceMs, settleMs });
  progress.phases.drive.steps += 1;
  progress.phases.drive.ms += ms;
  return entry;
}

// Codegen attributes a navigation within ~5 s of a click/press/fill to that
// action (recorderSignalProcessor's signalThreshold) and emits no goto line —
// postprocess.mjs re-injects it from the journal, so we don't wait the window
// out. We DO wait a beat for the injected recorder's throttled capture to
// flush, so navigating away can't lose the PRECEDING action.
const CAPTURE_FLUSH_MS = 1000;

async function performGoto(args) {
  if (!args.url) throw new Error('goto needs --url');
  let target;
  try { target = new URL(String(args.url)); }
  catch { throw new Error(`goto: not a valid absolute URL: ${JSON.stringify(args.url)}`); }
  let warn = '';
  try {
    const sessionOrigin = new URL(cfg.formUrl).origin;
    if (target.origin !== sessionOrigin) {
      warn = `leaving the session origin (${sessionOrigin} → ${target.origin}) — ` +
        `auth cookies/localStorage are origin-scoped and will NOT apply there`;
    }
  } catch {}
  const sinceLast = Date.now() - state.lastActionAt;
  if (state.lastActionAt && sinceLast < CAPTURE_FLUSH_MS) {
    if (state.pendingBaseline !== undefined) {
      await waitForSpecFlush(state.pendingBaseline, CAPTURE_FLUSH_MS - sinceLast);
    } else {
      await sleep(CAPTURE_FLUSH_MS - sinceLast);
    }
  }
  state.pendingBaseline = undefined;
  const started = process.hrtime.bigint();
  await state.page.goto(target.href, { timeout: 30000 });
  // Same settle the film pass uses; best-effort — busy apps may never go idle.
  await state.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
  state.lastActionAt = Date.now();
  const entry = journalEntry({ verb: 'goto', url: target.href, ...(args.note ? { note: args.note } : {}), ms });
  progress.phases.drive.steps += 1;
  progress.phases.drive.ms += ms;
  return { entry, warn };
}

async function performAssert(args) {
  if (!args.testid) throw new Error('assert needs --testid');
  const loc = state.page.getByTestId(args.testid);
  const deadline = Date.now() + 10000;
  await loc.waitFor({ state: 'visible', timeout: 10000 });
  if (args.contains) {
    let text = '';
    while (Date.now() < deadline) {
      text = (await loc.innerText().catch(() => '')) || '';
      if (text.includes(args.contains)) break;
      await sleep(200);
    }
    if (!text.includes(args.contains)) {
      throw new Error(`assert failed: testid="${args.testid}" text ${JSON.stringify(text)} ` +
        `does not contain ${JSON.stringify(args.contains)}`);
    }
  }
  const entry = { verb: 'assert', testid: args.testid };
  if (args.contains) entry.contains = args.contains;
  entry.title = args.title || `${args.testid} verified`;
  journalEntry(entry);
  return entry;
}

// Shared post-action response: persist, snapshot, and report the per-layer
// timing breakdown (action = Playwright work, pace = recorder pacing debt,
// settle = post-click DOM wait, snapshot = capture + diff).
async function actionResponse(prefix, e) {
  await writeJournal(); await saveProgress();
  const t = Date.now();
  const snapshot = await snap();
  const parts = [`action ${e.ms} ms`];
  if (e.paceMs) parts.push(`pace ${e.paceMs} ms`);
  if (e.settleMs) parts.push(`settle ${e.settleMs} ms`);
  parts.push(`snapshot ${Date.now() - t} ms`);
  return { result: `${prefix} (${parts.join(' · ')})`, snapshot };
}

// ---------- verbs ----------
const PLAN_VERBS = new Set(['fill', 'select', 'toggle', 'click', 'goto', 'scene', 'assert']);

const verbs = {
  async ping() { return { result: 'pong' }; },

  async start() {
    try {
      return await verbs._startSession();
    } catch (err) {
      // A daemon that failed to start a session is useless and would block the
      // next `start` with exit 7 — respond with the error, then exit.
      killPid(state.recorderPid);
      killPid(state.serverPid);
      scheduleExit(1);
      throw err;
    }
  },

  async _startSession() {
    await mkdir(cfg.runDir, { recursive: true });
    for (const f of [cfg.readyFile, cfg.stopFile]) if (existsSync(f)) await rm(f).catch(() => {});

    await loadAuthState();

    if (!(await httpOk(cfg.formUrl))) {
      log(`starting static server on :${cfg.formPort}`);
      state.serverPid = spawnDetached('server.mjs', sharedEnv(), cfg.serverLog);
      await waitForHttp(cfg.formUrl);
    } else {
      log(`form already reachable at ${cfg.formUrl} — not starting a server`);
    }

    log(`starting recorder (headless=${cfg.headless === '1'}) — CDP on :${cfg.cdpPort}`);
    state.recorderPid = spawnDetached('recorder.mjs', sharedEnv(), cfg.recorderLog);
    await waitForFile(cfg.readyFile);
    await connectCdp();
    await state.page.bringToFront().catch(() => {});

    const viewport = state.page.viewportSize() || { width: 1280, height: 800 };
    state.journal = {
      flow: null,
      url: cfg.formUrl,
      startedAt: new Date().toISOString(),
      viewport,
      ...(cfg.storageStateFile ? {
        auth: {
          storageState: cfg.storageStateFile,
          sessionStorage: cfg.manifest?.sessionStorage ?? [],
        },
      } : {}),
      entries: [],
      summary: null,
    };
    await writeJournal();
    await saveProgress();
    await writeSessionFile();

    const snapshot = await snap({ full: true });
    return { result: `recorder ready — writing ${path.relative(ROOT, cfg.outFile)} live`, snapshot };
  },

  async snapshot(args) {
    return { result: 'snapshot', snapshot: await snap({ full: !!args.full }) };
  },

  async fill(args) {
    return actionResponse(`filled "${args.label}" = ${JSON.stringify(args.value)}`, await performAction('fill', args));
  },
  async select(args) {
    return actionResponse(`selected ${JSON.stringify(args.option)} in "${args.label}"`, await performAction('select', args));
  },
  async toggle(args) {
    return actionResponse(`toggled "${args.label}"`, await performAction('toggle', args));
  },
  async click(args) {
    return actionResponse('clicked', await performAction('click', args));
  },

  async goto(args) {
    const { entry, warn } = await performGoto(args);
    await writeJournal(); await saveProgress();
    // Navigation replaces the whole page — a diff against the old one is noise.
    return {
      result: `navigated to ${entry.url} (${entry.ms} ms)` + (warn ? `\nWARNING: ${warn}` : ''),
      snapshot: await snap({ full: true }),
    };
  },

  async scene(args) {
    if (!args.title) throw new Error('scene needs --title');
    journalEntry({ verb: 'scene', title: args.title, ...(args.desc ? { desc: args.desc } : {}) });
    await writeJournal();
    return { result: `scene declared: ${JSON.stringify(args.title)}` };
  },

  async assert(args) {
    const e = await performAssert(args);
    await writeJournal();
    return {
      result: `assert OK: testid="${e.testid}"${e.contains ? ` contains ${JSON.stringify(e.contains)}` : ''}`,
      snapshot: await snap(),
    };
  },

  // Batch verb (§2.4): sequential, PACE_MS between steps, stop at first failure.
  async do(args) {
    let plan;
    try { plan = typeof args.plan === 'string' ? JSON.parse(args.plan) : args.plan; }
    catch (e) { throw new Error(`could not parse --plan JSON: ${e.message}`); }
    if (!Array.isArray(plan) || !plan.length) throw new Error('do needs --plan (a non-empty JSON array)');
    const lines = [];
    for (let i = 0; i < plan.length; i++) {
      const step = plan[i];
      if (!PLAN_VERBS.has(step.verb)) {
        throw new Error(`step ${i} has verb ${JSON.stringify(step.verb)} — allowed in a plan: ${[...PLAN_VERBS].join(', ')}`);
      }
      try {
        if (step.verb === 'scene') {
          journalEntry({ verb: 'scene', title: step.title, ...(step.desc ? { desc: step.desc } : {}) });
          lines.push(`${i}: scene ${JSON.stringify(step.title)}`);
        } else if (step.verb === 'assert') {
          const e = await performAssert(step);
          lines.push(`${i}: assert OK testid="${e.testid}"`);
        } else if (step.verb === 'goto') {
          const { entry, warn } = await performGoto(step);
          lines.push(`${i}: goto ${entry.url} OK (${entry.ms} ms)${warn ? ` — WARNING: ${warn}` : ''}`);
        } else {
          const e = await performAction(step.verb, step);
          lines.push(`${i}: ${step.verb} OK (action ${e.ms}${e.paceMs ? ` · pace ${e.paceMs}` : ''}${e.settleMs ? ` · settle ${e.settleMs}` : ''} ms)`);
        }
      } catch (err) {
        await writeJournal(); await saveProgress(); // keep the successful prefix
        const e = new Error(`step ${i} (${step.verb}) failed: ${err.message}\ncompleted before failure:\n${lines.join('\n') || '(none)'}`);
        e.keepSnapshotFull = true;
        throw e;
      }
    }
    await writeJournal(); await saveProgress();
    const t = Date.now();
    const snapshot = await snap();
    return { result: `plan complete (${plan.length} steps · snapshot ${Date.now() - t} ms)\n${lines.join('\n')}`, snapshot };
  },

  async status() {
    return { result: JSON.stringify(progress, null, 2) };
  },

  async finish(args, sendEvt) {
    if (state.finishing) throw new Error('finish already running');
    state.finishing = true;
    try {
      return await finishPipeline(args, sendEvt);
    } catch (err) {
      // If we failed before the recorder was stopped (e.g. the --assert-*
      // sugar didn't hold), the session is still fully drivable — let the
      // agent fix the page state and call finish again.
      if (state.recorderPid) state.finishing = false;
      throw err;
    }
  },

  // Abort/teardown without the pipeline.
  async stop() {
    log('stop requested — tearing down without packaging');
    await stopRecorder();
    if (state.serverPid) killPid(state.serverPid);
    scheduleExit(0);
    return { result: 'session stopped (recorder flushed, no packaging). Spec left at ' + path.relative(ROOT, cfg.outFile) };
  },
};

function sharedEnv() {
  return {
    FORM_URL: cfg.formUrl,
    FORM_PORT: String(cfg.formPort),
    CDP_PORT: String(cfg.cdpPort),
    OUT_FILE: cfg.outFile,
    READY_FILE: cfg.readyFile,
    STOP_FILE: cfg.stopFile,
    HEADLESS: cfg.headless,
    RECORDER_IDLE_TIMEOUT_MS: String(cfg.idleMs),
    ...(cfg.storageStateFile ? { STORAGE_STATE: cfg.storageStateFile } : {}),
    ...(cfg.manifestFile ? { SESSION_MANIFEST: cfg.manifestFile } : {}),
  };
}

// Resolve + validate the md-session auth contract (SPEC §10 v2 / --auth-state).
// Fails fast on a session that would die mid-recording; defaults FORM_URL to
// the manifest's baseUrl unless the user set FORM_URL explicitly.
async function loadAuthState() {
  if (!cfg.authState) return;
  const isDir = existsSync(cfg.authState) && !cfg.authState.endsWith('.json');
  cfg.storageStateFile = isDir ? path.join(cfg.authState, 'storageState.json') : cfg.authState;
  cfg.manifestFile = isDir ? path.join(cfg.authState, 'session.json') : null;
  if (!existsSync(cfg.storageStateFile)) {
    throw new Error(`--auth-state: ${cfg.storageStateFile} not found`);
  }
  JSON.parse(await readFile(cfg.storageStateFile, 'utf8')); // must be valid JSON
  let manifest = null;
  if (cfg.manifestFile && existsSync(cfg.manifestFile)) {
    manifest = JSON.parse(await readFile(cfg.manifestFile, 'utf8'));
    const ttlMs = Date.parse(manifest.expiresAt) - Date.now();
    if (!(ttlMs > 60 * 60 * 1000)) {
      throw new Error(`--auth-state: session for ${manifest.user?.email ?? '?'} expires ` +
        `${manifest.expiresAt} (<1 h left) — refresh it (md-session) and retry`);
    }
    if (manifest.baseUrl && !cfg.formUrlExplicit) cfg.formUrl = manifest.baseUrl;
    log(`auth: ${manifest.user?.email ?? manifest.user?.name ?? 'session'} @ ${cfg.formUrl}, ` +
      `expires ${manifest.expiresAt}`);
  } else {
    cfg.manifestFile = null;
    log(`auth: using ${path.relative(ROOT, cfg.storageStateFile)} (no manifest)`);
  }
  cfg.manifest = manifest;
}

async function writeSessionFile() {
  await atomicWrite(cfg.sessionFile, JSON.stringify({
    daemonPid: process.pid,
    serverPid: state.serverPid,
    recorderPid: state.recorderPid,
    socket: cfg.socket,
    formUrl: cfg.formUrl,
    outFile: cfg.outFile,
    flow: state.journal?.flow ?? null,
  }, null, 2));
}

async function stopRecorder() {
  if (!state.recorderPid) return;
  log('signalling recorder to stop…');
  await writeFile(cfg.stopFile, 'stop', 'utf8').catch(() => {});
  const deadline = Date.now() + 20000;
  while (isAlive(state.recorderPid) && Date.now() < deadline) await sleep(250);
  if (isAlive(state.recorderPid)) { log('recorder still alive after 20s — killing'); killPid(state.recorderPid); }
  state.recorderPid = null;
  try { await state.browser?.close(); } catch {}
  state.browser = null; state.page = null;
}

// ---------- finish pipeline (§5.1) ----------
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
function humanize(slug) {
  return slug.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

async function finishPipeline(args, sendEvt) {
  const t0 = Date.now();
  const say = (line) => { log(line); sendEvt?.(line); };

  // Sugar: --assert-testid/--assert-contains → one final assert entry (verified live).
  if (args.assertTestid) {
    await performAssert({ testid: args.assertTestid, contains: args.assertContains, title: args.assertTitle });
  }

  let flow = args.flow ? String(args.flow) : (args.summary ? slugify(args.summary) : '');
  if (!flow) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    flow = `flow-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }
  if (!/^[a-z0-9-]{1,48}$/.test(flow)) throw new Error(`--flow must match [a-z0-9-]{1,48}, got ${JSON.stringify(flow)}`);
  progress.flow = flow;
  state.journal.flow = flow;
  state.journal.summary = args.summary || humanize(flow);

  const driveMsTotal = Date.now() - Date.parse(progress.phases.drive.startedAt);
  progress.phases.drive = { ...progress.phases.drive, state: 'done', wallMs: driveMsTotal };
  await saveProgress();

  // 1. Stop the recorder (flushes the generated spec).
  say(`[finish] flow=${flow} — stopping recorder`);
  await stopRecorder();

  // 2–3. Enrich + move the spec to tests/<flow>.spec.ts.
  const specPath = path.join(ROOT, 'tests', `${flow}.spec.ts`);
  const raw = await readFile(cfg.outFile, 'utf8').catch(() => null);
  if (raw === null) throw new Error(`recorder produced no spec at ${cfg.outFile}`);
  const assertions = state.journal.entries
    .filter((e) => e.verb === 'assert')
    .map((e) => ({ testId: e.testid, containsText: e.contains }));
  const enriched = enrichTest(raw, {
    title: state.journal.summary,
    timeline: state.journal.entries,
    storageState: cfg.storageStateFile, // absolute — .auth/ files are machine-local anyway
  });
  await writeFile(cfg.outFile, enriched, 'utf8');
  if (path.resolve(cfg.outFile) !== specPath) {
    await mkdir(path.dirname(specPath), { recursive: true });
    await rename(cfg.outFile, specPath);
  }
  say(`[finish] spec → ${path.relative(ROOT, specPath)} (${assertions.length} assertion${assertions.length === 1 ? '' : 's'})`);

  state.journal.finishedAt = new Date().toISOString();
  await writeJournal();
  await writeSessionFile();

  const pkgDir = path.join(cfg.recordingsDir, flow);
  await mkdir(pkgDir, { recursive: true });

  // 4. Parallel: assert pass ∥ film pass. The static server stays up for both.
  const noFilm = !!args.noFilm;
  const filmAsync = !noFilm && !!args.filmAsync;
  progress.phase = 'assert';
  progress.phases.assert = { state: 'running', startedAt: new Date().toISOString() };
  progress.phases.film = noFilm
    ? { state: 'skipped' }
    : { state: 'running', startedAt: new Date().toISOString() };
  await saveProgress();

  say(`[finish] assert pass ${noFilm ? '' : '∥ film pass '}starting`);
  const assertT = Date.now();
  const assertPromise = run(path.join(ROOT, 'node_modules/.bin/playwright'),
    ['test', path.relative(ROOT, specPath)], { env: { HEADLESS: '1' }, timeoutMs: 120000 })
    .then((r) => {
      progress.phases.assert = { state: r.code === 0 ? 'done' : 'failed', ms: Date.now() - assertT };
      say(`[finish] assert pass ${r.code === 0 ? 'green' : 'RED'} (${progress.phases.assert.ms} ms)`);
      return r;
    });
  const filmT = Date.now();
  const filmPromise = noFilm
    ? Promise.resolve({ code: 0, out: '(film skipped)' })
    : run(process.execPath, [path.join(SCRIPT_DIR, 'film.mjs'),
        '--journal', cfg.journalFile, '--out', pkgDir], { timeoutMs: 300000 })
      .then((r) => {
        progress.phases.film = { state: r.code === 0 ? 'done' : 'failed', ms: Date.now() - filmT };
        say(`[finish] film pass ${r.code === 0 ? 'done' : 'FAILED'} (${progress.phases.film.ms} ms)`);
        return r;
      });

  // --film-async: return as soon as the assert pass is green; the film keeps
  // rendering and the daemon stays alive just long enough to package it.
  const assertResEarly = filmAsync ? await assertPromise : null;
  if (filmAsync && assertResEarly.code === 0) {
    await copyFile(specPath, path.join(pkgDir, 'flow.spec.ts'));
    await copyFile(cfg.journalFile, path.join(pkgDir, 'journal.json'));
    progress.phase = 'film';
    await saveProgress();
    filmPromise.then(async (filmRes) => {
      try {
        let filmOk = filmRes.code === 0;
        let integrity = '';
        if (filmOk) {
          integrity = await verifyFilmIntegrity(pkgDir);
          if (integrity) { log(`[finish] film integrity FAILED: ${integrity}`); filmOk = false; }
        }
        if (filmOk) {
          const { renderViewer } = await import('./viewer.mjs');
          const scenes = JSON.parse(await readFile(path.join(pkgDir, 'scenes.json'), 'utf8'));
          const html = renderViewer({
            journal: state.journal,
            scenes,
            spec: await readFile(specPath, 'utf8'),
          });
          await writeFile(path.join(pkgDir, 'index.html'), html, 'utf8');
        }
        progress.phases.package = { state: filmOk ? 'done' : 'failed' };
        progress.phase = filmOk ? 'done' : 'failed';
        await saveProgress();
        await atomicWrite(path.join(pkgDir, 'run.json'), JSON.stringify({
          ...progress,
          finishMs: Date.now() - t0,
          env: { HEADLESS: cfg.headless, PERSONA: process.env.PERSONA || 'calm', PACE_MS: cfg.pace, FORM_URL: cfg.formUrl },
        }, null, 2));
        await writeFile(path.join(pkgDir, 'run.log'), state.logLines.join('\n') + '\n', 'utf8');
        log(`[finish] background film ${filmOk ? `packaged → ${pkgDir}` : `FAILED (see run.log): ${filmRes.out.slice(-500)}`}`);
      } finally {
        await teardownServerAndSocket();
        scheduleExit(0);
      }
    });
    return {
      result: `assert pass green — spec: tests/${flow}.spec.ts\n` +
        `film rendering in background → ${pkgDir}/ (recording.webm + index.html land when done; ` +
        `phase in .run/progress.json flips to "done")`,
    };
  }

  const [assertRes, filmRes] = filmAsync
    ? [assertResEarly, await filmPromise] // async requested but assert RED: fall through to the failure path below
    : await Promise.all([assertPromise, filmPromise]);
  await saveProgress();

  // Failure handling (§5.1): never delete anything.
  if (assertRes.code !== 0) {
    progress.phase = 'failed';
    await saveProgress();
    await teardownServerAndSocket();
    scheduleExit(0);
    throw new Error(`assert pass failed — spec kept at ${path.relative(ROOT, specPath)}, ` +
      `journal kept at .run/journal.json. Playwright output:\n${assertRes.out.slice(-4000)}`);
  }

  // 5. Package.
  progress.phase = 'package';
  progress.phases.package = { state: 'running', startedAt: new Date().toISOString() };
  await saveProgress();
  const pkgT = Date.now();

  await copyFile(specPath, path.join(pkgDir, 'flow.spec.ts'));
  await copyFile(cfg.journalFile, path.join(pkgDir, 'journal.json'));

  let filmOk = filmRes.code === 0 && !noFilm;
  let integrity = '';
  if (filmOk) {
    integrity = await verifyFilmIntegrity(pkgDir);
    if (integrity) { say(`[finish] film integrity FAILED: ${integrity}`); filmOk = false; }
  }

  if (filmOk) {
    const { renderViewer } = await import('./viewer.mjs');
    const scenes = JSON.parse(await readFile(path.join(pkgDir, 'scenes.json'), 'utf8'));
    const html = renderViewer({
      journal: state.journal,
      scenes,
      spec: await readFile(specPath, 'utf8'),
    });
    await writeFile(path.join(pkgDir, 'index.html'), html, 'utf8');
  }

  progress.phases.package = { state: 'done', ms: Date.now() - pkgT };
  progress.phase = 'done';
  await saveProgress();
  await atomicWrite(path.join(pkgDir, 'run.json'), JSON.stringify({
    ...progress,
    finishMs: Date.now() - t0,
    env: { HEADLESS: cfg.headless, PERSONA: process.env.PERSONA || 'calm', PACE_MS: cfg.pace, FORM_URL: cfg.formUrl },
  }, null, 2));
  await writeFile(path.join(pkgDir, 'run.log'), state.logLines.join('\n') + '\n', 'utf8');

  // 6. Frame check (§8.3).
  let frameNote = '';
  if (filmOk && !args.noFrameCheck) {
    frameNote = await extractFrames(pkgDir);
  } else if (!filmOk) {
    frameNote = 'frame check skipped (no film)';
  } else {
    frameNote = 'frame check skipped (--no-frame-check)';
  }

  // 7. Teardown.
  await teardownServerAndSocket();
  scheduleExit(0);

  const timings = Object.entries(progress.phases)
    .map(([k, v]) => `${k}: ${v.state}${v.ms ? ` ${v.ms}ms` : ''}`).join(' · ');

  if (!noFilm && !filmOk) {
    throw new Error(`film pass failed (assert pass green — spec is proven). ` +
      `Packaged without video/viewer at ${pkgDir}. ` +
      `${integrity ? `integrity: ${integrity}. ` : ''}Film output:\n${filmRes.out.slice(-4000)}`);
  }
  return {
    result: `package complete: ${pkgDir}/\n` +
      `spec: tests/${flow}.spec.ts (assert pass green)\n` +
      `${timings}\nfinish total: ${Date.now() - t0} ms\n${frameNote}`,
  };
}

async function verifyFilmIntegrity(pkgDir) {
  const scenesPath = path.join(pkgDir, 'scenes.json');
  if (!existsSync(scenesPath)) return 'scenes.json missing';
  if (!existsSync(path.join(pkgDir, 'recording.webm'))) return 'recording.webm missing';
  const scenes = JSON.parse(await readFile(scenesPath, 'utf8'));
  const actions = state.journal.entries.filter((e) => ['fill', 'select', 'toggle', 'click', 'goto'].includes(e.verb)).length;
  const chapters = state.journal.entries.filter((e) => e.verb === 'scene').length + 2; // intro + outro
  const asserts = state.journal.entries.filter((e) => e.verb === 'assert').length;
  const expected = actions + chapters + asserts;
  if (scenes.length !== expected) return `scenes.json has ${scenes.length} entries, expected ${expected}`;
  // webm duration via ffprobe, if present (±20% of last scene t + 3 s).
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', path.join(pkgDir, 'recording.webm')], { timeoutMs: 15000 });
  if (probe.code === 127) { log('ffprobe not found — skipping duration check'); return ''; }
  if (probe.code !== 0) return `ffprobe failed: ${probe.out.slice(0, 300)}`;
  const dur = parseFloat(probe.out.trim());
  const expectedDur = scenes[scenes.length - 1].t + 3;
  // ±20%, but never tighter than ±3 s — on short films the fixed outro card +
  // encode flush alone exceed 20% of the runtime.
  const band = Math.max(3, expectedDur * 0.2);
  if (Math.abs(dur - expectedDur) > band) {
    return `webm duration ${dur.toFixed(1)}s outside ±${band.toFixed(1)}s of ${expectedDur.toFixed(1)}s`;
  }
  return '';
}

async function extractFrames(pkgDir) {
  const scenes = JSON.parse(await readFile(path.join(pkgDir, 'scenes.json'), 'utf8'));
  const framesDir = path.join(cfg.runDir, 'frames');
  await mkdir(framesDir, { recursive: true });
  const actions = scenes.filter((s) => s.kind === 'action');
  const asserts = scenes.filter((s) => s.kind === 'assert');
  const picks = [
    { name: 'intro-card', t: scenes[0].t + 1.0 },
    { name: 'middle-action', t: (actions[Math.floor(actions.length / 2)] || scenes[1]).t + 0.4 },
    { name: 'last-assert', t: asserts.length ? asserts[asserts.length - 1].t + 0.8 : scenes[scenes.length - 1].t },
  ];
  const paths = [];
  for (const p of picks) {
    const out = path.join(framesDir, `${p.name}.png`);
    const r = await run('ffmpeg', ['-y', '-ss', String(p.t.toFixed(2)), '-i',
      path.join(pkgDir, 'recording.webm'), '-frames:v', '1', out], { timeoutMs: 20000 });
    if (r.code === 127) return 'WARNING: ffmpeg not found — frame check skipped';
    if (r.code === 0) paths.push(path.relative(ROOT, out));
  }
  return paths.length
    ? `frame check: Read these to visually confirm the overlays rendered:\n  ${paths.join('\n  ')}`
    : 'WARNING: frame extraction produced no frames';
}

async function teardownServerAndSocket() {
  if (state.serverPid) { log('stopping static server'); killPid(state.serverPid); state.serverPid = null; }
}

function scheduleExit(code) {
  // Respond first, then exit — give the socket write a beat to flush.
  setTimeout(() => {
    try { unlinkSync(cfg.socket); } catch {}
    try { unlinkSync(cfg.sessionFile); } catch {}
    process.exit(code);
  }, 300).unref?.();
}

// ---------- idle self-termination ----------
function resetIdle() {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(async () => {
    log(`idle for ${cfg.idleMs} ms — self-terminating`);
    await stopRecorder().catch(() => {});
    await teardownServerAndSocket();
    try { unlinkSync(cfg.socket); } catch {}
    try { unlinkSync(cfg.sessionFile); } catch {}
    process.exit(0);
  }, cfg.idleMs);
  state.idleTimer.unref?.();
}

// ---------- socket server ----------
async function main() {
  await mkdir(cfg.runDir, { recursive: true });

  // Stale-session detection (§2.2): only steal the socket if the recorded
  // daemon PID is dead; if alive, exit 7 ("session already running").
  if (existsSync(cfg.sessionFile)) {
    const prev = JSON.parse(await readFile(cfg.sessionFile, 'utf8').catch(() => '{}') || '{}');
    if (prev.daemonPid && prev.daemonPid !== process.pid && isAlive(prev.daemonPid)) {
      console.error(`[daemon] session already running (pid ${prev.daemonPid}) — exit 7`);
      process.exit(7);
    }
    // Stale: clean up leftovers and preserve the old journal.
    for (const pid of [prev.recorderPid, prev.serverPid]) killPid(pid);
    if (existsSync(cfg.journalFile)) {
      renameSync(cfg.journalFile, path.join(cfg.runDir, 'journal.prev.json'));
      log('stale session detected — previous journal moved to .run/journal.prev.json');
    }
    try { unlinkSync(cfg.sessionFile); } catch {}
  }
  if (existsSync(cfg.socket)) { try { unlinkSync(cfg.socket); } catch {} }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('error', () => {});
    sock.on('data', async (d) => {
      buf += d.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      resetIdle();
      let req;
      try { req = JSON.parse(raw); } catch {
        sock.write(JSON.stringify({ id: null, ok: false, error: 'malformed request (expected one JSON object per line)' }) + '\n');
        return;
      }
      const sendEvt = (line) => { try { sock.write(JSON.stringify({ evt: 'log', line }) + '\n'); } catch {} };
      const handler = req.verb?.startsWith('_') ? null : verbs[req.verb];
      if (!handler) {
        sock.write(JSON.stringify({ id: req.id, ok: false, error: `unknown verb ${JSON.stringify(req.verb)}` }) + '\n');
        return;
      }
      if (req.verb !== 'ping' && req.verb !== 'start' && req.verb !== 'status' && !state.page && !state.finishing) {
        sock.write(JSON.stringify({ id: req.id, ok: false, error: 'session not started — run the start verb first' }) + '\n');
        return;
      }
      try {
        const res = await handler(req.args || {}, sendEvt);
        sock.write(JSON.stringify({ id: req.id, ok: true, ...res }) + '\n');
      } catch (err) {
        // Every error response carries a fresh FULL snapshot (§2.2) when a page is live.
        const payload = { id: req.id, ok: false, error: err.message || String(err) };
        if (state.page) payload.snapshot = await fullSnapSafe();
        try { sock.write(JSON.stringify(payload) + '\n'); } catch {}
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.socket, resolve);
  });
  // Claim the session immediately so a second daemon exits 7 even before `start`.
  await atomicWrite(cfg.sessionFile, JSON.stringify({ daemonPid: process.pid, socket: cfg.socket }, null, 2));
  resetIdle();
  log(`daemon listening on ${path.relative(ROOT, cfg.socket)} (pid ${process.pid})`);

  const bail = async (sig) => {
    log(`received ${sig} — cleaning up`);
    await stopRecorder().catch(() => {});
    await teardownServerAndSocket();
    try { unlinkSync(cfg.socket); } catch {}
    try { unlinkSync(cfg.sessionFile); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => bail('SIGTERM'));
  process.on('SIGINT', () => bail('SIGINT'));
}

main().catch((err) => {
  console.error('[daemon] fatal:', err);
  process.exit(1);
});
