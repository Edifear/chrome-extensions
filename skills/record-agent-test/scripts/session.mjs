// session.mjs — thin argv→socket forwarder for Agent Flow Studio (SPEC §2.2).
//
// The old version paid Node startup + `import('playwright')` + a CDP handshake
// per agent action (~935 ms). Now a persistent daemon (studio/daemon.mjs) holds
// the warm connection; this client only parses argv, sends one NDJSON request
// over a unix socket, and prints the response (~54 ms client floor).
//
// Imports nothing heavier than node:net / node:fs / node:child_process.
import { spawn } from 'node:child_process';
import { openSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// scripts → plugin root (the studio home). STUDIO_ROOT overrides for a
// checkout elsewhere; PW_PLAYGROUND_ROOT kept as a legacy alias.
const ROOT = process.env.STUDIO_ROOT || process.env.PW_PLAYGROUND_ROOT
  ? path.resolve(process.env.STUDIO_ROOT || process.env.PW_PLAYGROUND_ROOT)
  : path.resolve(SCRIPT_DIR, '..');

if (!existsSync(path.join(ROOT, 'studio', 'daemon.mjs'))) {
  console.error(`[session] cannot find studio/daemon.mjs under ${ROOT}.\n` +
    `Set STUDIO_ROOT to the Agent Flow Studio home.`);
  process.exit(2);
}

const { request, ping } = await import(path.join(ROOT, 'studio', 'ipc.mjs'));

const SOCKET = process.env.STUDIO_SOCKET
  ? path.resolve(ROOT, process.env.STUDIO_SOCKET)
  : path.join(ROOT, '.run', 'session.sock');
const DAEMON_LOG = path.join(ROOT, '.run', 'daemon.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny flag parser: `cmd --key value --flag` ----------
// A value that itself starts with "--" needs the explicit form `--key=value`
// (e.g. `--value=--weird`); in the space form a following --token is read as
// the next flag.
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq !== -1) { flags[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
  }
  return flags;
}

function printResponse(res) {
  if (res.result) console.log(res.result);
  if (res.snapshot) console.log(`\nCurrent page:\n${res.snapshot}\n`);
}

function dieDeadSocket() {
  console.error('[session] no live session — run: node .claude/skills/record-agent-test/scripts/session.mjs start');
  process.exit(9);
}

async function send(verb, args, timeoutMs = 30000) {
  try {
    const res = await request(SOCKET, verb, args, {
      timeoutMs,
      onEvent: (m) => console.log(m.line),
    });
    printResponse(res);
    if (!res.ok) {
      console.error(`[session] ERROR: ${res.error}`);
      process.exit(1);
    }
  } catch (err) {
    if (err.code === 'ETIMEOUT') {
      console.error(`[session] ${err.message} — see ${path.relative(process.cwd(), DAEMON_LOG)}`);
      process.exit(8);
    }
    if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') dieDeadSocket();
    console.error(`[session] ${err.message}`);
    process.exit(9);
  }
}

async function cmdStart(flags) {
  if (await ping(SOCKET)) {
    console.error('[session] a session is already running — use it, or run `stop` first. (exit 7)');
    process.exit(7);
  }
  const env = { ...process.env };
  if (flags['auth-state']) env.AUTH_STATE = path.resolve(String(flags['auth-state']));
  mkdirSync(path.dirname(DAEMON_LOG), { recursive: true });
  const fd = openSync(DAEMON_LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'studio', 'daemon.mjs')], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', fd, fd],
  });
  child.unref();

  // Wait for the daemon socket to come up (it may exit 7 if it lost a race).
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await ping(SOCKET)) break;
    if (child.exitCode === 7) {
      console.error('[session] a session is already running (exit 7)');
      process.exit(7);
    }
    if (child.exitCode !== null && child.exitCode !== 0) {
      console.error(`[session] daemon exited ${child.exitCode} — see ${path.relative(process.cwd(), DAEMON_LOG)}`);
      process.exit(child.exitCode);
    }
    await sleep(150);
  }
  if (!(await ping(SOCKET))) {
    console.error(`[session] daemon did not come up in 15 s — see ${path.relative(process.cwd(), DAEMON_LOG)}`);
    process.exit(8);
  }
  // `start` boots the static server + recorder and prints the first snapshot.
  await send('start', {}, 90000);
  console.log('READY — drive the page with fill/select/toggle/click (or a `do` plan), then call finish.');
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const f = parseFlags(rest);
  switch (cmd) {
    case 'start': return cmdStart(f);
    case 'snapshot': return send('snapshot', { full: !!f.full });
    case 'fill': return send('fill', { label: f.label, value: f.value, note: f.note });
    case 'select': return send('select', { label: f.label, option: f.option, note: f.note });
    case 'toggle': return send('toggle', { label: f.label, note: f.note });
    case 'click': return send('click', { name: f.name, selector: f.selector, text: f.text, note: f.note });
    case 'scene': return send('scene', { title: f.title, desc: f.desc });
    case 'assert': return send('assert', { testid: f.testid, contains: f.contains, title: f.title }, 15000);
    case 'do': return send('do', { plan: f.plan }, 120000);
    case 'status': return send('status', {});
    case 'finish':
      // finish runs assert ∥ film ∥ package — allow up to 10 minutes.
      return send('finish', {
        flow: f.flow,
        summary: f.summary,
        noFilm: !!f['no-film'],
        noFrameCheck: !!f['no-frame-check'],
        assertTestid: f['assert-testid'],
        assertContains: f['assert-contains'],
        assertTitle: f['assert-title'],
      }, 600000);
    case 'stop': return send('stop', {}, 60000);
    default:
      console.error(`Unknown command: ${cmd || '(none)'}\n` +
        `Usage: session.mjs <start|snapshot|fill|select|toggle|click|scene|assert|do|status|finish|stop> [flags]`);
      process.exit(2);
  }
}

main().catch((err) => {
  console.error('[session] fatal:', err.message || err);
  process.exit(1);
});
