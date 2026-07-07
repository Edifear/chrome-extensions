// "Test Generator" — owns a browser with Playwright's codegen recorder attached,
// and writes a Playwright test to OUT_FILE live as actions happen on the page.
//
// It launches the browser with --remote-debugging-port so a *separate* agent
// process can connectOverCDP and drive the same page. The recorder listens to
// DOM events at the page level, so it captures the agent's actions regardless
// of which CDP client triggered them.
//
// This uses playwright's internal `context._enableRecorder(...)` — the exact
// call the real `npx playwright codegen` CLI makes under the hood.
import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm, access, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cfg = {
  url: process.env.FORM_URL || 'http://localhost:5188/',
  outFile: path.resolve(process.env.OUT_FILE || 'tests/generated.spec.ts'),
  cdpPort: Number(process.env.CDP_PORT || 9333),
  readyFile: path.resolve(process.env.READY_FILE || '.run/recorder-ready'),
  stopFile: path.resolve(process.env.STOP_FILE || '.run/stop'),
  headless: process.env.HEADLESS === '1',
  language: process.env.TARGET || 'playwright-test',
  viewport: { width: 1280, height: 800 },
  // Self-terminate if no stop signal ever arrives (e.g. the orchestrator died),
  // so an orphaned recorder + browser can't linger forever.
  idleTimeoutMs: Number(process.env.RECORDER_IDLE_TIMEOUT_MS || 300000),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[recorder]', ...a);

// Hoisted so the fatal-error handler can still clean up the temp profile.
let userDataDir;

async function main() {
  // Ensure the coordination dir exists, then clear any stale files.
  await mkdir(path.dirname(cfg.readyFile), { recursive: true });
  await mkdir(path.dirname(cfg.outFile), { recursive: true });
  for (const f of [cfg.readyFile, cfg.stopFile]) {
    if (existsSync(f)) await rm(f).catch(() => {});
  }

  // The codegen recorder's output file is written by its Inspector app (RecorderApp).
  // We don't need the Inspector *window* to be visible for that to happen — when the
  // page is headless we also hide the Inspector window via PWTEST_CLI_HEADLESS, so a
  // headless run is fully invisible yet still writes the generated test.
  if (cfg.headless) process.env.PWTEST_CLI_HEADLESS = '1';

  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'atr-profile-'));
  log(`launching chromium (headless=${cfg.headless}) with CDP on :${cfg.cdpPort}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: cfg.headless,
    viewport: cfg.viewport,
    args: [`--remote-debugging-port=${cfg.cdpPort}`],
  });

  // Enable the codegen recorder on this context, streaming generated code to a file.
  // (Same parameters the `playwright codegen` CLI passes internally.)
  await context._enableRecorder({
    language: cfg.language,
    launchOptions: {},
    contextOptions: { viewport: cfg.viewport },
    mode: 'recording',
    testIdAttributeName: 'data-testid',
    outputFile: cfg.outFile,
    handleSIGINT: false,
  });
  log(`recorder enabled → writing ${path.relative(process.cwd(), cfg.outFile)} live`);

  // Optional auth: preload a Playwright storageState so the recorder's fresh
  // profile is authenticated before the first navigation (gated apps).
  // Cookies go in directly; localStorage origins are injected via an init
  // script (launchPersistentContext has no storageState option).
  if (process.env.STORAGE_STATE) {
    try {
      const state = JSON.parse(await readFile(process.env.STORAGE_STATE, 'utf8'));
      if (state.cookies?.length) await context.addCookies(state.cookies);
      if (state.origins?.length) {
        await context.addInitScript((origins) => {
          const o = origins.find((x) => x.origin === location.origin);
          if (o) for (const { name, value } of o.localStorage || []) localStorage.setItem(name, value);
        }, state.origins);
      }
      log(`loaded auth state from ${process.env.STORAGE_STATE} ` +
        `(${state.cookies?.length ?? 0} cookies, ${state.origins?.length ?? 0} localStorage origins)`);
    } catch (e) {
      log(`WARN: failed to load STORAGE_STATE (${process.env.STORAGE_STATE}): ${e.message}`);
    }
  }
  // sessionStorage can't ride storageState (Playwright doesn't persist it) —
  // the md-session manifest may carry it explicitly.
  if (process.env.SESSION_MANIFEST) {
    try {
      const manifest = JSON.parse(await readFile(process.env.SESSION_MANIFEST, 'utf8'));
      if (manifest.sessionStorage?.length) {
        await context.addInitScript((entries) => {
          const e = entries.find((x) => x.origin === location.origin);
          if (e) for (const { name, value } of e.items || []) sessionStorage.setItem(name, value);
        }, manifest.sessionStorage);
        log(`sessionStorage init script installed (${manifest.sessionStorage.length} origins)`);
      }
    } catch (e) {
      log(`WARN: failed to load SESSION_MANIFEST: ${e.message}`);
    }
  }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(cfg.url);
  log(`opened ${cfg.url} — recording. CDP endpoint: http://localhost:${cfg.cdpPort}`);

  // Announce readiness so the orchestrator can launch the agent.
  await writeFile(cfg.readyFile, String(cfg.cdpPort), 'utf8');

  // Graceful shutdown: flush the recorder and close the browser.
  let shuttingDown = false;
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`stopping (${reason}) — finalizing generated test`);
    // Closing the inspected context fires ContextClosed inside the recorder app,
    // which flushes the throttled output file to disk with the final action.
    try { await context.close(); } catch {}
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    log(`done. test written to ${cfg.outFile}`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Idle until the orchestrator (or a human) drops the stop file, or until the
  // idle timeout elapses (guards against an orphaned recorder hanging forever).
  const startedAt = Date.now();
  while (true) {
    if (await access(cfg.stopFile).then(() => true).catch(() => false)) {
      // Give the throttled recorder a beat to capture the final action before close.
      await sleep(900);
      await shutdown('stop-file');
      return;
    }
    if (Date.now() - startedAt > cfg.idleTimeoutMs) {
      log(`no stop signal after ${cfg.idleTimeoutMs}ms — self-terminating`);
      await shutdown('idle-timeout');
      return;
    }
    await sleep(250);
  }
}

main().catch(async (err) => {
  console.error('[recorder] fatal:', err);
  // Best-effort cleanup of the temp profile even on a crash.
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
