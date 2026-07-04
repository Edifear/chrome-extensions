---
name: studio
description: >-
  Drive any web app (incl. the bundled demo signup form) as a live QA agent so
  Playwright's codegen recorder writes a real, asserted *.spec.ts from the
  actions performed — no Anthropic API key needed, because Claude Code itself is
  the agent. Use when asked to record/generate a Playwright test by performing
  it, auto-author a browser test, "record an agent test", or test specific form
  fields. Self-contained: the studio lives in this plugin. Replaces the old
  llm-agent.mjs flow.
---

# Record an agent-driven Playwright test (Agent Flow Studio)

You ARE the agent. A persistent session daemon owns a warm connection to a
recorder browser; you drive the page through thin `session.mjs` commands
(~50 ms each), and the recorder turns your DOM events into a Playwright test.
One `finish` then produces a complete reviewable package:

```
~/Recordings/<flow>/          (override with RECORDINGS_DIR)
├── flow.spec.ts       # the recorded, asserted test (proven green)
├── recording.webm     # human-like annotated demo video
├── scenes.json        # exact per-scene timestamps
├── journal.json       # the action journal the film was made from
├── index.html         # self-contained viewer (video + timeline + transcript + spec)
└── run.json / run.log # phase timings + log
```

The canonical spec lands in `$STUDIO/tests/<flow>.spec.ts`;
`~/Recordings/<flow>/flow.spec.ts` is a byte-identical copy for the viewer.
Packages land outside the repo — they're review artifacts, not source.

The studio is self-contained in this plugin — run from anywhere:

```
STUDIO=~/.claude/skills/record-agent-test
node $STUDIO/scripts/session.mjs <command> [flags]
```

Generated specs land in `$STUDIO/tests/`; packages in `~/Recordings/<flow>/`
(`RECORDINGS_DIR` overrides). Replay: `cd $STUDIO && npx playwright test tests/<flow>.spec.ts`.
Demo/playground flows: the daemon auto-starts the bundled form server
(`$STUDIO/server.mjs`, serves `$STUDIO/public/` on :5188) when the form URL
isn't already reachable.

## The loop (3–5 agent turns total)

1. **Start** — boots the daemon, static server (if the URL isn't already
   served), and recorder, then prints a full snapshot of the page:

   ```
   node $STUDIO/scripts/session.mjs start
   ```

   Point at any app with `FORM_URL=http://localhost:XXXX/page.html` before
   `start`.

   **Authenticated apps:** pass a prewarmed session (md-session contract — a
   dir with `storageState.json` + `session.json`):

   ```
   node $STUDIO/scripts/session.mjs start \
     --auth-state /path/to/.auth/default
   ```

   The recorder, film pass, AND the generated spec (`test.use({ storageState })`)
   all use it, so the packaged test replays authenticated in CI too. `FORM_URL`
   defaults to the manifest's `baseUrl`; start fails fast if the session has
   <1 h left.

2. **Read the snapshot and the user's goal.** Do EXACTLY what the goal asks and
   nothing more. If it says "test only the name and email fields," touch only
   those. Don't submit unless the goal implies it.

3. **Inspect steps stay single; form-filling bursts go through `do`.** When the
   next action reveals new UI (opening a modal, navigating), do it as a single
   `click` and read the returned snapshot. When you already know the next
   several actions, batch them in ONE `do` call:

   ```
   node $STUDIO/scripts/session.mjs do --plan '[
     {"verb":"scene","title":"Invite a teammate","desc":"Fill and send the invite"},
     {"verb":"fill","label":"Full name","value":"Grace Hopper","note":"Enter the invitee name"},
     {"verb":"fill","label":"Work email","value":"grace@acme.dev"},
     {"verb":"select","label":"Team","option":"Design"},
     {"verb":"click","name":"Send invite","note":"Submit the invite"},
     {"verb":"assert","testid":"invite-banner","contains":"Invite sent to Grace Hopper","title":"Invite confirmed"}
   ]'
   ```

   A plan stops at the first failing step (the response names the step and
   includes a fresh full snapshot); successful steps are kept. Allowed verbs in
   a plan: `fill`, `select`, `toggle`, `click`, `scene`, `assert`.

   | Command | Use for |
   |---|---|
   | `fill --label "<l>" --value "<v>" [--note "…"]` | text / email / textarea |
   | `select --label "<l>" --option "<o>" [--note "…"]` | a `<select>` dropdown |
   | `toggle --label "<l>" [--note "…"]` | radio button or checkbox |
   | `click --name "<button>"` (or `--selector` / `--text`) `[--note "…"]` | buttons, rows, links |
   | `scene --title "…" [--desc "…"]` | declare a chapter boundary for the video (instant) |
   | `assert --testid X [--contains "…"] [--title "…"]` | verify + journal an assertion, mid-flow or at the end |
   | `snapshot [--full]` | re-read the live page (responses show diffs; `--full` for everything) |
   | `status` | phase/step progress |

   `--note` names the moment in the viewer's timeline and transcript — write it
   for a reader ("Enter the invitee name"), not a log line. (The video itself
   stays annotation-light; set `ANNOTATE=full` to also draw per-action captions.)

