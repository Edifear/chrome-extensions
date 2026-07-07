// Autoresearch benchmark harness (AUTORESEARCH.md §2). FROZEN after exp 0 —
// researcher agents must never edit this file, the goldens, or the flow below.
//
//   node research/bench.mjs --make-golden     one clean run; snapshots goldens
//   node research/bench.mjs --runs 3          score: median T_agent + gates
//   node research/bench.mjs --runs 1 --gates-only
//
// Exit 0 = valid score (all gates green on every run); 1 = gate failure or
// harness error. Results land in research/results/<sha>-<n>.json.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pexecFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESEARCH = path.join(ROOT, 'research');
const GOLDEN = path.join(RESEARCH, 'golden');
const RESULTS = path.join(RESEARCH, 'results');
const FLOW = 'bench-flow';
const PKG = path.join(os.homedir(), 'Recordings', FLOW);
const SPEC = path.join(ROOT, 'tests', `${FLOW}.spec.ts`);
const FORM_URL = 'http://localhost:5199/';
const SSIM_MIN = 0.90;

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const RUNS = Number(opt('runs', flag('make-golden') ? 1 : 3));
const MAKE_GOLDEN = flag('make-golden');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[bench]', ...a);

// ---------- The canonical flow (IMMUTABLE — the "dataset") ----------
const PLAN_MAIN = JSON.stringify([
  { verb: 'scene', title: 'Bench flow', desc: 'Canonical education record' },
  { verb: 'click', selector: '#onboarding-education_program_type', note: 'Open Program Type' },
  { verb: 'click', selector: '.ant-select-item-option[title="Undergraduate"]', note: 'Pick Undergraduate' },
  { verb: 'fill', label: 'Institution Name', value: 'Michigan', note: 'Filter institutions' },
  { verb: 'click', selector: '.ant-select-item-option[title="University of Michigan"]', note: 'Pick the hit' },
  { verb: 'click', selector: '#onboarding-education_degree_earned', note: 'Open Degree' },
  { verb: 'fill', label: 'onboarding-education_degree_earned', value: 'Bachelor of Arts', note: 'Filter degrees' },
  { verb: 'click', selector: '.ant-select-item-option[title="Bachelor of Arts (BA)"]', note: 'Pick BA' },
  { verb: 'fill', label: 'onboarding-education_start_date', value: '2018-09-01', note: 'Start date' },
  { verb: 'fill', label: 'onboarding-education_end_date', value: '2022-05-31', note: 'End date' },
]);
const PLAN_SUBMIT = JSON.stringify([
  { verb: 'click', name: 'Submit', note: 'Submit the record' },
  { verb: 'assert', testid: 'education-record', contains: 'University of Michigan', title: 'Card shows the institution' },
]);
const EXPECTED_CARD = ['University of Michigan', 'SEP 1, 2018', 'MAY 31, 2022', 'Undergraduate'];

