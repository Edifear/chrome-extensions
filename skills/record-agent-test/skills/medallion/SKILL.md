---
name: medallion
description: >-
  Record an agent-driven Playwright test + human-like demo video for a
  Medallion feature or PR. Use when the user invokes
  /record-agent-test:medallion with a GitHub PR link (explore the PR diff,
  prepare a worktree via `md from`, and record a demo of that change) or with a
  free-form goal like "search by npi in credentialing requests table" (record
  that flow in the plugin's persistent `record-agent-test` worktree, or the
  current worktree if invoked from inside one). Handles md
  worktree/start/session prewarming, then drives the plugin's Agent Flow
  Studio end-to-end.
---

# Record a Medallion flow (worktree-aware)

You ARE the agent. This skill composes two systems:

- **`md`** — the Medallion developer CLI (worktrees, services, auth sessions).
  Always call it as `command md …` (the shell wrapper's auto-cd is for humans).
- **Agent Flow Studio** — the recorder, self-contained in this plugin at
  `~/.claude/skills/record-agent-test` (see the `studio` skill in this plugin
  for the full command reference of `session.mjs`).

Outcome: a green, authenticated `$STUDIO/tests/medallion-<flow>.spec.ts`
(replay: `cd $STUDIO && npx playwright test tests/medallion-<flow>.spec.ts`)
plus a reviewable package `~/Recordings/medallion-<flow>/` (video + viewer +
journal; `RECORDINGS_DIR` overrides).

```
STUDIO=$HOME/.claude/skills/record-agent-test
SESSION=$STUDIO/scripts/session.mjs
```

## Step 0 — parse the argument

- Argument matches `https://github.com/.*/pull/\d+` (or `/tree/<branch>`) →
  **PR mode**.
- Anything else → **goal mode**; the argument is the flow to record.
- No argument → ask what to record.

## Step 1 — run BOTH tracks in parallel (this is the whole point)

Environment prep is minutes of pure waiting (deps install, service boot);
analysis is pure reasoning that needs none of it. Kick off Track A as
**background** shell tasks in your FIRST tool message, and do Track B yourself
in the foreground while they run. Never sit idle polling `md status` — the
harness notifies you when a background command exits.

### Track A — environment (background shell, fire-and-forget)

**PR mode** — one background command does worktree + deps:

```bash
command md from "<pr-url>" --json    # run_in_background: true — creates/reuses pr-<n>, installs deps
```

If it fails because the worktree exists, match the branch in
`command md wt list --json` and reuse that path. If the worktree is not yet
running, follow with a background
`MD_AUTO_YES=1 command md start --no-tty --worktree <name>`.

**Register a cleanup marker for every worktree this session claims or
creates.** The plugin's SessionEnd hook reads it, stops the worktree's md
services when this session closes, and deletes the worktree if
`"delete": true`:

```bash
mkdir -p ~/.claude/skills/record-agent-test/state && printf '{"worktree":"%s","delete":false}\n' "<name>" \
  > ~/.claude/skills/record-agent-test/state/"$CLAUDE_CODE_SESSION_ID".json
```

Marker rules by worktree kind:

- **`record-agent-test` placeholder** → always write a marker, always
  `"delete": false`. The hook stops md there at session end but never deletes
  this worktree (it hard-refuses even if the marker says otherwise) — it is
  permanent by design. The marker doubles as the busy signal other recording
  sessions check.
- **Overflow worktree** (created because the placeholder was busy — see goal
  mode below) → `"delete": true`. Delete runs without `--force`, so
  uncommitted changes still block it.
- **PR/branch worktree `md from` created this session** (it did not exist in
  `md wt list` before) → marker with `"delete": false`; `"delete": true` only
  if the user called it throwaway/temporary.
- **Pre-existing worktrees and the cwd worktree** → NO marker. Those are
  shared or the user's own; leave them exactly as found.

Always pass `--no-tty` when backgrounding `md start` — it keeps the mprocs
supervisor alive without a controlling TTY (the agent-friendly alternative to
`--new-tab`), and `MD_AUTO_YES=1` lets the preflight autofix run unattended.

**Goal mode** — resolve the target instantly from `command md wt list --json`
(cheap, foreground), then background only what's actually needed. Core rule:
**record only in a worktree we own — never borrow other worktrees.** A
borrowed worktree may carry someone's half-done branch: the video demos the
wrong code and the generated spec asserts against UI that doesn't exist on
develop.

1. **cwd already inside `/Users/sergii/conductor/workspaces/medallion/<wt>`** →
   use it as-is (explicit user intent — this is also how "record on my current
   branch" works). If `"running": true`, Track A is already DONE. No cleanup
   marker, no branch refresh — it's the user's tree.
2. **Goal names a specific branch** → don't touch the placeholder; get an own
   worktree for that branch like PR mode does:
   `command md from "<branch-url>" --json`, or for a local branch
   `command md worktree new <slug> --existing-branch --branch <branch> --json`
   (background — deps install). Marker per the rules above (created this
   session → `"delete": false`).
3. **Otherwise use the plugin's persistent placeholder worktree
   `record-agent-test`** (a permanent recording sandbox on its own branch off
   develop — never deleted):
   - In `md wt list` and **not busy** → claim it: write the marker
     (`"delete": false`), refresh it to fresh develop —
     `git -C <path> fetch origin develop && git -C <path> reset --hard origin/develop`
     (safe: nothing but recordings ever happens here) — and if
     `"running": false`, background
     `MD_AUTO_YES=1 command md start --no-tty --worktree record-agent-test`.
     If the refresh pulled in new migrations, apply them at the join (Step 2).
   - Not in `md wt list` yet → create it once, in the background:
     `command md worktree new record-agent-test --from-branch develop --json`
     (slow — deps install; say so), then start as above. Write the marker.
   - **Busy** → see below.
4. **Busy check / overflow.** The placeholder counts as busy only when BOTH
   hold: some OTHER session's marker (`$STUDIO/state/<other-session>.json`)
   names `record-agent-test`, AND a studio session is actually live
   (`cd $STUDIO && node $SESSION status` exits 0). Then — and only then —
   create a throwaway overflow worktree:
   `command md worktree new --from-branch develop --json` (md auto-picks a
   name), marker `"delete": true`. A foreign marker WITHOUT a live studio is
   stale (that session crashed before its SessionEnd hook fired): delete the
   stale marker file and claim the placeholder normally.

### Track B — the Recording Brief (foreground, while A runs)

This is YOUR work while the environment boots. None of it needs the target
worktree — `gh` talks to GitHub directly, and for code reading use any
existing checkout (e.g. `/Users/sergii/conductor/workspaces/medallion/md-session-test`).

**PR mode:** `gh pr view "<url>" --json title,body,files` + `gh pr diff "<url>"`.
**Goal mode:** grep the frontend/backend of an existing checkout for the
feature (routes, components, testids).

Produce a **Recording Brief** — write it out explicitly before the join:

- **Golden path**: numbered user steps, from entry route to verified outcome.
- **Entry route** (deep link if the feature isn't on the landing page).
- **Controls** you expect to touch (labels/placeholders/testids from the code).
- **Assertion targets**: `data-testid`s that prove the outcome — in PR mode,
  testids added/changed in the diff are the author's own definition of done.
- **Feature flags**: grep the touched components (and their parents) for
  `useFeatureFlag` — flag-gated UI silently not rendering is the most likely
  failure mode for UI PRs. Note every flag the golden path depends on
  (e.g. `medallion_2_0`); it decides the mint user in Step 2.
- **Input data** the flow needs (search terms, entity names) and where it must
  exist in the seeded dev DB.
- **Backend prerequisites**: migrations in the diff? seed data required?
  non-core services (e.g. temporal) → `md start --profile` needs?
- `--flow medallion-<slug>` (PR mode: `medallion-pr-<n>-<slug>`) and a
  one-line `--summary`.

Still waiting after the brief is done? Pre-draft the `do --plan` JSON from the
brief, and check seed fixtures in the repo for the input data you assumed.

## Step 2 — join: verify env against the brief, mint the session

When Track A reports done (or was already running):

```bash
cd <worktree> && command md status     # healthy = "backend: :<port> OK"
```

- Boot not healthy yet → wait on the background task, don't busy-poll.
- Brief says the PR adds migrations or backend deps, and the worktree was
  already running → apply now: `git pull`, `command md db migrate`, restart
  (`md stop` / background `md start --no-tty`). Same if the placeholder's
  develop refresh (Step 1) pulled in new migrations — skip the `git pull`,
  the reset already updated the tree.
- Brief needs a non-core profile (temporal etc.) → restart with `--profile`.

Then mint the session (needs the backend up — that's why it's at the join,
seconds, not minutes):

```bash
command md session status default --check --quiet || command md session mint
AUTH=<worktree>/.auth/default
node "$STUDIO/scripts/prepare-session.mjs" "$AUTH"
```

**Pick the mint user by the brief's feature flags.** Flags are targeted
per-user (ConfigCat), so the wrong user renders the PR's UI as absent, not
broken:

- Brief needs a flag (e.g. `medallion_2_0`) →
  `command md session mint --email sergii@medallion.co` (that user has the
  flags). The default `admin@medallion.co` does NOT; `--me` fails — the git
  email isn't in the dev DB.
- A passing `--check` is not enough here: it verifies the session works, not
  who it's for. If `session.json`'s `user.email` isn't the flagged user,
  re-mint with `--email` anyway.

Exit 0 from `--check` means verified-working-now. `session.json`'s `baseUrl`
carries the worktree's own backend port; the studio reads it automatically —
never hardcode ports.

The `prepare-session.mjs` step readies the minted state for recording —
today it seeds `medallion.*` localStorage flags into `storageState.json` so
one-time onboarding tooltips (`MedallionHintPopover` — e.g. "The staff menu
has moved", "You can now filter by groups") never appear in the recording or
the replayed spec. Run it after every mint (minting rewrites the file). If
the brief's diff adds a NEW hint (look for `useOneTimeTooltip('<key>')` or
`useLocalStorage('<key>Hint…')`), pass that key too:
`… prepare-session.mjs "$AUTH" medallion.<key>`.

Optional data check (only if the brief flagged uncertain input data):
`command md shell` to confirm the records exist before burning a drive on them.

## Step 3 — record (Agent Flow Studio)

You arrive here with the brief in hand — exploration should be *confirming*
the golden path, not discovering it. All studio commands run from `$STUDIO`.
One studio session at a time per machine.

```bash
cd $STUDIO
node $SESSION start --auth-state $AUTH
```

- The browser opens already authenticated on the app (baseUrl from the
  manifest). Brief names a deep route? Start there:
  `FORM_URL=http://localhost:<backend-port>/<route> node $SESSION start --auth-state $AUTH`
- Landed on the wrong page anyway (the app redirects staff sessions to the
  active org)? Don't stop/re-start — navigate the live session:
  `node $SESSION goto --url http://localhost:<backend-port>/<route>`. The
  navigation is journaled and lands in the spec as `page.goto(…)`.
- Check the first snapshot against the brief's controls/testids; adjust the
  pre-drafted plan if the live UI disagrees (trust the snapshot, not the brief).
- Follow the base skill's loop: single `click` for steps that reveal new UI →
  read the snapshot diff; batch the known steps in one `do --plan`; declare
  1–3 `scene`s and testid-based `assert`s along the way (prefer text you typed
  that the app echoes back).
- Finish:

```bash
node $SESSION finish --flow medallion-<slug> --summary "<what it proves>"
```

Then **Read the frame PNGs** it prints (`.run/frames/*.png`) and confirm the
overlays and the feature's outcome are actually visible before declaring
success.

## Step 4 — report

Tell the user:

- spec path (`$STUDIO/tests/medallion-<slug>.spec.ts`, proven green, auth baked in via
  `test.use({ storageState })`) and package path (`~/Recordings/medallion-<slug>/`);
- how to watch: `cd ~/Recordings && python3 -m http.server 8782` →
  `http://localhost:8782/medallion-<slug>/index.html`;
- PR mode: 1–2 sentences tying what the video shows to the PR's change (worth
  pasting into the PR as a comment — offer to do it, don't do it unasked).

Leave `md` services running for the user's own worktrees (cwd mode) — only
stop those if asked. Any worktree this session registered a cleanup marker for
(the `record-agent-test` placeholder, an overflow worktree, a PR worktree
created this session) is auto-handled by the SessionEnd hook — mention in the
report that its services stop when the session closes, and that the
placeholder itself is kept (only overflow/throwaway worktrees get deleted).

## Medallion-specific driving rules

- **Assertions require `data-testid`** — scan the snapshot's
  `region testid="…"` lines first and design the flow so the outcome lands in
  one (e.g. `provider-cell-profile-link-row-0`). No testid on the outcome? Say
  so and suggest the one-line frontend change instead of shipping a weak
  assertion.
- **Placeholders act as labels** — snapshot names like "Search by Name" come
  from placeholders; use them verbatim in `fill --label`.
- **Snapshots are noisy on this app** (many nameless `button ""` /
  `checkbox ""` icon controls) — target controls by their testid region or
  visible text (`click --selector '[data-testid="…"]'` or `click --text "…"`)
  rather than guessing among unnamed buttons.
- **Tables/lists render async** after search/filter actions — assert via the
  `assert` verb (it waits up to 10 s) rather than reading the snapshot
  immediately.
- The yellow **"staff account" banner** is normal dev chrome; ignore it and
  don't include it in assertions.
- **Onboarding hint still visible in the first snapshot?** (dark tooltip with
  an × — a `MedallionHintPopover` whose localStorage key predates the
  pre-dismiss script's list): dismiss it BEFORE declaring any scene with
  `click --selector '.ant-popover button[aria-label="Dismiss"]'` (once per
  popover), then add its key to `scripts/prepare-session.mjs`'s
  `KNOWN_HINT_KEYS` so future runs skip it. The dismiss click lands in the
  generated spec, which is fine — replay uses the same storageState, so the
  hint reappears there too and the click stays deterministic.
- **Session died mid-run?** (snapshot suddenly shows the Auth0 login page):
  `command md session mint`, then restart the studio session — the journal of
  a dead run is preserved at `$STUDIO/.run/journal.prev.json`.

## Failure handling

- `finish` red on the assert pass → spec + journal are preserved; read the
  Playwright output, fix the flow (usually a too-strict `contains` or async
  timing), re-drive — don't hand-edit the generated spec.
- Studio exit codes: 7 = session already live (`node $SESSION stop` first),
  9 = no session (run `start`), 8 = check `$STUDIO/.run/daemon.log`.
- `md start` unhealthy after ~5 min → show `command md logs --no-follow | tail`
  to the user and stop; don't debug the app stack unasked.
