---
name: screenplay
description: Record an annotated screencast of any UI flow using Playwright's `page.screencast` API. Author scenes with chapter cards, bounding-box highlights, and sticky badges — produces a polished WebM walkthrough video, no manual editing or post-processing. Use when the user asks for a "walkthrough video", "demo recording", "annotated screencast", "narrated test", "flow recording", or wants to produce review-ready video evidence of a feature working.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Screenplay

Author and record an annotated walkthrough video of a UI flow. Built on top of Playwright 1.59's `page.screencast` API and the `playwright-cli` skill.

The user describes the flow they want demonstrated. You author a JS storyboard, run it via the wrapper, and deliver a `.webm` with chapter cards, color-coded element highlights, sticky URL badges, and auto-action overlays baked in by Playwright. No `ffmpeg` post-processing. No editor.

## When to use this skill

Trigger words: *walkthrough*, *demo*, *annotated screencast*, *narrated recording*, *flow video*, *show me on video that X works*.

Skip this skill for:
- Throwaway captures where a screenshot would do
- Video editing of an existing recording (use `ffmpeg` directly)
- Test automation that doesn't need a viewable artifact (just write a Playwright test)

## What you need from the user

1. **Detailed flow description** — required. What scenarios to demonstrate, what success/failure looks like, the expected starting state. Specifics like "show that searching for 'Jack' returns one row, then that 'ZZZNonExistent' returns no data" beat "show search working".
2. **(optional)** Page URL or where to find it. Discover via the codebase or `playwright-cli snapshot` if not given.

If the description is vague, ask one targeted question — don't ask a list. Example: "Should I cover the empty-state and reset cases too, or just the happy path?"

You — not the user — figure out:
- Stable locators (via interactive `playwright-cli snapshot`)
- Scene order and chapter copy
- Highlight colors and badge text
- Pacing (typing delay, waits between scenes)

## Pre-requisites

The user must have:

1. **Chrome with remote debugging enabled.** Easiest setup:
   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
       --remote-debugging-port=9222
   ```
   On Linux: `google-chrome --remote-debugging-port=9222`

2. **`playwright-cli` attached to that Chrome:**
   ```bash
   npx playwright-cli attach --cdp=http://localhost:9222
   ```

3. **Logged into the target app** in that Chrome session.

4. **`ffprobe`** (part of `ffmpeg`) for the post-run size/duration report. Optional.

If any of these aren't true, halt and ask the user to set them up — don't guess.

## Workflow

```
1. Confirm pre-reqs       ← Chrome + attached + logged in
2. Discover               ← snapshot the page, find locators
3. Author                 ← copy template, fill in scenes
4. Record                 ← bash record.sh path/to/flow.js
5. Verify                 ← ffmpeg-sample a few frames; report durations
```

### 1. Confirm pre-reqs

```bash
npx playwright-cli list       # is anything attached?
npx playwright-cli tab-list   # is the target app's tab open?
```

If `tab-list` doesn't show the right URL, ask the user to switch the tab or run `tab-select <n>`.

### 2. Discover locators

Don't guess locators from memory or from grep — verify them live.

```bash
# Navigate to a clean state first
npx playwright-cli goto "<URL without query params>"
# Snapshot the page; grep for the elements you need
npx playwright-cli --raw snapshot > /tmp/snap.yml
grep -i "<keyword>" /tmp/snap.yml
```

For each interactive element, prefer in this order:

| Priority | Locator | Example |
|---|---|---|
| 1 | role + name | `getByRole('button', { name: 'Submit' })` |
| 2 | text | `getByText('Empty state')` |
| 3 | testid | `getByTestId('foo-input')` |
| 4 | css | last resort |

Role/text locators make the auto-action overlays from `page.screencast.showActions()` read like *"Click button: Submit"* instead of `[data-testid=…]`. Worth the extra effort.

If a column header's accessible name changes when sorted/filtered (e.g., `"State sortable"` → `"State caret-up caret-down filter"`), anchor on a regex prefix: `getByRole('columnheader', { name: /^State/ })`.

### 3. Author the storyboard

Copy `template.js` to a new file, e.g. `record-<flow-name>.js`. The file MUST be a single async-arrow expression — no top-level `import`, no surrounding statements.

Skeleton:

```js
async (page) => {
    // >>>HELPERS<<<           ← replaced with helpers.js at run time

    const URL = '...';
    const OUTPUT = '<dir>/playwright-recording-<flow-name>.webm';

    await page.goto(URL);
    await page.waitForLoadState('networkidle');
    await page.getByText(/baseline assertion/).waitFor({ timeout: 15000 });
    await wait(500);

    await page.screencast.start({ path: OUTPUT, size: { width: 1280, height: 800 } });
    await page.screencast.showActions();

    await chapter('Scene title', 'description');
    // … actions, highlights, badges …

    await chapter('Flow Name — Verified ✓', 'summary', 2400);
    await page.screencast.stop();
}
```

`OUTPUT` is relative to the playwright-cli working directory (typically the repo root). Pick a path inside the user's project — not under the skill folder.

### 4. Run the wrapper

```bash
bash <skill-dir>/record.sh path/to/record-<flow-name>.js
```

The wrapper:
- Inlines `helpers.js` at the `// >>>HELPERS<<<` marker
- Strips a trailing `;` after the closing `}` (Prettier may re-add it; harmless)
- Runs `npx playwright-cli run-code --filename=<tmp>`
- Reports the output file's duration + size on success