4. **Declare scenes and assertions as you go.** 1–3 `scene` entries make the
   video's chapters. Prefer assertions on **dynamic, input-derived text** (text
   you typed that the app echoes back). Multiple `assert`s are fine; each is
   verified live immediately and baked into the spec in order.

5. **Finish** — stops the recorder, enriches the spec with the title + all
   assertions, moves it to `tests/<flow>.spec.ts`, then runs the assert pass
   (headless, spec-scoped) and the film pass in parallel, packages
   `~/Recordings/<flow>/`, and prints frame paths:

   ```
   node $STUDIO/scripts/session.mjs finish \
     --flow invite-teammate \
     --summary "invites a new teammate from the modal and sees the invite confirmed"
   ```

   - `--flow` is the package slug (kebab-case); defaults to the slugified summary.
   - `--no-film` skips the video; `--no-frame-check` skips frame extraction.
   - Legacy `--assert-testid` / `--assert-contains` still work as sugar for a
     final assert.
   - Use `stop` instead of `finish` to tear down without packaging.

6. **Verify the frames.** `finish` prints 2–3 PNG paths under `.run/frames/`.
   **Read them** and visually confirm the overlays rendered (chapter card,
   action caption, green assert callout) before declaring success. Then tell
   the user the package path and show `tests/<flow>.spec.ts`.

If `finish` reports the assert pass red, the spec and journal are preserved —
read the Playwright output, decide whether to re-drive, and say what happened.

## Recorder-fidelity rules (already handled by the commands)

- **Radios/checkboxes:** plain click, not `.check()` (the recorder delays the
  default action; `.check()`'s verification would read a stale `false`).
- **`<select>`:** clicked first to anchor the recorder, then the option is set.
- **Pacing:** the daemon spaces actions `PACE_MS` apart automatically (paid at
  the start of the next action, so your turns stay fast).
- **Assertions** aren't captured by codegen — declared `assert`s are injected
  into the spec by `finish`.

## Knobs (set as env vars before `start`, or before `finish` for PERSONA)

| Var | Default | Effect |
|---|---|---|
| `HEADLESS` | `1` | applies to the recorder AND the film browser (`0` = watch) |
| `PERSONA` | `calm` | film pacing: `calm` (1.0×) or `snappy` (0.6× dwells, 1.5× cursor) |
| `ANNOTATE` | `minimal` | `full` = also draw per-action caption toasts in the video |
| `PACE_MS` | `450` | recorder pacing between drive actions |
| `FORM_URL` | `http://localhost:5188/` | target app (already-served URLs are used as-is) |
| `FORM_PORT` / `CDP_PORT` | `5188` / `9333` | static server / recorder debug port |
| `OUT_FILE` | `tests/generated.spec.ts` | where the raw recording is written pre-finish |
| `RECORDER_IDLE_TIMEOUT_MS` | `1800000` | recorder + daemon idle self-termination |
| `STUDIO_SOCKET` | `.run/session.sock` | socket path override (tests) |

## Notes & troubleshooting

- **One run at a time per machine** (shared ports + `.run/`). Exit 7 = a
  session is already live. Exit 9 = no live session (run `start`). Exit 8 =
  daemon timeout — check `.run/daemon.log`.
- If a run was interrupted, `start` detects the stale session, cleans it up,
  and preserves the old journal as `.run/journal.prev.json`.
- Error responses always include a fresh full snapshot — recover in one turn.
- Prereq: `npx playwright install chromium` (once). ffmpeg/ffprobe optional
  (frame check + duration verification are skipped with a warning without them).
- macOS/Linux only (unix socket).
