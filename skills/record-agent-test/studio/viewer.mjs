// Viewer renderer (SPEC §7): index.html generated from scenes.json +
// journal.json + the spec source — no hand-edited __MARKER__ placeholders.
// Visual base: screenplay-global's viewer-template, extended with assert pills
// and collapsible spec/journal panels. Fully self-contained (inline CSS/JS,
// relative <video src>), works from any static file server.
//
// CLI: node studio/viewer.mjs --dir recordings/<flow>   (reads the package,
// writes index.html next to recording.webm). Also importable: renderViewer().
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderViewer({ journal, scenes, spec }) {
  const title = (journal.summary || journal.flow || 'Recorded flow').replace(/^\w/, (c) => c.toUpperCase());
  const asserts = scenes.filter((s) => s.kind === 'assert');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  :root {
    --bg:#ffffff; --panel:#ffffff; --border:#e6e8eb; --text:#1f2328;
    --text-muted:#57606a; --text-faint:#8b929b; --accent:#1f6feb;
    --accent-soft:#ddf4ff; --success:#1f883d; --success-soft:#dcfce7;
    --shadow:0 1px 0 rgba(31,35,40,.04),0 8px 24px rgba(31,35,40,.08);
  }
  * { box-sizing:border-box; }
  html,body { margin:0; }
  body { background:#f5f6f8; color:var(--text);
    font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif; }
  .app { display:grid; grid-template-columns:minmax(0,1fr) 420px; gap:16px; padding:16px; }
  .video-card { background:var(--panel); border:1px solid var(--border); border-radius:10px;
    box-shadow:var(--shadow); display:flex; flex-direction:column; overflow:hidden; align-self:start; }
  .video-card header { display:flex; align-items:center; justify-content:space-between;
    padding:10px 14px; border-bottom:1px solid var(--border); background:#fafbfc; }
  .video-card header h1 { margin:0; font-size:13px; font-weight:600; }
  .video-card header .url { font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--text-faint); margin-left:12px; overflow:hidden; text-overflow:ellipsis;
    white-space:nowrap; flex:1; text-align:right; }
  video { width:100%; height:auto; display:block; background:#000; }
  .timeline { display:flex; gap:4px; align-items:center; padding:12px 16px 12px; border-top:1px solid var(--border); }
  .timeline .segs { flex:1; display:flex; gap:4px; min-width:0; }
  .timeline .seg { flex-grow:var(--w,1); flex-basis:0; height:10px; min-width:18px; border-radius:999px;
    border:none; padding:0; background:#d0d4dc; position:relative; cursor:pointer; overflow:hidden;
    transition:background .12s ease,transform .12s ease; }
  .timeline .seg:hover { transform:translateY(-1px); }
  .timeline .seg.chapter { background:#a9adc1; }
  .timeline .seg.action  { background:#4dd699; }
  .timeline .seg.assert  { background:var(--success); box-shadow:inset 0 0 0 2px #fff3; }
  .timeline .seg.current { box-shadow:0 0 0 3px rgba(31,111,235,.22); }
  .timeline .seg .fill { position:absolute; inset:0; width:var(--p,0%);
    background:rgba(255,255,255,.45); pointer-events:none; transition:width .1s linear; }
  .timeline .time { font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--text-muted); padding-left:8px; white-space:nowrap; }
  .panels { margin-top:16px; display:flex; flex-direction:column; gap:12px; }
  details { background:var(--panel); border:1px solid var(--border); border-radius:10px;
    box-shadow:var(--shadow); overflow:hidden; }
  details summary { padding:10px 14px; font-weight:600; font-size:13px; cursor:pointer;
    background:#fafbfc; user-select:none; }
  details pre { margin:0; padding:14px 16px; overflow-x:auto; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;
    color:var(--text); border-top:1px solid var(--border); max-height:60vh; overflow-y:auto; }
  .side { background:var(--panel); border:1px solid var(--border); border-radius:10px;
    box-shadow:var(--shadow); display:flex; flex-direction:column; align-self:start; }
  .side header { padding:14px 16px 10px; border-bottom:1px solid var(--border); }
  .pills { display:flex; gap:14px; align-items:center; font-weight:600; font-size:13px; margin-bottom:6px; }
  .pill { display:inline-flex; align-items:center; gap:6px; }
  .pill .dot { width:8px; height:8px; border-radius:50%; background:var(--success); }
  .summary { color:var(--text-muted); font-size:12.5px; line-height:1.55; }
  .scenes { overflow-y:auto; padding:4px 8px 16px; max-height:75vh; }
  .scene { display:grid; grid-template-columns:44px 1fr; gap:10px; padding:10px 8px 12px;
    border-radius:8px; cursor:pointer; border:1px solid transparent;
    transition:background .12s ease,border-color .12s ease; }
  .scene:hover { background:#f6f8fa; }
  .scene.active { background:var(--accent-soft); border-color:#b6e3ff; }
  .scene .ts { color:var(--text-faint); font:600 12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
    padding-top:1px; text-align:right; user-select:none; }
  .scene .title { font-weight:600; font-size:13.5px; }
  .scene.kind-chapter .title { color:var(--text-muted); text-transform:uppercase;
    font-size:11.5px; letter-spacing:.04em; }
  .scene .assertion { display:grid; grid-template-columns:18px 1fr; gap:6px; margin-top:6px;
    padding:8px 10px; background:var(--success-soft); border:1px solid #b5e2c3; border-radius:6px;
    font-size:12.5px; color:#14532d; line-height:1.5; }
  .scene .assertion .check { width:16px; height:16px; border-radius:50%; background:var(--success);
    color:#fff; display:inline-flex; align-items:center; justify-content:center; flex:none; margin-top:1px; }
  .scene .assertion .check svg { width:10px; height:10px; }
  @media (max-width:1100px) { .app { grid-template-columns:1fr; } }
</style>
</head>
<body>
  <div class="app">
    <div>
      <section class="video-card">
        <header>
          <h1>${esc(title)}</h1>
          <div class="url">${esc(journal.url)}</div>
        </header>
        <video id="vid" src="recording.webm" controls preload="metadata"></video>
        <div class="timeline">
          <div class="segs" id="segs"></div>
          <span class="time" id="time">0:00 / 0:00</span>
        </div>
      </section>
      <div class="panels">
        <details>
          <summary>Generated spec — flow.spec.ts</summary>
          <pre>${esc(spec)}</pre>
        </details>
        <details>
          <summary>Action journal — journal.json</summary>
          <pre>${esc(JSON.stringify(journal, null, 2))}</pre>
        </details>
      </div>
    </div>

    <aside class="side">
      <header>
        <div class="pills">
          <span class="pill"><span class="dot"></span>${asserts.length} assertion${asserts.length === 1 ? '' : 's'} verified · ${scenes.length} scenes</span>
        </div>
        <div class="summary">${esc(journal.summary || '')}</div>
      </header>
      <div class="scenes" id="scenes"></div>
    </aside>
  </div>

<script>
  const SCENES = ${JSON.stringify(scenes)};
  const video = document.getElementById('vid');
  const scenesEl = document.getElementById('scenes');
  const segs = document.getElementById('segs');
  const timeEl = document.getElementById('time');
  const pad = n => String(n).padStart(2, '0');
  const fmt = t => \`\${Math.floor(t/60)}:\${pad(Math.floor(t%60))}\`;
  const escHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const CHECK = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>';

  scenesEl.innerHTML = SCENES.map((s, i) => \`
    <div class="scene kind-\${s.kind}" data-i="\${i}">
      <div class="ts">\${fmt(s.t)}</div>
      <div class="body">
        <div class="title">\${escHtml(s.title)}</div>
        \${s.assertion ? \`<div class="assertion"><span class="check">\${CHECK}</span><span>\${escHtml(s.assertion)}</span></div>\` : ''}
      </div>
    </div>\`).join('');

  function renderSegs(total) {
    segs.innerHTML = SCENES.map((s, i) => {
      const next = i + 1 < SCENES.length ? SCENES[i + 1].t : total;
      return \`<button class="seg \${s.kind}" data-i="\${i}" style="--w:\${Math.max(0.001, next - s.t)};"
        title="\${fmt(s.t)} · \${escHtml(s.title)}"><span class="fill"></span></button>\`;
    }).join('');
  }
  function seekTo(i) { video.currentTime = SCENES[i].t; video.play().catch(() => {}); setActive(i); }
  scenesEl.addEventListener('click', e => { const el = e.target.closest('.scene'); if (el) seekTo(+el.dataset.i); });
  segs.addEventListener('click', e => { const el = e.target.closest('.seg'); if (el) seekTo(+el.dataset.i); });
  function setActive(i) {
    [...scenesEl.children].forEach((c, idx) => c.classList.toggle('active', idx === i));
    [...segs.children].forEach((c, idx) => c.classList.toggle('current', idx === i));
  }
  video.addEventListener('loadedmetadata', () => {
    renderSegs(video.duration || SCENES[SCENES.length - 1].t + 4);
    timeEl.textContent = \`0:00 / \${fmt(video.duration || 0)}\`;
  });
  video.addEventListener('timeupdate', () => {
    const t = video.currentTime, total = video.duration || 0;
    let active = 0;
    for (let i = 0; i < SCENES.length; i++) { if (SCENES[i].t <= t) active = i; else break; }
    setActive(active);
    timeEl.textContent = \`\${fmt(t)} / \${fmt(total)}\`;
    [...segs.children].forEach((el, i) => {
      const start = SCENES[i].t, end = i + 1 < SCENES.length ? SCENES[i + 1].t : total;
      const local = end > start ? Math.max(0, Math.min(1, (t - start) / (end - start))) : 0;
      el.querySelector('.fill').style.setProperty('--p', \`\${local * 100}%\`);
    });
  });
  renderSegs(SCENES[SCENES.length - 1].t + 4);
  setActive(0);
</script>
</body>
</html>
`;
}

// ---------- CLI ----------
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) args[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  if (!args.dir) { console.error('usage: node studio/viewer.mjs --dir recordings/<flow>'); process.exit(2); }
  const dir = path.resolve(args.dir);
  const [journal, scenes, spec] = await Promise.all([
    readFile(path.join(dir, 'journal.json'), 'utf8').then(JSON.parse),
    readFile(path.join(dir, 'scenes.json'), 'utf8').then(JSON.parse),
    readFile(path.join(dir, 'flow.spec.ts'), 'utf8'),
  ]);
  await writeFile(path.join(dir, 'index.html'), renderViewer({ journal, scenes, spec }), 'utf8');
  console.log(`[viewer] wrote ${path.join(args.dir, 'index.html')}`);
}
