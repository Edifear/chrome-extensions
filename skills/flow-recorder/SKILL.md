---
name: flow-recorder
description: "Record a narrated walkthrough video (MP4) of a web UI flow driven by Playwright: a smooth drawn cursor, click ripples, captions, corner-bracket frames with a light spotlight on checked or highlighted elements, and optional camera zoom. Use when the user asks to record a demo, walkthrough or proof video of a feature, a flow recording, a screencast of a test, or video evidence that something works, and whenever you write or change a script that drives this recorder."
---

# Flow recorder

Records a short, narrated video of a web UI flow. Give it a Playwright page; it captures 2× screenshots while your script drives the page through its paced actions, then renders an MP4 with ffmpeg, adding the zoom and cursor at 30 fps so both stay smooth whatever the capture rate.

Files in this skill:
- `scripts/recorder.mjs`: the `Recorder` class. No dependencies; the calling script brings Playwright.
- `scripts/example.mjs`: a minimal script to copy.

## Requirements

- **Playwright** (the `playwright` package with Chromium) in the project the script runs from. ESM resolves `import 'playwright'` relative to the script file, so keep your recording script inside that project, and import the recorder by the absolute path of this skill's `scripts/recorder.mjs`.
- **ffmpeg** 7 or newer on PATH (the render uses `-/filter_complex <file>`).
- **A fixed viewport.** 1440×900 is the default size; the timings and sizes below are tuned for it.

## Quick start

```js
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Recorder } from '<this skill>/scripts/recorder.mjs';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const rec = await Recorder.attach(page, { workDir: '<scratch dir>' }); // installs the in-page decorations

await page.goto(url, { waitUntil: 'domcontentloaded' }); // load first, so the video doesn't open on a blank page
await rec.startCapture();

await rec.caption('Search narrows the product list');
await rec.fill(page.getByRole('searchbox'), 'lamp');
await rec.press('Enter');

await rec.caption('Every result is a lamp');
const titles = page.locator('.product-title');
await titles.first().waitFor();
assert.match(await titles.first().innerText(), /lamp/i); // assert first…
await rec.checkAll(titles);                              // …then show the proof
await rec.highlight(page.locator('.results'));       // point at the whole result list

await rec.stopCapture();
await rec.render('<output>.mp4');
await browser.close();
```

Assert with `node:assert` and Playwright's locator waits; `@playwright/test`'s `expect` only works if that package is installed. Run it with `node`. Look at the result before handing it over: extract a few frames with ffmpeg (`ffmpeg -ss 5 -i <output>.mp4 -frames:v 1 <frame>.png`) and view them.

## API

| Call | What the viewer sees |
|---|---|
| `Recorder.attach(page, { workDir })` | Nothing yet. Adds the decorations (frames, ripples) to the browser context. Call it before the first navigation. |
| `startCapture()` / `stopCapture()` | Start and stop recording. `stopCapture` also hides the caption. |
| `render(out.mp4)` | Writes the video. Takes about as long as the video itself. |
| `caption(text)` | A dark caption at the bottom. It stays until the next caption; `null` or `''` hides it. It survives navigation and zoom. |
| `goto(url)` | Navigates and waits for the network to settle. |
| `click(loc)` | The cursor glides to the element on a slight arc, then a ripple shows the click. |
| `fill(loc, text)` | Glides to the field, clicks it, and types visibly at 55 ms per key. |
| `press(key)` | A key press. |
| `hover(loc)` | Glides to the element and rests there. |
| `check(loc)` | A green frame: something the video proves. Call it after your assertion passes. |
| `checkAll(loc)` | Green frames on each match, up to 8 (e.g. every cell of a filtered column). |
| `highlight(loc)` | One blue frame around everything `loc` matches, as a single box, with the cursor pointing at it. |
| `zoomTo(loc)` / `zoomOut()` | Smooth camera zoom onto an element (up to 1.8×) and back. |
| `wait(ms)` | A pause, e.g. to let the viewer read. |
| `glideTo(loc)`, `glideToPoint({x,y})`, `outline(loc, color, ms)`, `clearFrames()` | Lower-level building blocks. |

Use `page` directly for anything the viewer shouldn't see: assertions, waits and reading data.

## Built-in behaviour (don't fight it)

- **Frames:** four corner brackets glide in around the element, the rest of the page dims slightly (13%) through a cut-out, and a 5% tint covers the element. Frames shown at the same time share one dim layer, so a burst of checks doesn't darken the page. A frame stays up for its draw time plus about 1.1 s, then fades over 0.5 s. Green means checked; blue means "look here".
- **Nothing happens under a frame.** `click`, `fill`, `press`, `goto` and zooms first wait for every visible frame to clear. Each frame gets at least 1.2 s on screen, then fades in 0.25 s. The cursor may move while frames are up: `click` and `fill` glide first, and only the click or typing waits.
- **No scrolling under a frame.** Frames are fixed to the screen, so before scrolling an off-screen element into view, the recorder clears frames first. Elements already fully on screen don't wait.
- **The cursor** is drawn by ffmpeg along an eased arc (450–1100 ms by distance). The real mouse jumps to the target at the end, so hover states match what's drawn.
- **Captions** are scaled with the camera so they read the same size when zoomed. They're hidden while the camera moves and come back when it settles.
- **Zoom skips itself** when the element is already large (the zoom would be under 1.15×), so a wide target doesn't produce a pointless camera move.
- **Capture follows the scroll position**, so pages that scroll the window record correctly.

## Directing the video

- **One caption per beat.** Set it at the start of each beat: under about 70 characters, sentence case, saying what the viewer is about to see ("Every result is a lamp"), not what the code does.
- **Zoom is optional, and most videos need none.** At 1440×900, normal page text reads fine at full frame. Zoom only when the detail that proves the point would be hard to read otherwise: small text in a dropdown, a tooltip or a dense table cell. Never zoom on headings, whole pages, forms or panels that are already large, and never just to add motion. Zoom onto the smallest area that keeps the small detail readable *and* its context in shot (its label, the button it affects), rather than onto the tiny element alone. If you do zoom, `zoomOut()` before interacting with anything outside the zoomed area.
- **Show proof, not just navigation.** End each beat on a `check`, `checkAll` or `highlight` of the outcome: the filtered rows, the saved value, the error message.
- **Green or blue?** Green (`check`) for what the video proves; blue (`highlight`) to point at an area the viewer should look at. Don't use both on the same element in the same beat.
- **Length:** as long as the story needs and no longer. A single action can be 10–15 seconds; a multi-step flow usually takes 20–45. Split stories longer than about a minute into several videos, and don't pad short ones.
- **Data:** never record secrets. Log in before `startCapture()`, and keep personal data out of videos that will be shared.

## Troubleshooting

- **No frames or ripples appear:** the decorations load with each page, so call `Recorder.attach` before the first `goto`.
- **The first seconds are blank:** load the page before `startCapture()`.
- **`Unrecognized option '-/filter_complex'`:** ffmpeg is older than 7; upgrade it.
- **The video jumps or frames end up in the wrong place after a scroll:** scroll through the recorder's actions (they clear frames first), not with `page.mouse.wheel` or `scrollIntoViewIfNeeded` while frames are up.
- **The scratch dir fills up:** frames are JPEGs at about 15 fps and 2×, roughly 150 KB each. `startCapture` wipes `workDir`; delete it after rendering if space matters.
