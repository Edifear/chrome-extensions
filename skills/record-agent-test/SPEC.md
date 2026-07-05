# SPEC — Agent Flow Studio v1

**Building on:** `record-agent-test` (Claude Code drives a page, Playwright codegen writes the test)
**Two pillars:** ① seamless, human-like flow videos, ② speed of generation
**Scope decisions:** full flow package · session daemon in v1 · lightweight built-in progress · local/demo targets first (auth in v2)
**Audience:** an implementing agent with access to this repo. Everything needed to build v1 is in this document plus the referenced source files. Part A is the design contract; Part B is the task-level plan with acceptance checks.

---

# Part A — Design

## 1. Product statement

One natural-language prompt in → one **reviewable flow package** out, in well under a minute of tool time:

```
~/Recordings/<flow>/          (RECORDINGS_DIR, default ~/Recordings — outside the repo)
├── flow.spec.ts       # copy of the recorded, asserted Playwright test (proven green)
├── recording.webm     # human-like annotated demo video of the flow
├── scenes.json        # exact per-scene timestamps, emitted DURING filming
├── journal.json       # the action journal — source of truth for the film
├── index.html         # self-contained viewer: video + timeline + transcript + spec
└── run.json / run.log # phase timings + full log
```

The canonical runnable spec lands in `tests/<flow>.spec.ts` so `npx playwright test` and CI
pick it up; the package's `flow.spec.ts` is a byte-identical copy for the self-contained viewer.
Packages are review artifacts, not source — they land outside the repo (`RECORDINGS_DIR`,
default `~/Recordings`); `recordings/<flow>/` below refers to that package dir.

What changes vs. today:

| | Today | v1 |
|---|---|---|
| Agent turn (tool side) | ~935 ms (fresh Node + CDP handshake per command) | **≤150 ms** (persistent daemon, bench-proven ~120 ms) |
| Video | mechanical replay: constant slowMo, instant fills, teleporting between fields | **human-like**: eased cursor travel, per-char typing, hover-then-click, read-time dwells, annotations |
| Video sync metadata | none | `scenes.json` written **while filming** — exact, never desyncs |
| Assertions | one testid+contains at `finish` | multiple, declarable mid-flow; rendered as callouts in the video |
| Artifacts | `tests/generated.spec.ts` + bare `.webm` | full package + viewer |
| Progress | console logs | `.run/progress.json` + `status` command |

## 2. Architecture

```
┌────────────┐  thin client, unix socket, ~50ms   ┌──────────────────┐   CDP (warm)   ┌────────────┐
│ session.mjs │ ─────────────────────────────────▶ │ studio/daemon.mjs │ ─────────────▶ │ recorder    │
│ (per turn)  │   verb + args → result + snapshot  │ (persistent)      │  one connection │ .mjs        │
└────────────┘                                     │ · executes verbs  │                │ (codegen,   │
      ▲                                            │ · writes journal  │                │  unchanged) │
   Claude Code                                     │ · progress.json   │                └────────────┘
                                                   └──────────────────┘
        after finish (daemon orchestrates, both passes in parallel):
        journal.json ──▶ studio/film.mjs (interprets journal directly) ──▶ recording.webm + scenes.json
        tests/<flow>.spec.ts ──▶ assert pass: npx playwright test tests/<flow>.spec.ts (headless)
        then: studio/viewer.mjs ──▶ index.html · package assembly ──▶ recordings/<flow>/
```

**The recorder is untouched.** It still owns the browser and turns DOM events into the spec.
Only the *client side* changes: instead of paying Node startup + `import('playwright')` + CDP
handshake on every agent action (~935 ms, of which ~285 ms is the import alone — see
`bench/RESULTS.md`), a persistent daemon holds the warm connection and thin clients talk to it
over a unix socket (~54 ms client floor, 7.9× speedup at p50).

**The journal is the second product of driving.** Every verb the daemon executes appends an
entry. The generated spec (codegen) and the film (journal) derive from the *same live actions*,
so they can't diverge in substance; the assert pass proves the spec, the film pass replays the
journal. There is **no intermediate "filmscript"** — `film.mjs` interprets `journal.json`
directly.

### 2.1 Module & file map

New code lives in a `studio/` directory at the repo root. The skill keeps only the thin client.

