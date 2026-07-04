// Overlay helpers for the film pass (SPEC §3.3), restyled after review:
// smaller type, glass surfaces, thinner outlines — annotations should sit
// under the flow, not compete with it. ESM exports taking `page` explicitly.

const wait = (page, ms) => page.waitForTimeout(ms);

const GLASS = 'background:rgba(17,19,26,.78);backdrop-filter:blur(6px);' +
  'border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.94);';

// Full-screen chapter card via page.screencast.showChapter; waits it out.
// Used ONLY for intro/outro — mid-flow cards blank the UI and read as filler.
export async function chapter(page, title, description, durationMs = 2000) {
  await page.screencast.showChapter(title, { description, duration: durationMs });
  await wait(page, durationMs + 200);
}

// Thin outline + optional small tag pinned to the box's bottom edge.
// `label` is optional — highlight alone is often enough, since the content
// being pointed at is inside the box.
export async function highlightBox(page, locator, label, opts = {}) {
  const { color = 'rgb(31,136,61)', duration = 1500 } = opts;
  const box = await locator.boundingBox();
  if (!box) return null;
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  let tag = '';
  if (label) {
    const half = Math.min((label.length * 6.4 + 20) / 2, vp.width / 2 - 12);
    const cx = Math.max(half + 12, Math.min(vp.width - half - 12, box.x + box.width / 2));
    tag = `
    <div style="position:absolute;top:${box.y + box.height + 7}px;left:${cx}px;
      transform:translateX(-50%);padding:4px 10px;${GLASS}
      border-color:${color};border-radius:6px;
      font:500 12px -apple-system,system-ui,sans-serif;white-space:nowrap;
      overflow:hidden;text-overflow:ellipsis;max-width:60vw;">${label}</div>`;
  }
  return page.screencast.showOverlay(
    `
    <div style="position:absolute;
      top:${box.y - 3}px;left:${box.x - 3}px;
      width:${box.width + 6}px;height:${box.height + 6}px;
      border:2px solid ${color};border-radius:7px;
      box-shadow:0 0 0 3px ${color}26;
      pointer-events:none;"></div>${tag}
  `,
    { duration }
  );
}

// Small persistent corner chip (was a chunky badge). Returns a disposable.
export function stickyBadge(page, text, position = 'top-right', tone = 'neutral') {
  const corner = {
    'top-right': 'top:14px;right:14px',
    'top-left': 'top:14px;left:14px',
    'top-center': 'top:14px;left:50%;transform:translateX(-50%)',
    'bottom-right': 'bottom:14px;right:14px',
    'bottom-left': 'bottom:14px;left:14px',
    'bottom-center': 'bottom:14px;left:50%;transform:translateX(-50%)',
  }[position];
  const accent = {
    success: 'rgba(63,185,80,.9)',
    info: 'rgba(88,166,255,.9)',
    warn: 'rgba(210,153,34,.9)',
    error: 'rgba(248,81,73,.9)',
    neutral: 'rgba(139,148,158,.9)',
  }[tone];
  return page.screencast.showOverlay(`
    <div style="position:absolute;${corner};display:flex;align-items:center;gap:7px;
      padding:6px 12px;${GLASS}border-radius:999px;
      font:500 12px -apple-system,system-ui,sans-serif;
      box-shadow:0 4px 14px rgba(0,0,0,.28);">
      <span style="width:6px;height:6px;border-radius:50%;background:${accent};flex:none;"></span>
      <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:40vw;">${text}</span>
    </div>
  `);
}
