// Injected by record.sh at the >>>HELPERS<<< marker.
// Bare statements — placed inside `async page => { ... }`. `page` is in scope.

const wait = (ms) => page.waitForTimeout(ms);

const highlightBox = async (locator, label, opts = {}) => {
    const { color = 'rgb(255, 79, 79)', duration = 1500, side = 'bottom' } = opts;
    const box = await locator.boundingBox();
    if (!box) return null;
    // Clamp the label inside the viewport — the highlighted element may be wider
    // than the viewport (e.g. a horizontally scrolling table), so a naive
    // box-center anchor would push the label off screen.
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    const labelHalf = Math.min((label.length * 7.5 + 24) / 2, vp.width / 2 - 16);
    const rawCenter = box.x + box.width / 2;
    const centerX = Math.max(labelHalf + 16, Math.min(vp.width - labelHalf - 16, rawCenter));
    const labelTop =
        side === 'top'
            ? `top:${box.y - 38}px`
            : `top:${box.y + box.height + 8}px`;
    return page.screencast.showOverlay(
        `
    <div style="position:absolute;
      top:${box.y - 4}px;left:${box.x - 4}px;
      width:${box.width + 8}px;height:${box.height + 8}px;
      border:3px solid ${color};border-radius:6px;
      box-shadow:0 0 0 4px ${color}33,0 8px 24px rgba(0,0,0,.35);
      pointer-events:none;"></div>
    <div style="position:absolute;
      ${labelTop};
      left:${centerX}px;
      transform:translateX(-50%);
      max-width:calc(100vw - 32px);
      padding:6px 12px;background:${color};color:#fff;
      border-radius:6px;font:600 13px -apple-system,system-ui,sans-serif;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
      box-shadow:0 4px 12px rgba(0,0,0,.3);">
      ${label}
    </div>
  `,
        { duration }
    );
};

const stickyBadge = (text, position = 'top-right', tone = 'success') => {
    const corner = {
        'top-right': 'top:16px;right:16px',
        'top-left': 'top:16px;left:16px',
        'top-center': 'top:16px;left:50%;transform:translateX(-50%)',
        'bottom-right': 'bottom:16px;right:16px',
        'bottom-left': 'bottom:16px;left:16px',
        'bottom-center': 'bottom:16px;left:50%;transform:translateX(-50%)',
    }[position];
    const bg = {
        success: 'rgba(20,150,90,.92)',
        info: 'rgba(60,110,200,.92)',
        warn: 'rgba(220,140,30,.92)',
        error: 'rgba(210,60,60,.92)',
        neutral: 'rgba(40,42,52,.92)',
    }[tone];
    return page.screencast.showOverlay(`
    <div style="position:absolute;${corner};
      padding:10px 16px;background:${bg};color:#fff;
      border-radius:8px;font:600 14px -apple-system,system-ui,sans-serif;
      box-shadow:0 6px 20px rgba(0,0,0,.4);">${text}</div>
  `);
};

const chapter = async (title, description, durationMs = 2200) => {
    await page.screencast.showChapter(title, { description, duration: durationMs });
    await wait(durationMs + 200);
};