| File | Status | Role |
|---|---|---|
| `studio/daemon.mjs` | **new** | persistent session daemon: CDP connection, verb execution, journal, progress, finish orchestration. The only studio file that imports `playwright`. |
| `studio/ipc.mjs` | **new** | socket client library used by `session.mjs`. Imports only `node:net` — **must never import playwright** (that import is the 285 ms being deleted). |
| `studio/locators.mjs` | **new** | locator serialization/resolution shared by daemon and film (§4.1). |
| `studio/snapshot.mjs` | **new** | snapshot capture + diffing (§2.3). Extracted from today's `session.mjs snapshot()`. |
| `studio/motion.mjs` | **new** | human-motion primitives (§3.2). Pure JS + a `page`; no deps. |
| `studio/overlays.mjs` | **new** | chapter/highlight/badge helpers, ported from `~/.claude/skills/screenplay-global/helpers.js` (adapted: ESM exports taking `page` explicitly, not injected-scope). |
| `studio/film.mjs` | **new** | `node studio/film.mjs --journal <path> --out <dir>` — interprets the journal, records the webm, writes scenes.json. Plain script, no test runner. |
| `studio/viewer.mjs` | **new** | renders `index.html` from scenes.json + journal.json + spec source. Template inlined or in `studio/viewer-template.html`. |
| `.claude/skills/record-agent-test/scripts/session.mjs` | **rewritten** | thin argv→socket forwarder (~80 lines). `start` spawns the daemon; everything else forwards. No playwright import. |
| `.claude/skills/record-agent-test/SKILL.md` | **rewritten (M4)** | new loop: inspect → `do` bursts → `scene`/`assert` → `finish`. |
| `postprocess.mjs` | **modified** | `enrichTest()` accepts an array of assertions; title from summary. Keep backward-compatible signature (single assertion object still works). |
| `recorder.mjs`, `server.mjs`, `run.mjs`, `agent.mjs` | unchanged | scripted demo path still works. |
| `playwright.config.ts` | unchanged | already picks up `tests/**`. |
| `screencast.fixtures.ts`, `playwright.screencast.config.ts` | **deleted (M4)** | replaced by `film.mjs`. |
| `bench/bench-session.mjs` | **new (M1)** | measures p50/p95 of a `session.mjs fill` turn against the daemon, same methodology as `bench/bench-a.mjs`. |

No new npm dependencies. Unix socket = `node:net`; bezier/easing/jitter = hand-rolled math;
ffmpeg/ffprobe used only in verification and only if present (skip with a warning otherwise).

### 2.2 Daemon lifecycle & IPC protocol

**Startup.** `session.mjs start` spawns `studio/daemon.mjs` detached (stdout/err → `.run/daemon.log`),
then connects to the socket and issues the `start` verb, which does everything today's `cmdStart`
does (boot static server if the URL isn't reachable, spawn `recorder.mjs`, wait for
`.run/recorder-ready`, connect over CDP, print first snapshot). PIDs land in `.run/session.json`
`{daemonPid, serverPid, recorderPid, socket, formUrl, outFile, flow}`.

**Socket.** Path: `.run/session.sock` (repo-root-relative; macOS/Linux only by decision §12).
On boot the daemon unlinks a pre-existing socket file only after confirming the PID in
`.run/session.json` is dead; if it's alive, exit 7 ("session already running").

**Framing.** Newline-delimited JSON, one request per line:

```jsonc
→ { "id": 1, "verb": "fill", "args": { "label": "Full name", "value": "Grace Hopper", "note": "…" } }
← { "id": 1, "ok": true, "result": "filled \"Full name\"", "snapshot": "<diff or full text>" }
← { "id": 2, "ok": false, "error": "locator \"Full nam\" matched 0 elements", "snapshot": "<fresh full snapshot>" }
```

- One in-flight request per connection; the client opens a connection per command (connect cost
  on a unix socket is negligible).
