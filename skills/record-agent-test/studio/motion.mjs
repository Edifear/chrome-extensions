// Human-motion primitives for the film pass (SPEC §3.2).
//
// Everything is jittered; nothing happens at a constant rate. Randomness comes
// from a seeded PRNG (mulberry32) seeded from the flow slug, so re-filming the
// same flow produces the same motion — deterministic, diffable artifacts.
//
// The engine tracks the virtual cursor position (Playwright doesn't expose it);
// it starts at the viewport center.

export function seedFromString(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PERSONAS = {
  calm:   { dwell: 1.0, speed: 1.0, typeMin: 55, typeMax: 95 },
  snappy: { dwell: 0.6, speed: 1.5, typeMin: 40, typeMax: 70 },
};

const easeInOut = (t) => (1 - Math.cos(Math.PI * t)) / 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Motion {
  // opts: { seed, persona = 'calm', dwellScale = 1 }
  // dwellScale compresses read-time dwells/pauses only (§3.2 runtime budget);
  // typing cadence and cursor travel are never compressed — realism first.
  constructor(page, { seed = 1, persona = 'calm', dwellScale = 1 } = {}) {
    this.page = page;
    this.rand = mulberry32(seed);
    this.p = PERSONAS[persona] || PERSONAS.calm;
    this.dwellScale = dwellScale;
    const vp = page.viewportSize() || { width: 1280, height: 800 };
    this.vp = vp;
    this.cursor = { x: vp.width / 2, y: vp.height / 2 };
  }

  between(lo, hi) { return lo + this.rand() * (hi - lo); }
  gaussian() { // Box–Muller
    const u = Math.max(this.rand(), 1e-9);
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // A read-time pause, scaled by persona and the runtime-budget compressor.
  async dwell(ms) {
    await sleep(ms * this.p.dwell * this.dwellScale);
  }

  async boxOf(locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`target has no bounding box (not visible?): ${locator}`);
    return box;
  }

  // Quadratic-bezier cursor travel with ease-in-out timing; long moves
  // overshoot 8–20 px and correct back (§3.2 table).
  async humanMove(locator) {
    const box = await this.boxOf(locator);
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await this.#travel(to);
    return box;
  }

  async #travel(to) {
    const from = { ...this.cursor };
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 2) return;

    const overshoots = dist > 600;
    const target = overshoots
      ? { x: to.x + (dx / dist) * this.between(8, 20), y: to.y + (dy / dist) * this.between(8, 20) }
      : to;

    // Control point offset perpendicular to the straight line by 5–15% of its length.
    const side = this.rand() < 0.5 ? -1 : 1;
    const off = dist * this.between(0.05, 0.15) * side;
    const mid = { x: (from.x + target.x) / 2 - (dy / dist) * off, y: (from.y + target.y) / 2 + (dx / dist) * off };

    // Sample by wall clock, not step count — each mouse.move is a CDP round
    // trip (~10 ms), so a fixed-step loop would stretch every travel by ~1.6×.
    const duration = Math.min(900, Math.max(250, dist / 1.4)) / this.p.speed;
    const start = Date.now();
    for (;;) {
      const raw = Math.min(1, (Date.now() - start) / duration);
      const t = easeInOut(raw);
      const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * mid.x + t ** 2 * target.x;
      const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * mid.y + t ** 2 * target.y;
      await this.page.mouse.move(x, y);
      if (raw >= 1) break;
      await sleep(12);
    }
    this.cursor = { ...target };

    if (overshoots) { // correct back over ~120 ms
      const start2 = Date.now();
      for (;;) {
        const t = easeInOut(Math.min(1, (Date.now() - start2) / 120));
        await this.page.mouse.move(target.x + (to.x - target.x) * t, target.y + (to.y - target.y) * t);
        if (t >= 1) break;
        await sleep(12);
      }
      this.cursor = { ...to };
    }
  }

  // humanMove → hover dwell 150–350 ms → down/up with gaussian jitter clamped
  // to ≤30% of the box half-extent per axis.
  async humanClick(locator) {
    const box = await this.humanMove(locator);
    await this.dwell(this.between(150, 350));
    const jx = Math.max(-1, Math.min(1, this.gaussian() * 0.35)) * box.width * 0.15;
    const jy = Math.max(-1, Math.min(1, this.gaussian() * 0.35)) * box.height * 0.15;
    const x = box.x + box.width / 2 + jx, y = box.y + box.height / 2 + jy;
    await this.page.mouse.move(x, y);
    this.cursor = { x, y };
    await this.page.mouse.down();
    await sleep(this.between(40, 90));
    await this.page.mouse.up();
  }

  // humanClick to focus → pause → per-char typing at 55–95 ms/char with a
  // 150–250 ms breath after every 2–4 words. No fake typos, ever (§12).
  async humanType(locator, text) {
    await this.humanClick(locator);
    await this.dwell(this.between(200, 350));
    // Refill safety: if the field already has a value, clear it like a human would.
    const existing = await locator.inputValue().catch(() => '');
    if (existing) {
      await this.page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      await this.page.keyboard.press('Backspace');
      await this.dwell(150);
    }
    let wordsUntilBreath = Math.round(this.between(2, 4));
    for (const ch of String(text)) {
      await this.page.keyboard.type(ch);
      await sleep(this.between(this.p.typeMin, this.p.typeMax));
      if (ch === ' ' && --wordsUntilBreath <= 0) {
        await this.dwell(this.between(150, 250));
        wordsUntilBreath = Math.round(this.between(2, 4));
      }
    }
  }

  // humanClick to open → 300–500 ms viewing pause → selectOption → 200 ms.
  async humanSelect(locator, option) {
    await this.humanClick(locator);
    await this.dwell(this.between(300, 500));
    try { await locator.selectOption({ label: String(option) }); }
    catch { await locator.selectOption(String(option)); }
    await this.dwell(200);
  }

  // Wheel-scroll in 80–120 px steps every ~30 ms until the target is inside the
  // viewport plus a 40 px margin — never scrollIntoViewIfNeeded teleports.
  async humanScroll(locator) {
    for (let guard = 0; guard < 200; guard++) {
      const box = await locator.boundingBox();
      if (!box) break; // let the caller's waitFor/actionability produce the real error
      const topGap = box.y - 40;
      const bottomGap = box.y + box.height - (this.vp.height - 40);
      if (topGap >= 0 && bottomGap <= 0) return;
      const dir = bottomGap > 0 ? 1 : -1;
      await this.page.mouse.wheel(0, dir * this.between(80, 120));
      await sleep(30);
    }
  }

  // Read-time dwell after a state change: 600 ms + 30 ms per newly-added word,
  // capped at 2500 ms. "Newly added" = words in after-text minus before-text.
  async settle(beforeText) {
    const after = await this.page.evaluate(() => document.body.innerText).catch(() => '');
    const beforeWords = new Set(String(beforeText || '').split(/\s+/).filter(Boolean));
    const newWords = String(after).split(/\s+/).filter((w) => w && !beforeWords.has(w));
    await this.dwell(Math.min(2500, 600 + 30 * new Set(newWords).size));
    return after;
  }

  async bodyText() {
    return this.page.evaluate(() => document.body.innerText).catch(() => '');
  }
}