### 5. Verify

Sample 3–5 frames at expected scene boundaries to confirm overlays rendered:

```bash
ffmpeg -y -loglevel error -ss <T> -i <output>.webm -frames:v 1 -update 1 /tmp/frame-<T>s.png
```

Then `Read` the PNG to confirm. Don't claim success without visual verification.

## Helpers (in scope after injection)

| Helper | Purpose |
|---|---|
| `wait(ms)` | shorthand for `page.waitForTimeout(ms)` |
| `chapter(title, description, durationMs?=2200)` | full-screen card with blurred backdrop + matching wait |
| `highlightBox(locator, label, opts?)` → disposable \| `null` | colored outline + caption around an element. Returns `null` if locator isn't visible. |
| `stickyBadge(text, position?, tone?)` → disposable | corner badge that stays until `.dispose()` |

`highlightBox` opts:
- `color` — CSS color string (default `'rgb(255, 79, 79)'` red)
- `duration` — ms; omit for a sticky overlay that you dispose manually
- `side` — `'top'` \| `'bottom'` (default `'bottom'`) — where the label goes

`stickyBadge` positions: `top-right` (default) \| `top-left` \| `top-center` \| `bottom-right` \| `bottom-left` \| `bottom-center`.
`stickyBadge` tones: `success` (green) \| `info` (blue) \| `warn` (orange) \| `error` (red) \| `neutral` (gray).

Pick **center** positions when the corners might overlap a banner (e.g., a staff/dev mode warning across the top of the page).

## Authoring guidance

- **Sync barriers, not blind waits.** After every state change, anchor on a visible cue (`getByText(/N - M of K/).waitFor()` or `page.waitForURL(/foo/)`) before measuring `boundingBox()`. Layout must settle before highlights are drawn.
- **Pacing.** Typing: `pressSequentially('text', { delay: 60-80 })`. Highlight `duration`: 1500–2200 ms reads naturally. Chapter cards: 2000 ms is enough for a short title; 2400 ms for an outro.
- **Idempotency.** Always `goto(URL)` (without query params) at the top so re-runs start clean. Filter/sort URL params persist across sessions.
- **Color discipline.** Use color to distinguish scene types — e.g., green for "success / asserted result", blue for "ascending", orange for "descending", red for "error / empty state", gray for "cleared / neutral". Pick a palette per flow and stick to it.
- **Don't over-narrate.** Chapter cards say WHAT this scene demonstrates. The auto-action overlays from `showActions()` already say WHAT each click is. Don't restate them in `highlightBox` labels — use those for the *consequence* ("✓ Filtered to Jack Smith"), not the action.

## File contract recap

`record-<flow-name>.js`:
- Single async-arrow expression: `async (page) => { ... }`
- Contains `// >>>HELPERS<<<` marker (anywhere inside the function)
- Defines `const URL` and `const OUTPUT`
- `goto` → preflight assertion → `screencast.start` → `showActions` → scenes → `screencast.stop`
- No trailing `;` (wrapper strips it but cleaner without)

## Files in this skill

| File | Role |
|---|---|
| `SKILL.md` | this document |
| `helpers.js` | overlay/wait helpers, injected at `// >>>HELPERS<<<` |
| `template.js` | starter template — copy and edit per flow |
| `record.sh` | wrapper: inject helpers, strip trailing `;`, run via playwright-cli |
| `examples/search-by-name.js` | reference: filter a table by typed text, exact / no-match / partial / reset scenes |
| `examples/sort-by-state.js` | reference: cycle a sortable column ascending → descending → unsorted |

## Common gotchas

- **`SyntaxError: Unexpected token ';'`** — your file ends with `};`. The wrapper should strip it; if not, edit the source to end with `}`.
- **`Locator not found`** — your locator was correct in your snapshot but the page re-rendered after an action. Re-snapshot via `playwright-cli` and update; or use a regex / common-prefix locator if the accessible name is shifting.
- **Bounding box is `null`** — element isn't visible (off-screen, behind modal, or not yet rendered). Add a `waitFor()` before `highlightBox()`.
- **Recording captures the wrong tab** — the attached browser may be on a different tab. Run `playwright-cli tab-list` and `tab-select <n>` before recording. The flow's `goto(URL)` will navigate the *current* tab.
- **Output file isn't created** — the `OUTPUT` path is relative to the playwright-cli working directory. Run `record.sh` from the project root, or use an absolute path.

## When you're done

Tell the user:
- The output path
- Duration and size
- Approximate scene timestamps (for jump-to navigation)
- Optionally: offer to generate a single-page viewer HTML that embeds the video alongside the script with scene-jump buttons (see `examples/` for the pattern used in the Medallion project).

Don't claim success without sampling at least one frame from each scene and visually confirming the overlay is there.