- Client timeout: 30 s per request (page actions have Playwright's own timeouts inside), then
  exit 8 with a pointer to `.run/daemon.log`.
- **Every error response carries a fresh full snapshot** so the agent can recover in one turn.
- Dead socket (`ECONNREFUSED`/`ENOENT`) → the client prints exactly how to recover:
  `"no live session — run: node …/session.mjs start"` and exits 9.

**Shutdown.** `finish`/`stop` run teardown (below), respond, then exit. Idle self-termination
after `RECORDER_IDLE_TIMEOUT_MS` (default 30 min, matches today) kills the recorder + server too
and removes the socket.

**Crash safety.** The journal and progress files are written after *every* verb with
tmp-file+rename (atomic). If the daemon dies mid-drive, `.run/journal.json` is intact; `start`
detects the stale session, cleans up, and begins fresh (the old journal is moved to
`.run/journal.prev.json`).

### 2.3 Snapshot diffing (token speed, not just process speed)

Real wall-clock per turn = tool time + LLM read/decide time. Payload size drives the latter.

- First snapshot of a session: full (same format as today — `studio/snapshot.mjs` reuses the
  exact `page.evaluate` from current `session.mjs`).
- Subsequent snapshots: a diff against the previous snapshot's parsed control list, matched by
  `(kind, label/name/testid)`:

  ```
  Changed:
  - text "Full name" = "Grace Hopper"            (was "")
  - region testid="invite-modal" now visible: "…"
  Unchanged: 11 controls, 6 regions (snapshot --full to see all)
  ```

- Rules: a control appears under `Changed:` when its value/checked/visibility/text changed, or
  it's new; regions whose visibility flipped ALWAYS appear. Text of a changed region is printed
  in full (it's what the agent asserts on).
- `snapshot --full` forces the full view. Error responses always include a full snapshot.
- State for diffing lives in daemon memory (previous parsed snapshot).

### 2.4 Batch verb (LLM round-trip speed)

The dominant real-world cost is Claude's turns, not tool time. When the agent already knows the
next several actions (it just read the form), it does them in one call:

```
session.mjs do --plan '[
  {"verb":"fill","label":"Full name","value":"Grace Hopper","note":"Enter the invitee name"},
  {"verb":"fill","label":"Work email","value":"grace@acme.dev"},
  {"verb":"select","label":"Team","option":"Design"}
]'
```

- Executes sequentially in the daemon with the same per-verb pacing the recorder needs
  (`PACE_MS` between steps, exactly like separate calls — recorder fidelity must not regress).
- Stops at the first failure; the response says which step index failed and why, plus a fresh
  full snapshot. Journal keeps the successful prefix.
- Each step is a separate journal entry — the film still shows every action individually.
- Allowed verbs inside a plan: `fill`, `select`, `toggle`, `click`, `goto`, `scene`, `assert`
  (no nested `do`, no `finish`).
- Skill guidance: open/inspect steps stay single (`click` → read snapshot); form-filling bursts
  go through `do`. Typical flow: 3–4 agent turns instead of 9.

## 3. The film: human-like look and feel

### 3.1 Why a film pass (not filming the live drive)

The live drive has LLM thinking gaps (seconds to minutes) between actions — filming it means
dead air or ffmpeg surgery. Instead, `finish` triggers two parallel passes:

- **Assert pass** — `npx playwright test tests/<flow>.spec.ts` headless, no pacing (~1–2 s).
  **Scoped to the flow's spec file** — the repo may contain unrelated/red specs
  (`tests/ogm-finding-detail.spec.ts` targets an app that isn't running); never run the whole dir.
- **Film pass** — `node studio/film.mjs --journal .run/journal.json --out recordings/<flow>/`
  replays the journal in a fresh browser (own chromium launch, `viewport` from the journal)
  with the motion engine and annotations, recording via `page.screencast`.

Parallel is safe: different browsers, same static server, both read-only against the app.
(The daemon keeps the static server alive until both passes finish, then tears it down.)
Film-pass overhead beyond the video's own runtime: ≤5 s (browser launch + encode flush).

### 3.2 Motion engine (`studio/motion.mjs`) — the human-feel contract

Every primitive is jittered; nothing happens at a constant rate. Randomness comes from a
**seeded PRNG (mulberry32 or equivalent), seeded from the flow slug** — re-filming the same flow
produces the same motion (deterministic artifacts, diffable timings).

The engine tracks the current virtual cursor position (start: viewport center) since Playwright
doesn't expose it.

| Primitive | Behavior |
|---|---|
| `humanMove(page, target)` | Resolve target center via `boundingBox()` (throw if null — see sync rules). Cursor travels a **quadratic bezier** whose control point is offset perpendicular to the straight line by 5–15% of its length (seeded), with **ease-in-out** timing. Duration = clamp(distance ÷ 1.4 px/ms, 250, 900) ms, sampled at ~60 fps via chained `mouse.move`. Moves >600 px overshoot the target by 8–20 px and correct back over ~120 ms. |
| `humanClick(page, target)` | `humanMove` → hover dwell **150–350 ms** → `mouse.down/up` at center + gaussian jitter, clamped to ≤30% of box half-extent per axis. |
| `humanType(page, target, text)` | `humanClick` to focus → pause 200–350 ms → `pressSequentially`-style typing at **55–95 ms/char** (per-char jitter), plus a 150–250 ms breath after every 2–4 words. **No fake typos, ever** (§12). |
| `humanSelect(page, target, option)` | `humanClick` to open → 300–500 ms viewing pause → `selectOption` → 200 ms. |
| `humanScroll(page, target)` | If target is outside the viewport: `mouse.wheel` in 80–120 px steps every ~30 ms until visible plus 40 px margin — never `scrollIntoViewIfNeeded` teleports. |
| `settle(page, beforeText)` | Read-time dwell after a state change: capture `document.body.innerText` before the action; after it, dwell = 600 ms + 30 ms × (word count of newly-added text), capped 2500 ms. "Newly added" = words in after-text minus before-text (multiset diff is overkill; simple length-of-set-difference is fine). |

Film-pass sync rules (before each journal action):
1. Resolve the locator (§4.1); `locator.waitFor({ state: 'visible', timeout: 10000 })`.
2. `humanScroll` if needed, then the human primitive (Playwright's own actionability checks
   still apply inside click/fill).
3. After the action, `settle()` — then the next entry.

Global pacing rules:
- `goto(url)` → `waitForLoadState('networkidle')` → `screencast.start` → 1 s on the settled page
  before the first annotation (viewers orient first).
- `page.screencast.showActions({ position: 'bottom' })` for auto action toasts. Note: `showActions`
  narrates *real* input events, so the human primitives (which use `mouse.*`/keyboard) are what
  make its toasts appear naturally paced.
- Target total runtime **25–45 s**. Before filming, estimate runtime from the journal (Σ motion
  durations + dwells + cards); if the estimate exceeds 50 s, log a warning naming the largest
  dwells being auto-compressed (scale dwells down proportionally to fit ~45 s; never compress
  typing or cursor motion — realism first, dwells are the slack).
- `PERSONA` env: `calm` (default, 1.0×) / `snappy` (0.6× on all dwells/pauses, cursor speed
  1.5×; typing delay floor 40 ms). No other tiers (§12).

### 3.3 Annotations (ported from screenplay's helpers, auto-placed)

Screenplay's overlays (`chapter`, `highlightBox`, `stickyBadge` — port from
`~/.claude/skills/screenplay-global/helpers.js` into `studio/overlays.mjs`), but **synthesized
from the journal instead of hand-authored**:

- **Chapter cards** (2–4 per film): intro card (flow title + `summary`), one card per
  agent-declared `scene` entry, outro card (`<Flow title> — Verified ✓` + one line per
  assertion). If the agent declared >2 scenes, scenes 3+ render as sticky-badge changes instead
  of cards (cards blank the UI ~2.4 s each; the budget is fixed).
- **Sticky badge**: current scene title, `top-right`, `info` tone, swapped at each scene
  boundary. Disposed before the outro card.
- **Highlights on consequences, not actions**: the action toasts already narrate clicks and
  fills. Highlights are reserved for *results*. v1 rule: highlight exactly the regions named by
  `assert` entries (green outline + caption = the asserted text, truncated to 60 chars).
- **Assertion callouts**: at an `assert` entry, the film waits for the condition
  (`getByTestId(X)` visible + `textContent` includes `contains`, timeout 10 s), highlights the
  element green, shows a `✓ <title>` badge for 1.5 s, and records scene kind `assert`.
  **If the condition never holds, the film exits non-zero** — a video of a broken flow must
  never ship.

### 3.4 `scenes.json` — timestamps that cannot drift

`film.mjs` stamps **actual elapsed time** (ms since `screencast.start`, from
`process.hrtime.bigint()`) as it films:

```json
[
  { "t": 0.0,  "kind": "chapter", "title": "Invite a teammate", "assertion": null },
  { "t": 2.4,  "kind": "action",  "title": "Open the invite modal", "assertion": null },
  { "t": 11.8, "kind": "action",  "title": "Submit the invite", "assertion": null },
  { "t": 14.2, "kind": "assert",  "title": "Invite confirmed",
    "assertion": "invite-banner contains \"Invite sent to Grace Hopper (grace@acme.dev)\"" }
]
```

One `action` entry per journal action (its `t` = when the human primitive began), one `chapter`
per card, one `assert` per assertion. The viewer consumes this directly; the timeline is exact
by construction.

## 4. Journal schema (`.run/journal.json` → `recordings/<flow>/journal.json`)

Written incrementally (atomic rename) by the daemon; the film interprets it directly.

```jsonc
{
  "flow": "invite-teammate",              // slug, see finish
  "url": "http://localhost:5188/team.html",
  "startedAt": "2026-07-04T15:00:00Z",
  "viewport": { "width": 1280, "height": 800 },   // read from the live page at start
  "entries": [
    { "i": 1, "verb": "scene", "title": "Invite a teammate", "desc": "Open the modal and send an invite" },
    { "i": 2, "verb": "click", "target": { "kind": "button", "name": "Invite member" },
      "note": "Open the invite modal", "ms": 87 },
    { "i": 3, "verb": "fill", "target": { "kind": "label", "label": "Full name" },
      "value": "Grace Hopper", "ms": 64 },
    { "i": 4, "verb": "select", "target": { "kind": "label", "label": "Team" }, "option": "Design" },
    { "i": 5, "verb": "assert", "testid": "invite-banner",
      "contains": "Invite sent to Grace Hopper (grace@acme.dev)", "title": "Invite confirmed" }
  ],
  "summary": "invites a new teammate from the modal and sees the invite confirmed",
  "finishedAt": "2026-07-04T15:02:10Z"
}
```

- `ms` = daemon-side execution time per verb (feeds run.json stats; optional).
- `note` is optional per action → caption copy; absent → auto-copy from the verb
  ("Fill Full name", "Click Invite member").
- `scene` entries cost nothing at drive time (no page interaction).
- `assert` entries can appear mid-flow, not just at the end.

### 4.1 Locator contract (`studio/locators.mjs`)

The journal stores the **agent's target description**, not a locator string — and one module
owns the description→locator mapping for both the daemon (live drive) and `film.mjs` (replay),
so the film targets exactly what the agent targeted:

```js
// target descriptors               // resolveTarget(page, target) → Locator
{ kind: 'label',    label }         // getByLabel(label, {exact:true}) → fallback non-exact .first()   (today's locForLabel)
{ kind: 'button',   name }          // getByRole('button', {name, exact:true}) → fallback non-exact .first()
{ kind: 'text',     text }          // getByText(text).first()
{ kind: 'css',      selector }      // locator(selector).first()
{ kind: 'testid',   testid }        // getByTestId(testid)
```

This is exactly today's resolution logic, extracted. If resolution is ambiguous or matches 0
elements at film time (page changed since drive), `film.mjs` fails loudly naming the entry index.

## 5. Session command surface (v1 delta)

Existing verbs keep their flags: `start`, `snapshot`, `fill`, `select`, `toggle`, `click`,
`finish`, `stop`.

New / extended:

| Command | Purpose |
|---|---|
| `do --plan '<json>'` | batch several verbs in one agent turn (§2.4) |
| `scene --title "…" [--desc "…"]` | declare a chapter boundary (journal-only, instant) |
| `assert --testid X [--contains "…"] [--title "…"]` | declare an assertion; the daemon verifies it live immediately (10 s wait, error + snapshot if it never holds) and journals it. Feeds both the spec enrichment and the film. |
| `goto --url "<url>"` | navigate the live session (deep link / recover from an app redirect). Journaled; guaranteed in the spec as `page.goto(…)` at its journal position (codegen's own record is matched when present, injected otherwise). Warns when leaving the session origin. |
| `* --note "…"` | optional on `fill`/`select`/`toggle`/`click`/`goto`: human copy for the video |
| `status` | pretty-print `.run/progress.json` (phase, step count, elapsed) |
| `finish --flow <slug> [--summary "…"] [--no-film] [--no-frame-check]` | full pipeline (§5.1). `--flow` is kebab-cased (`[a-z0-9-]{1,48}`); default: slugified summary, else `flow-<yyyymmdd-hhmm>`. Existing `--assert-*` flags remain as sugar for a final `assert`. |

### 5.1 `finish` pipeline (runs inside the daemon)

1. Stop the recorder (today's stop-file handshake), wait for the spec flush.
2. Enrich: `postprocess.mjs` injects title (from summary) + **all** journal assertions, in order.
3. Move/rename spec → `tests/<flow>.spec.ts`.
4. Spawn in parallel: assert pass (`npx playwright test tests/<flow>.spec.ts`) and film pass
   (`node studio/film.mjs …`), unless `--no-film`.
5. Both green → assemble `recordings/<flow>/` (copy spec, move webm/scenes/journal, render
   viewer via `studio/viewer.mjs`, write run.json/run.log from progress data).
6. Frame check (§8.3) unless `--no-frame-check`.
7. Stop static server, remove socket, exit. Print the package path + per-phase timings.

Failure handling: assert pass red → keep the spec and journal, skip packaging, exit non-zero
with the playwright output (the agent decides whether to re-drive). Film pass red but assert
green → package everything except video/viewer, exit non-zero flagging the film failure. Nothing
is ever deleted on failure; `.run/` keeps the working state for diagnosis.

## 6. Progress (lightweight, no dashboard)

`.run/progress.json`, updated by the daemon on every verb and phase transition (atomic rename):

```json
{ "flow": "invite-teammate", "phase": "film",
  "phases": {
    "drive":  { "state": "done", "steps": 9, "ms": 1840 },
    "assert": { "state": "done", "ms": 2100 },
    "film":   { "state": "running", "startedAt": "…" },
    "package":{ "state": "pending" } } }
```

- Phases: `drive → assert ∥ film → package`. States: `pending | running | done | failed | skipped`.
- `session.mjs status` pretty-prints it; the finish pipeline also logs phase transitions to
  stdout so the Claude Code transcript shows progress without polling.
- Archived into the package as `run.json` (final progress + timings + env knobs used) and
  `run.log` (the daemon's log lines, time-prefixed).

## 7. Viewer (`index.html`)

Generated by `studio/viewer.mjs` from `scenes.json` + `journal.json` + the spec source — no
hand-edited `__MARKER__` placeholders (screenplay's approach, automated). Start from
`~/.claude/skills/screenplay-global/viewer-template.html` as the visual base.

- video + clickable timeline: gray pills = chapters, green = actions, check-marked = asserts
  (exact `t` from `scenes.json`)
- transcript rows: scene title + caption; assert rows show the assertion text in a green callout
- collapsible panels: the spec source (`flow.spec.ts`) and the raw journal
- fully self-contained: inline CSS/JS, `<video src="recording.webm">` relative — works from any
  static file server (`python3 -m http.server` from the repo root)

## 8. Verification discipline

`finish` does not report success until all three hold:

1. **Assert pass green** — `tests/<flow>.spec.ts` passed headless (scoped run, §3.1).
2. **Film integrity** — scenes.json entry count == journal actions + chapters + asserts; webm
   duration (ffprobe, if available) within ±20% of the last scene `t` + 3 s; film exited 0.
3. **Frame sampling** — extract 3 frames (`t` of: intro card, middle action, last assert callout)
   via `ffmpeg -ss <t> -frames:v 1`; the *agent* `Read`s them and visually confirms the overlays
   rendered. ~2 s. Skippable with `--no-frame-check`; skipped automatically (with a printed
   warning) when ffmpeg is absent.

## 9. Speed budget (exit criteria)

Measured on the invite-teammate flow (9 actions, 1–3 scenes, 1 assertion) on the same machine
class as `bench/RESULTS.md`:

| Metric | Today | v1 target | How measured |
|---|---|---|---|
| tool time per agent action (p50) | ~935 ms | **≤150 ms** | `bench/bench-session.mjs` (30 turns, 3 warm-up, methodology of `bench/bench-a.mjs`) |
| agent turns for the flow | 9–11 | **3–5** | count of `session.mjs` invocations in a real skill run |
| drive-side tool time total | ~10 s | **≤2 s** | sum of `ms` in journal + client overhead |
| finish → package complete (excl. video runtime) | ~15 s (serial replay) | **≤8 s** | run.json phase timings |
| video runtime | ~10 s, mechanical | 25–45 s, human-like (longer on purpose — it's a demo) | ffprobe |
| snapshot payload after turn 1 | full page every turn | changed-controls diff | byte count in bench harness |

## 10. Non-goals (v1)

- Auth/storageState + smoke-url (v2 — the daemon and film are target-agnostic already; add
  `--auth-state`/`--smoke-url` to `start` and `film.mjs` later, mirroring screenplay's flags).
- Audio narration / TTS track (future; `page.screencast` webm is video-only today).
- Multi-flow suites, CI orchestration, parallel recordings on one machine (single `.run/` lock,
  as today).
- Replacing codegen — the recorder stays the source of the spec; we only add around it.
- Windows support (unix socket).

## 11. Resolved decisions

1. **Daemon transport: unix socket.** macOS/Linux-only in v1; no TCP fallback.
2. **Film browser: headless by default, `HEADLESS=0` filming supported** for live demos.
3. **Human-feel ceiling: tasteful.** Overshoot only on long cursor moves; **no fake typos,
   ever**. No `PERSONA=theatrical` tier.
4. **Old screencast path: deleted in M4.** `RECORD_SCREENCAST=1`, `screencast.fixtures.ts`, and
   `playwright.screencast.config.ts` are removed once `film.mjs` lands; `PERSONA=snappy` covers
   the quick-evidence case.

## 12. Environment knobs (v1 final set)

| Var | Default | Effect |
|---|---|---|
| `HEADLESS` | `1` | applies to recorder AND film browsers |
| `PERSONA` | `calm` | `calm` \| `snappy` film pacing (§3.2) |
| `PACE_MS` | `450` | daemon pause after each drive action (recorder fidelity) |
| `FORM_URL` / `FORM_PORT` / `CDP_PORT` / `OUT_FILE` | as today | unchanged semantics |
| `RECORDER_IDLE_TIMEOUT_MS` | `1800000` | also the daemon idle timeout |
| `STUDIO_SOCKET` | `.run/session.sock` | override for tests |

Removed in M4: `RECORD_SCREENCAST`, `SCREENCAST_DIR`, `SCREENCAST_SLOWMO`, `RUN_GENERATED`
(subsumed: finish always runs the assert pass).

---

# Part B — Implementation plan

Work in four phases; each has file-level tasks and **acceptance checks** (commands an
implementing agent runs and must see pass). Keep the repo demoable after every phase: the
`record-agent-test` skill must work end-to-end at each merge point. Suggested branch per phase.

Baseline sanity before starting: `npm run demo` (scripted path) and one skill-driven run against
`public/team.html` both work today — re-verify after each phase.

### Phase 1 — Speed core (daemon + journal)

Goal: agent turns ≤150 ms; journal captured; batch verb; snapshot diffs. No film changes yet
(the old `RECORD_SCREENCAST` path keeps working untouched).

| # | Task | Details |
|---|---|---|
| 1.1 | Extract `studio/snapshot.mjs` and `studio/locators.mjs` | move `snapshot()` + `locForLabel()`/button-resolution out of `session.mjs` verbatim; add target-descriptor types (§4.1). Unit-testable without a daemon (plain functions over a `page`). |
| 1.2 | Build `studio/daemon.mjs` | net server on `.run/session.sock`; verb dispatch reusing today's `cmdFill`/`cmdSelect`/`cmdToggle`/`cmdClick` bodies (they move here); `start` absorbs `cmdStart` (spawn server/recorder, CDP connect ONCE, keep `page`); journal + progress writes (atomic); stale-session detection (§2.2); idle timeout. |
| 1.3 | Build `studio/ipc.mjs` + rewrite `session.mjs` | thin client: parse argv (keep today's flag parser), connect, send, print `result` + `snapshot`, map error exits (7/8/9). Assert `session.mjs` imports nothing heavier than `node:net`/`node:fs`. |
| 1.4 | Add `scene`, `assert`, `--note`, `do`, `status` verbs | per §5. `assert` = wait-verify live + journal. `do` = sequential with `PACE_MS` gaps, first-failure stop (§2.4). |
| 1.5 | Snapshot diffing | §2.3 in `studio/snapshot.mjs`; previous-snapshot state in daemon; `--full` flag. |
| 1.6 | `bench/bench-session.mjs` | 3 warm-up + 30 measured `fill` turns through the real `session.mjs` (spawnSync), report p50/p95/mean + payload bytes; mirror `bench/bench-a.mjs` output format. |
| 1.7 | Wire `finish` minimally | same behavior as today (stop recorder, enrich single/multi assertion, print spec) so the skill stays usable before Phase 2. |

**Acceptance:**
- `node bench/bench-session.mjs` → p50 ≤150 ms, p95 ≤250 ms.
- Skill run against `public/team.html` completes in ≤5 `session.mjs` invocations using `do`,
  produces a green spec, and `.run/journal.json` validates against §4 (hand-check fields).
- Kill the daemon mid-drive (`kill <pid>`) → `session.mjs fill …` exits 9 with the recovery
  message; `start` recovers; journal.prev.json preserved.
- Second `start` while a session is live → exit 7.
- Error case: `fill --label "Nope"` → `ok:false`, error text, full snapshot in the same response.

### Phase 2 — Film engine

Goal: `film.mjs` turns a journal into a human-like annotated webm + scenes.json.

| # | Task | Details |
|---|---|---|
| 2.1 | `studio/motion.mjs` | primitives per §3.2 incl. seeded PRNG, virtual cursor state, bezier + easing, overshoot >600 px, gaussian click jitter, typing cadence (no typos), wheel scrolling, `settle()` with innerText word-diff. |
| 2.2 | `studio/overlays.mjs` | port `chapter`/`highlightBox`/`stickyBadge` from screenplay `helpers.js` to explicit-`page` ESM; keep the visual style. |
| 2.3 | `studio/film.mjs` | CLI (`--journal`, `--out`, env `HEADLESS`/`PERSONA`); launch chromium at journal viewport; goto → networkidle → screencast.start → showActions bottom → interpret entries (sync rules §3.2, annotations §3.3, assert callouts) → outro card → stop; write scenes.json with hrtime-stamped `t`; runtime estimator + dwell auto-compression; exit non-zero on any assert/locator failure. |
| 2.4 | Determinism check | same journal + seed → scenes.json timings within ±100 ms across two runs. |

**Acceptance:**
- `node studio/film.mjs --journal <phase-1 journal> --out /tmp/film-test` exits 0, produces
  webm + scenes.json; ffprobe duration within ±20% of last scene t + 3 s.
- Human-feel checklist on the invite-teammate film, verified by frame-sampling + watching:
  1. a visibly curved cursor path on the move to the submit button,
  2. two frames sampled 400 ms apart during the name fill show a *partially typed* value,
  3. hover pause visible before the modal-open click (cursor on button ≥150 ms pre-click),
  4. ≥1 s lingering on the success banner after it appears,
  5. ≤4 chapter cards total; scene badge visible during form filling,
  6. green assert callout frame exists at the scenes.json `assert` timestamp.
- Corrupt the assertion in a copy of the journal (wrong `contains`) → film exits non-zero, no
  webm shipped.
- `PERSONA=snappy` film of the same journal is ≥30% shorter.

### Phase 3 — Package, viewer, verification, parallel finish

Goal: one `finish` yields the complete package.

| # | Task | Details |
|---|---|---|
| 3.1 | `finish` orchestration in the daemon | §5.1 steps 1–7; parallel assert∥film via `child_process`; scoped playwright invocation; failure handling exactly as specified (never delete on failure). |
| 3.2 | Multi-assertion enrichment | `postprocess.mjs enrichTest(raw, { title, assertions: [...] })`, ordered; keep single-assertion callers working. |
| 3.3 | `studio/viewer.mjs` | render index.html per §7 from the three inputs; visual base = screenplay's viewer-template. |
| 3.4 | run.json / run.log + `status` polish | archive progress + daemon log into the package. |
| 3.5 | Frame-check step | extract the 3 frames into `.run/frames/` and print their paths; the *skill* instructs the agent to Read them before declaring success. |

**Acceptance:**
- One skill run ends with `recordings/invite-teammate/` containing all six §1 artifacts;
  `npx playwright test tests/invite-teammate.spec.ts` green.
- `python3 -m http.server 8782` → viewer plays, timeline pills seek to within 0.5 s of the
  right moments (spot-check 3 pills against scenes.json).
- run.json shows assert and film phases overlapping (parallelism worked) and
  finish-excluding-video-runtime ≤8 s.
- Assert-pass failure (temporarily break the spec) → exit non-zero, no package dir, spec+journal
  preserved.

### Phase 4 — Cutover & docs

| # | Task | Details |
|---|---|---|
| 4.1 | Delete old replay path | remove `screencast.fixtures.ts`, `playwright.screencast.config.ts`, `RECORD_SCREENCAST`/`SCREENCAST_*`/`RUN_GENERATED` handling everywhere (grep for them). |
| 4.2 | Rewrite `SKILL.md` | new loop (inspect → `do` bursts → `scene`/`assert` → `finish`), new knobs table (§12), frame-check instruction, remove old env vars. Update the copy in `~/.claude/skills/record-agent-test/` too if present (there are two copies: repo `.claude/skills/` and global — keep them in sync). |
| 4.3 | README | new architecture section, package layout, a real generated example; keep the "how it actually works" empirical notes (they still apply to the recorder). |
| 4.4 | Bench follow-up | re-run `bench/bench-session.mjs`, append results to `bench/RESULTS.md` as "C: studio daemon". |

**Acceptance:** fresh-clone experience — `npm install && npx playwright install chromium`, then a
skill run against `public/team.html` produces the package; `grep -r RECORD_SCREENCAST` finds
nothing; README quick-start commands all work as written.

### Implementation notes & gotchas (read before coding)

- **Recorder fidelity is sacred.** The delayed-default-action quirks documented in README
  ("How it actually works" §1–6) all still apply inside the daemon: keep `PACE_MS` after each
  verb, keep click-not-check for radios/checkboxes, keep click-then-selectOption. Regressions
  here corrupt the *generated spec*, which is the product.
- **The modal-open lag** seen in live driving (recorder delays a click's default action, so the
  immediately-taken snapshot can be stale) — after `click`, the daemon should wait `PACE_MS`
  *before* capturing the response snapshot, not after (today it sleeps after printing). This
  fixes the "modal still hidden" false negative observed on `team.html`.
- **`showActions` in the film pass** narrates input events; because motion primitives use
  raw `mouse.*` + keyboard, verify toast copy is still sensible (it anchors on the focused/hit
  element). If toasts are noisy for micro mouse-moves, call `showActions` with defaults and rely
  on real clicks/typing only — validate early in 2.3.
- **Playwright pin:** repo is on `1.61.1` stable; `page.screencast` (start/stop/showActions/
  showOverlay/showChapter) is present — `overlays.mjs` uses the same APIs screenplay already
  exercises on this machine.
- **Unrelated red spec** `tests/ogm-finding-detail.spec.ts` targets `localhost:8000` and fails
  when that app is down — one more reason every programmatic test run must be file-scoped.
- **Atomic writes everywhere** (`tmp` + `rename`) for journal/progress/scenes — the agent may
  `status` mid-write.
- **No `Date.now()` in film timing math for scene `t`** — use a single `hrtime` origin captured
  at `screencast.start` (wall-clock jumps would corrupt the timeline).