// ---------- helpers ----------
function session(cmdArgs, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'session.mjs'), ...cmdArgs], {
      cwd: ROOT, env: { ...process.env, FORM_URL },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, wall: Date.now() - t0 }); });
  });
}
function httpOk(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => { req.destroy(); resolve(false); });
  });
}
async function readJson(f, fallback = null) {
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return fallback; }
}
function normalizeSpec(src) {
  return src.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
    .join('\n');
}
async function ssim(a, b) {
  try {
    const { stderr } = await pexecFile('ffmpeg', ['-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'], { timeout: 30000 });
    const m = String(stderr).match(/All:([0-9.]+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}
async function extractFrame(webm, t, out) {
  const r = await pexecFile('ffmpeg', ['-y', '-loglevel', 'error', '-ss', t.toFixed(2), '-i', webm, '-frames:v', '1', out], { timeout: 30000 }).catch((e) => e);
  return existsSync(out) && !(r instanceof Error);
}
// Stable visual moments, picked from THIS run's scenes.json (times shift as
// the pipeline gets faster; the moments don't).
function framePicks(scenes) {
  const asserts = scenes.filter((s) => s.kind === 'assert');
  return [
    { name: 'intro', t: scenes[0].t + 1.0 },
    { name: 'assert', t: (asserts.at(-1) ?? scenes.at(-1)).t + 0.8 },
    { name: 'outro', t: scenes.at(-1).t + 1.0 },
  ];
}

// ---------- one benchmark run ----------
async function benchRun(n, expected) {
  const gates = {};
  const phases = {};
  const fail = (why) => { log(`run ${n} FAILED: ${why}`); return { ok: false, why, gates, phases }; };

  // Clean slate: no live session, no stale spec/package outputs.
  if ((await session(['status'], 5000)).code === 0) {
    await session(['stop'], 60000);
  }
  for (let i = 0; i < 60 && (await session(['status'], 3000)).code === 0; i++) await sleep(500);
  await rm(SPEC, { force: true });
  await rm(path.join(PKG, 'scenes.json'), { force: true });
  await rm(path.join(PKG, 'recording.webm'), { force: true });

  const t0 = Date.now();
  const start = await session(['start'], 90000);
  if (start.code !== 0) return fail(`start rc=${start.code}\n${start.out.slice(-400)}`);
  phases.start = start.wall;

  const open = await session(['click', '--name', 'Add an education record', '--note', 'Open the Add Education modal'], 30000);
  if (open.code !== 0) return fail('open-modal click failed');
  phases.open = open.wall;

  const main = await session(['do', '--plan', PLAN_MAIN], 120000);
  if (main.code !== 0) return fail(`main plan failed\n${main.out.slice(-400)}`);
  phases.plan = main.wall;

  const submit = await session(['do', '--plan', PLAN_SUBMIT], 60000);
  if (submit.code !== 0) return fail(`submit plan failed\n${submit.out.slice(-400)}`);
  phases.submit = submit.wall;

  // G3 (state-correct) — gate check, measured outside T_agent.
  const snap = await session(['snapshot', '--full'], 30000);
  gates.g3_state = EXPECTED_CARD.every((s) => snap.out.includes(s));

  const finish = await session(['finish', '--film-async', '--flow', FLOW, '--summary', 'canonical bench flow'], 300000);
  if (finish.code !== 0) return fail(`finish rc=${finish.code}\n${finish.out.slice(-400)}`);
  phases.finish = finish.wall;

  const t_agent = phases.start + phases.open + phases.plan + phases.submit + phases.finish;

  // Wait for the background film + package.
  let phase = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    phase = (await readJson(path.join(ROOT, '.run', 'progress.json'), {})).phase;
    if (phase === 'done' || phase === 'failed') break;
    await sleep(1000);
  }
  const t_package = Date.now() - t0;
  if (phase !== 'done') return fail(`package phase=${phase}`);

  // Journal is torn down with the session — read the packaged copy.
  const journal = await readJson(path.join(PKG, 'journal.json'), { entries: [] });

  // ---------- gates ----------
  const specSrc = await readFile(SPEC, 'utf8').catch(() => '');
  if (MAKE_GOLDEN) {
    await mkdir(path.join(GOLDEN, 'frames'), { recursive: true });
    await copyFile(SPEC, path.join(GOLDEN, `${FLOW}.spec.ts`));
  }
  const goldenSpec = await readFile(path.join(GOLDEN, `${FLOW}.spec.ts`), 'utf8').catch(() => '');
  gates.g1_spec = normalizeSpec(specSrc) === normalizeSpec(goldenSpec) && !!specSrc;

  const replay = await pexecFile('npx', ['playwright', 'test', path.relative(ROOT, SPEC)], {
    cwd: ROOT, env: { ...process.env, HEADLESS: '1' }, timeout: 120000,
  }).catch((e) => e);
  gates.g2_replay = !(replay instanceof Error);

  const scenes = await readJson(path.join(PKG, 'scenes.json'), []);
  const webm = path.join(PKG, 'recording.webm');
  gates.g4_film = existsSync(webm) && scenes.length === (MAKE_GOLDEN ? scenes.length : expected.scenes);

  let g5 = true;
  const ssims = {};
  if (scenes.length) {
    for (const p of framePicks(scenes)) {
      const cur = path.join(RESULTS, `frame-${p.name}.png`);
      if (!(await extractFrame(webm, p.t, cur))) { g5 = false; break; }
      const gold = path.join(GOLDEN, 'frames', `${p.name}.png`);
      if (MAKE_GOLDEN) { await copyFile(cur, gold); ssims[p.name] = 1; continue; }
      const s = await ssim(cur, gold);
      ssims[p.name] = s;
      if (s === null || s < SSIM_MIN) g5 = false;
    }
  } else g5 = false;
  gates.g5_visual = g5;

  gates.g6_journal = journal.entries.length === (MAKE_GOLDEN ? journal.entries.length : expected.journalEntries) &&
    journal.entries.filter((e) => ['click', 'fill'].includes(e.verb)).every((e) => typeof e.ms === 'number');

  if (MAKE_GOLDEN) {
    await writeFile(path.join(GOLDEN, 'expected.json'), JSON.stringify({
      scenes: scenes.length, journalEntries: journal.entries.length,
    }, null, 2));
  }

  const ok = Object.values(gates).every(Boolean);
  return { ok, t_agent, t_package, phases, gates, ssims };
}

// ---------- main ----------
async function main() {
  // "Idle enough": this 12-core machine rests at load ~4-5 with a browser and
  // dev servers up, so gate at 60% of cores rather than an absolute number.
  const loadCap = os.cpus().length * 0.6;
  if (os.loadavg()[0] > loadCap && !flag('force')) {
    console.error(`[bench] load avg ${os.loadavg()[0].toFixed(1)} > ${loadCap.toFixed(1)} — machine not idle (use --force to override)`);
    process.exit(1);
  }
  await mkdir(RESULTS, { recursive: true });
  if (!(await httpOk(FORM_URL))) {
    log('booting antd-lab on :5199');
    const fd = (await import('node:fs')).openSync(path.join(RESULTS, 'vite.log'), 'a');
    spawn('npm', ['run', 'dev'], { cwd: path.join(ROOT, 'antd-lab'), detached: true, stdio: ['ignore', fd, fd] }).unref();
    const dl = Date.now() + 30000;
    while (Date.now() < dl && !(await httpOk(FORM_URL))) await sleep(500);
    if (!(await httpOk(FORM_URL))) { console.error('[bench] antd-lab did not come up'); process.exit(1); }
  }
  const sha = (await pexecFile('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT })).stdout.trim();
  const expected = await readJson(path.join(GOLDEN, 'expected.json'), null);
  if (!MAKE_GOLDEN && !expected) { console.error('[bench] no goldens — run with --make-golden first'); process.exit(1); }

  const runs = [];
  for (let n = 1; n <= RUNS; n++) {
    log(`run ${n}/${RUNS}…`);
    const r = await benchRun(n, expected || {});
    runs.push(r);
    await writeFile(path.join(RESULTS, `${sha}-${Date.now()}-${n}.json`), JSON.stringify({ sha, n, ...r }, null, 2));
    log(`run ${n}: ${r.ok ? 'OK' : 'FAIL'} t_agent=${r.t_agent ?? '-'}ms t_package=${r.t_package ?? '-'}ms ` +
      `gates=${JSON.stringify(r.gates)}${r.ssims ? ` ssim=${JSON.stringify(r.ssims)}` : ''}`);
  }
  const good = runs.filter((r) => r.ok);
  const allPass = good.length === runs.length;
  const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const summary = {
    sha, runs: RUNS, allGatesPass: allPass,
    t_agent_median: good.length ? med(good.map((r) => r.t_agent)) : null,
    t_package_median: good.length ? med(good.map((r) => r.t_package)) : null,
  };
  console.log('[bench] SUMMARY', JSON.stringify(summary));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('[bench] fatal:', e); process.exit(1); });
