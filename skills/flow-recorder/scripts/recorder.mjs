// Flow recorder: records a narrated walkthrough video of a Playwright page.
//
// - Page frames are back-to-back 2x screenshots (~15 fps) through DevTools.
// - Zoom and the cursor are added afterwards by ffmpeg at 30 fps from a log of camera and cursor
//   moves, so both stay smooth whatever the capture rate.
// - Click ripples, element frames and captions are drawn in the page, so frames include them.
// - Clicks, typing, key presses, navigation, zoom and scrolling wait until element frames have
//   faded; the cursor may move while they're up.
//
// No dependencies: the caller brings Playwright (its own project's copy) and ffmpeg must be on PATH.
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DPR = 2;
const FPS = 30;
const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 13 19">
    <path d="M1 1v15.2l3.7-3.6 2.4 5.5 2.6-1.1-2.4-5.4h5.1z"
        fill="#111" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/></svg>`;
const HOTSPOT = { x: 2, y: 2 };

export const COLORS = {
    check: '16,150,110', // green: something the video proves
    highlight: '84,112,240', // blue: something the viewer should look at
    ripple: '57,83,236',
};

// ---- In-page decorations. Serialized into the page, so it must be self-contained.
const decorations = ({ ripple }) => {
    const w = window;
    if (w.__recOutline) return;
    const mount = () => {
        // Frame an element: corner brackets glide in around it while the rest of the page dims
        // slightly through a cut-out. Boxes shown at the same time share one dim layer, so a burst
        // of checks doesn't stack darkness. Stays up for the draw time plus ~1.1s, then fades.
        const ns = 'http://www.w3.org/2000/svg';
        const svgEl = (tag, attrs, parent) => {
            const node = document.createElementNS(ns, tag);
            for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
            parent?.appendChild(node);
            return node;
        };
        const spot = { live: 0, mask: undefined, dim: undefined };
        const spotlight = () => {
            if (spot.mask?.isConnected) return spot;
            const svg = svgEl('svg', {
                style: 'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483639',
            });
            spot.mask = svgEl('mask', { id: 'rec-spot' }, svgEl('defs', {}, svg));
            svgEl('rect', { width: '100%', height: '100%', fill: '#fff' }, spot.mask);
            spot.dim = svgEl('rect', { width: '100%', height: '100%', fill: 'rgba(15,20,35,.13)', mask: 'url(#rec-spot)', opacity: 0 }, svg);
            spot.live = 0;
            document.documentElement.appendChild(svg);
            return spot;
        };
        const fadeDim = (to, duration) =>
            spot.dim.animate([{ opacity: +getComputedStyle(spot.dim).opacity }, { opacity: to }], {
                duration,
                easing: 'ease-in-out',
                fill: 'forwards',
            });

        const frames = new Set();
        w.__recOutline = (box, ms, color) => {
            const pad = 4;
            const b = { x: box.x - pad, y: box.y - pad, w: box.width + 2 * pad, h: box.height + 2 * pad };
            const hold = Math.max(ms, 500) + 1100;

            const { mask } = spotlight();
            const hole = svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6, fill: '#000' }, mask);
            if (spot.live++ === 0) fadeDim(1, 380);

            const frame = document.createElement('div');
            frame.style.cssText = `position:fixed;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;
                pointer-events:none;z-index:2147483645`;
            const tint = document.createElement('div');
            tint.style.cssText = `position:absolute;inset:0;border-radius:6px;background:rgba(${color},.05)`;
            frame.appendChild(tint);
            tint.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, fill: 'backwards' });
            const len = Math.max(10, Math.min(22, Math.min(b.w, b.h) * 0.32));
            const line = `2.5px solid rgba(${color},.9)`;
            for (const [v, hz] of [['top', 'left'], ['top', 'right'], ['bottom', 'left'], ['bottom', 'right']]) {
                const corner = document.createElement('div');
                corner.style.cssText = `position:absolute;${v}:0;${hz}:0;width:${len}px;height:${len}px;
                    border-${v}:${line};border-${hz}:${line};border-${v}-${hz}-radius:6px`;
                frame.appendChild(corner);
                const dx = hz === 'left' ? -9 : 9;
                const dy = v === 'top' ? -9 : 9;
                corner.animate(
                    [{ transform: `translate(${dx}px,${dy}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }],
                    { duration: 420, easing: 'cubic-bezier(.2,.8,.25,1)', fill: 'backwards' }
                );
            }
            document.documentElement.appendChild(frame);

            // Ends the frame with a fade; returns once it's gone. Runs once, whether the hold ran
            // out or an action is about to happen (see __recClearFrames).
            let gone;
            let timer;
            const end = (fade) =>
                (gone ??= new Promise((done) => {
                    clearTimeout(timer);
                    frames.delete(entry);
                    if (--spot.live === 0) fadeDim(0, fade);
                    else hole.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade, fill: 'forwards' });
                    frame.animate([{ opacity: +getComputedStyle(frame).opacity }, { opacity: 0 }], {
                        duration: fade,
                        easing: 'ease-in-out',
                        fill: 'forwards',
                    }).onfinish = () => {
                        frame.remove();
                        hole.remove();
                        done();
                    };
                }));
            const entry = { shownAt: performance.now(), end };
            frames.add(entry);
            timer = setTimeout(() => end(500), hold);
        };

        // Before an action: let each frame stay up for at least minShow ms from when it appeared,
        // then fade it out quickly. Resolves when none are left.
        w.__recClearFrames = (minShow) =>
            Promise.all(
                [...frames].map(
                    (f) =>
                        new Promise((done) =>
                            setTimeout(() => f.end(250).then(done), Math.max(0, f.shownAt + minShow - performance.now()))
                        )
                )
            );

        // Click ripple on the real pointerdown, so it lands exactly when the click happens.
        window.addEventListener(
            'pointerdown',
            (event) => {
                const ring = document.createElement('div');
                ring.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;
                    width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;
                    border:3px solid rgba(${ripple},.95);background:rgba(${ripple},.18);
                    pointer-events:none;z-index:2147483646`;
                document.documentElement.appendChild(ring);
                ring.animate(
                    [{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.4)', opacity: 0 }],
                    { duration: 700, easing: 'cubic-bezier(.2,.7,.3,1)' }
                ).onfinish = () => ring.remove();
            },
            true
        );
    };
    if (document.documentElement) mount();
    else document.addEventListener('readystatechange', mount, { once: true });
};

// Every visible box a locator matches, merged into one (e.g. a whole table column), clipped to the screen.
const unionBox = async (locator, viewportHeight) => {
    const boxes = (await Promise.all((await locator.all()).slice(0, 40).map((l) => l.boundingBox().catch(() => null))))
        .filter((b) => b && b.y < viewportHeight - 20 && b.y + b.height > 0);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.max(0, Math.min(...boxes.map((b) => b.y)));
    const right = Math.max(...boxes.map((b) => b.x + b.width));
    const bottom = Math.min(viewportHeight - 12, Math.max(...boxes.map((b) => b.y + b.height)));
    return { x, y, width: right - x, height: bottom - y };
};

export class Recorder {
    /**
     * Installs the in-page decorations on the context (call before the page navigates, or it
     * applies from the next navigation) and returns a recorder for the page.
     * @param {import('playwright').Page} page
     * @param {{ workDir: string }} options  scratch dir for frames; wiped on start
     */
    static async attach(page, { workDir }) {
        await page.context().addInitScript(decorations, { ripple: COLORS.ripple });
        await page.evaluate(decorations, { ripple: COLORS.ripple }).catch(() => {});
        return new Recorder(page, workDir);
    }

    constructor(page, workDir) {
        this.page = page;
        this.workDir = workDir;
        this.framesDir = path.join(workDir, 'frames');
        const vp = page.viewportSize();
        if (!vp) throw new Error('The page needs a fixed viewport (e.g. 1440×900)');
        this.vp = vp;
        this.full = { x: 0, y: 0, w: vp.width, h: vp.height };
        this.camera = this.full;
        this.cursorAt = { x: vp.width / 2, y: vp.height / 2 };
        this.cursorStart = this.cursorAt;
        this.start = null;
        this.stoppedAt = 0;
        this.frameTimes = [];
        this.cameraMoves = [];
        this.glides = [];
        this.captionText = null;
        this.captionEl = undefined;
    }

    now = () => (Date.now() - this.start) / 1000;
    wait = (ms) => this.page.waitForTimeout(ms);

    // ---- Capture.
    async startCapture() {
        rmSync(this.workDir, { recursive: true, force: true });
        mkdirSync(this.framesDir, { recursive: true });
        await this.page.mouse.move(this.cursorAt.x, this.cursorAt.y);
        const cdp = await this.page.context().newCDPSession(this.page);
        this.running = true;
        this.loop = (async () => {
            while (this.running) {
                const before = Date.now();
                try {
                    // The clip is in document coordinates, so follow the scroll position or a
                    // scrolled page records as blank.
                    const { cssVisualViewport: v } = await cdp.send('Page.getLayoutMetrics');
                    const clip = { x: v.pageX, y: v.pageY, width: this.vp.width, height: this.vp.height, scale: DPR };
                    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, optimizeForSpeed: true, clip });
                    const index = this.frameTimes.push((before + Date.now()) / 2) - 1;
                    this.start ??= this.frameTimes[0];
                    writeFileSync(path.join(this.framesDir, `${index}.jpg`), Buffer.from(data, 'base64'));
                } catch {
                    await new Promise((r) => setTimeout(r, 30)); // navigation in progress
                }
            }
        })();
        while (this.start === null) await new Promise((r) => setTimeout(r, 20));
    }

    async stopCapture() {
        await this.caption(null);
        this.running = false;
        await this.loop;
        this.stoppedAt = Date.now();
    }

    // ---- Camera.
    async moveCamera(to, ms = 1100) {
        if (to.x === this.camera.x && to.y === this.camera.y && to.w === this.camera.w) return;
        await this.clearFrames();
        const text = this.captionText;
        await this.setCaption(null);
        this.cameraMoves.push({ start: this.now(), duration: ms / 1000, from: this.camera, to });
        this.camera = to;
        await this.wait(ms + 150);
        await this.setCaption(text);
    }

    // Zoom only when the detail that proves the point would be hard to read at full frame.
    async zoomTo(locator, { pad = 24, captionRoom = 70, maxScale = 1.8 } = {}) {
        await locator.waitFor({ state: 'visible' });
        await this.scrollTo(locator);
        const box = await locator.boundingBox();
        if (!box) return;
        const { width: W, height: H } = this.vp;
        const aspect = W / H;
        const h = Math.min(H, Math.max(box.height + 2 * pad + captionRoom, (box.width + 2 * pad) / aspect, H / maxScale));
        const w = h * aspect;
        if (W / w < 1.15) return; // the element is already large; a near-1× zoom only adds motion
        const x = Math.min(Math.max(0, box.x + box.width / 2 - w / 2), W - w);
        const y = Math.min(Math.max(0, box.y - pad), H - h);
        await this.moveCamera({ x, y, w, h });
    }

    async zoomOut() {
        await this.moveCamera(this.full);
    }

    // ---- Cursor: eased travel on a slight arc; the real mouse jumps at the end so hover effects
    // match what the drawn cursor shows.
    async glideToPoint(to) {
        const from = this.cursorAt;
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy) || 1;
        if (length < 2) return;
        const bend = Math.min(80, length * 0.15);
        const ms = Math.round(Math.min(1100, Math.max(450, length * 1.2)));
        this.glides.push({ start: this.now(), duration: ms / 1000, dx, dy, kx: (-dy / length) * bend, ky: (dx / length) * bend });
        this.cursorAt = to;
        await this.wait(ms);
        await this.page.mouse.move(to.x, to.y);
    }

    async glideTo(locator) {
        await this.scrollTo(locator);
        const box = await locator.boundingBox();
        if (box) await this.glideToPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    }

    // Scroll an element into view, clearing frames first: they're fixed to the screen, so the page
    // would slide out from under them.
    async scrollTo(locator) {
        const inView = await locator
            .evaluate((el) => {
                const r = el.getBoundingClientRect();
                return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
            })
            .catch(() => true);
        if (inView) return;
        await this.clearFrames();
        await locator.scrollIntoViewIfNeeded();
    }

    // ---- Frames.
    async outlineBox(box, color = COLORS.check, ms = 700) {
        await this.page.evaluate(({ box, ms, color }) => window.__recOutline?.(box, ms, color), { box, ms, color });
    }

    async outline(locator, color = COLORS.check, ms = 700) {
        const box = await locator.boundingBox().catch(() => null);
        if (box) await this.outlineBox(box, color, ms);
    }

    // Fade out frames still on screen (each after at least minShow ms), so the next action never
    // happens under one.
    async clearFrames(minShow = 1200) {
        await this.page.evaluate((minShow) => window.__recClearFrames?.(minShow), minShow).catch(() => {});
    }

    // ---- Captions: at the bottom of the current camera view, sized to read the same after zoom.
    // One per beat; it stays until the next caption. null/'' hides it.
    async caption(text) {
        this.captionText = text || null;
        await this.setCaption(this.captionText);
    }

    async setCaption(text) {
        await this.captionEl?.evaluate((el) => el.remove()).catch(() => {});
        this.captionEl = undefined;
        if (!text) return;
        const scale = this.vp.width / this.camera.w;
        const cam = this.camera;
        const style = `position:fixed;left:${cam.x + cam.w / 2}px;
            top:${cam.y + cam.h - 26 / scale}px;transform:translate(-50%,-100%);
            max-width:${(cam.w * 0.86).toFixed(0)}px;text-align:center;
            padding:${10 / scale}px ${18 / scale}px;border-radius:${10 / scale}px;
            background:rgba(17,24,39,.84);color:#fff;pointer-events:none;
            z-index:2147483640;box-shadow:0 6px 24px rgba(0,0,0,.25);
            font:500 ${18 / scale}px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;
        this.captionEl = await this.page.evaluateHandle(
            ({ text, style }) => {
                const el = document.createElement('div');
                el.textContent = text;
                el.style.cssText = style;
                document.documentElement.appendChild(el);
                return el;
            },
            { text, style }
        );
    }

    // ---- Actions, paced for a viewer. Each waits for frames to clear before it changes the page.
    async settle(ms = 2_500) {
        await this.page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
    }

    async goto(url) {
        await this.clearFrames();
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        await this.settle(30_000);
        this.captionEl = undefined; // the navigation wiped it
        await this.setCaption(this.captionText);
        await this.wait(600);
    }

    async click(locator) {
        await locator.waitFor({ state: 'visible' });
        await this.glideTo(locator);
        await this.clearFrames();
        await this.wait(250);
        await locator.click();
        await this.settle();
        await this.wait(700);
    }

    async fill(locator, value) {
        await locator.waitFor({ state: 'visible' });
        await this.glideTo(locator);
        await this.clearFrames();
        await locator.click();
        await locator.fill('');
        await locator.pressSequentially(value, { delay: 55 });
        await this.settle();
        await this.wait(600);
    }

    async press(key) {
        await this.clearFrames();
        await this.page.keyboard.press(key);
        await this.settle();
        await this.wait(600);
    }

    async hover(locator) {
        await locator.waitFor({ state: 'visible' });
        await this.glideTo(locator);
        await this.wait(900);
    }

    // Green frame: a check the video proves (call after your own assertion passes).
    async check(locator) {
        await locator.waitFor({ state: 'visible' });
        await this.outline(locator, COLORS.check, 700);
        await this.wait(500);
    }

    // Green frames on every match (first 8), e.g. each cell of a filtered column.
    async checkAll(locator) {
        const n = Math.min(await locator.count(), 8);
        for (let i = 0; i < n; i++) await this.outline(locator.nth(i), COLORS.check, 500);
        await this.wait(700);
    }

    // Blue frame around everything the locator matches as one box; the cursor points at it.
    async highlight(locator) {
        await locator.first().waitFor({ state: 'visible' });
        await this.scrollTo(locator.first());
        const box = await unionBox(locator, this.vp.height);
        if (box) {
            await this.glideToPoint({ x: Math.min(box.x + box.width + 16, this.vp.width - 20), y: box.y + Math.min(box.height / 2, 40) });
            await this.outlineBox(box, COLORS.highlight, 900);
        }
        await this.wait(1_400);
    }

    // ---- Rendering: frames + camera + cursor → H.264 MP4.
    async render(outFile) {
        const { width: W, height: H } = this.vp;
        const progress = (start, duration, t) => `clip((${t}-${start.toFixed(3)})/${duration.toFixed(3)},0,1)`;
        const easeCubic = (u) => `if(lt(${u},0.5),4*pow(${u},3),1-pow(2-2*${u},3)/2)`;
        const smooth = (u) => `(${u}*${u}*(3-2*${u}))`;
        const cameraExpr = (key, t) =>
            this.cameraMoves.reduce(
                (expr, { start, duration, from, to }) => `${expr}+(${(to[key] - from[key]).toFixed(2)})*${smooth(progress(start, duration, t))}`,
                `${this.full[key]}`
            );
        const cursorExpr = (axis, t) =>
            [
                this.cursorStart[axis].toFixed(2),
                ...this.glides.map(({ start, duration, dx, dy, kx, ky }) => {
                    const e = `(${easeCubic(progress(start, duration, t))})`;
                    const [d, k] = axis === 'x' ? [dx, kx] : [dy, ky];
                    return `(${d.toFixed(2)})*${e}+2*${e}*(1-${e})*(${k.toFixed(2)})`;
                }),
            ].join('+');

        const ends = [...this.frameTimes.slice(1), this.stoppedAt];
        const list = this.frameTimes.flatMap((time, i) => [`file 'frames/${i}.jpg'`, `duration ${((ends[i] - time) / 1000).toFixed(4)}`]);
        list.push(`file 'frames/${this.frameTimes.length - 1}.jpg'`); // concat ignores the last duration otherwise
        writeFileSync(path.join(this.workDir, 'frames.txt'), `ffconcat version 1.0\n${list.join('\n')}\n`);

        const cursorPng = path.join(this.workDir, 'cursor.png');
        const cursorPage = await this.page.context().newPage();
        await cursorPage.setContent(`<body style="margin:0;background:transparent">${CURSOR_SVG}</body>`);
        await cursorPage.locator('svg').screenshot({ path: cursorPng, omitBackground: true });
        await cursorPage.close();

        const cam = (key) => `(${cameraExpr(key, 'it')})`;
        const camT = (key) => `(${cameraExpr(key, 't')})`;
        const zoom = `(${W}/${camT('w')})`;
        const graph = [
            // zoompan needs one input frame per output frame, so make the frame rate constant first.
            `[0:v]fps=${FPS},zoompan=z='${W}/${cam('w')}':x='${cam('x')}*${DPR}':y='${cam('y')}*${DPR}'` + `:d=1:s=${W}x${H}:fps=${FPS}[bg]`,
            `[1:v]scale=26:38[cur]`,
            `[bg][cur]overlay=eval=frame:shortest=1` +
                `:x='((${cursorExpr('x', 't')})-${camT('x')})*${zoom}-${HOTSPOT.x}'` +
                `:y='((${cursorExpr('y', 't')})-${camT('y')})*${zoom}-${HOTSPOT.y}'[out]`,
        ].join(';\n');
        const graphFile = path.join(this.workDir, 'graph.txt');
        writeFileSync(graphFile, graph);

        mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
        await run(
            'ffmpeg',
            [
                '-y', '-loglevel', 'error',
                '-f', 'concat', '-safe', '0', '-i', path.join(this.workDir, 'frames.txt'),
                '-loop', '1', '-i', cursorPng,
                '-/filter_complex', graphFile,
                '-map', '[out]',
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', outFile,
            ],
            { maxBuffer: 64 * 1024 * 1024, timeout: 600_000 }
        );
        return outFile;
    }
}
