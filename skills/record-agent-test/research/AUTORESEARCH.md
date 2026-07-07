# Autoresearch: Recording-Pipeline Speed

Autonomous, experiment-driven research (karpathy/autoresearch style) on one
question: **how fast can a studio recording get without losing quality or
accuracy?** Agents modify the studio runtime, run a fixed benchmark, keep
changes that beat the leaderboard, and revert everything else.

The approach borrowed, not the tool: one metric, a small mutable surface, an
immutable harness, fixed-budget experiments, keep-or-revert, an append-only
journal. All creativity goes into the diff; none into the measurement.

---

## 1. Metric (the val_bpb equivalent)

Primary, to MINIMIZE — **T_agent**: agent-facing wall-clock of the canonical
benchmark flow, in ms:

```
T_agent = wall(start) + wall(drive plans) + wall(finish --film-async → green response)
```

Secondary, tie-breaker — **T_package**: start → `.run/progress.json` phase
`done` (film rendered + packaged).

A run **scores only if every quality gate passes**. A faster run that fails a
gate is a failed experiment, full stop.

### Quality gates (accuracy is a constraint, not a trade-off)

| Gate | Check | Guards against |
|---|---|---|
| G1 spec-equality | Normalized `tests/bench-flow.spec.ts` (strip title/viewport/comments/blank lines) is byte-identical to `research/golden/bench-flow.spec.ts` | dropped/merged/extra codegen captures when gaps shrink |
| G2 replay-green | `npx playwright test` on the generated spec passes on a FRESH browser | fragile locators, uncommitted values |
| G3 state-correct | Final snapshot contains the expected committed values (dates, institution, card text) | silent value loss (the DatePicker-revert class) |
| G4 film-integrity | film exits 0; `scenes.json` count == expected (17); webm duration within ±20% of last-scene t+3 s | broken/truncated video |
| G5 film-visual | 3 frames extracted at fixed scene timestamps; each within SSIM ≥ 0.90 of `research/golden/frames/*` (ImageMagick `compare`), ignoring the cursor region | blank frames, missing overlays, wrong page state on film |
| G6 journal-sane | journal has exactly the planned 13 entries, all with `ms` | actions silently skipped |

If an optimization legitimately changes the spec (e.g. eliminates a redundant
line), the experiment FAILS G1 by design; the agent may propose a golden
update as a separate journal entry with the diff and justification — a human
(or a designated judge agent) approves it before the new golden lands.

### Noise control

- Each experiment = **3 benchmark repetitions**, score = median T_agent.
- One untimed warm-up run after any daemon-code change (JIT, fs cache).
- KEEP requires median improvement **≥ 5%** vs current leaderboard T_agent
  (measured run-to-run noise is ~3%); T_package breaks ties at ≥ 5%.
- Machine must be otherwise idle; the runner refuses to score if load avg > 4.

## 2. Immutable harness (the `prepare.py` equivalent) — build first

**Experiment 0** (no scoring): build `research/bench.mjs`, then freeze it.

- Boots vite (`antd-lab`, :5199) if not up; kills any live studio session.
- Runs the canonical flow — the proven `antd-lab-timed-run4` sequence:
  start → click(open modal) → 10-step `do` plan (program type, institution
  autocomplete, degree, both dates via single fills) → submit+assert plan →
  `finish --film-async` — timing every call with monotonic clocks.
- Waits for background package, then evaluates G1–G6.
- Emits `research/results/<git-sha>-<n>.json`:
  `{ sha, ts, t_agent, t_package, phases: {...}, gates: {g1: pass, ...} }`
  and prints one summary line.
- Creates the goldens on its first clean run at the baseline commit.

Immutable set (agents MUST NOT touch): `research/bench.mjs`, `research/golden/*`,
`antd-lab/**`, `playwright.config.ts`, the canonical plan JSON inside bench.

## 3. Mutable surface (the `train.py` equivalent)

Exactly these files:

```
studio/daemon.mjs   studio/motion.mjs   studio/film.mjs
studio/locators.mjs studio/snapshot.mjs studio/overlays.mjs
recorder.mjs        postprocess.mjs     scripts/session.mjs
```

Env-knob changes (PACE_MS, STEP_GAP_MS, PERSONA, quiet windows) count as
experiments too — cheap ones to run early.

## 4. The loop (per experiment)

```
1. PICK      one hypothesis from ideas.md (or invent one; add it first)
2. IMPLEMENT the minimal diff in the working tree — ONE idea per experiment.
             (Shared repo with unrelated work in flight: NO branch switching.
             The mutable-surface files must be clean before you start.)
3. MEASURE   node research/bench.mjs --runs 3
4. DECIDE    all gates pass AND median t_agent ≥5% better?
               KEEP:   git add skills/record-agent-test && git commit
                       (message: "exp: <idea> — t_agent <old>→<new>ms");
                       update the leaderboard line with the new sha
               REVERT: git checkout -- <the files you touched>
                       (save the diff to research/results/<slug>.patch first,
                       for archaeology)
5. JOURNAL   append one line to research/journal.jsonl:
             { ts, sha, idea, diffstat, t_agent, t_package, gates, verdict, insight }
             `insight` is mandatory — even (especially) for failures.
6. REFRESH   move the idea to done/rejected in ideas.md; add any new ideas
             the experiment suggested
```

Hard rules: never edit the harness to make a gate pass; never combine ideas;
never keep a change on "it should be faster" — only on measurement; timeouts
count as failures (cap one experiment at 20 min wall).

## 5. Seeded ideas backlog (`research/ideas.md`)

Ordered by expected ROI from the 2026-07-06 instrumented runs
(T_agent ≈ 13.5 s baseline: start 3.7 ∥ drive 5.3 ∥ finish 4.5):

**start (3.7 s, ~90% Chromium boot)**
1. `warm` command: pre-boot daemon+recorder browser, `start` attaches (~0 s perceived)
2. Reuse a persistent browser across sessions (profile pool); measure staleness risk
3. Cut poll intervals (ready-file fs.watch, CDP 50 ms backoff) — ~0.4 s

**drive (5.3 s: actions 1.6, settles ~2.6, gaps ~0.7)**
4. Tune DOM-quiet window (120 ms) and STEP_GAP_MS (200 ms) downward until G1 breaks; find the real floor, add margin, freeze
5. Skip DOM-quiet settle when the click's target is a select option / known-portal element (dropdown close needs no snapshot wait)
6. Date fill: measure the 300–830 ms auto-commit; try typing the value via `pressSequentially` with 0 delay vs fill+Enter
7. Batch snapshot: in `do` plans, skip per-step bookkeeping writes (journal/progress) and write once per plan

**finish-to-green (4.5 s: recorder stop ~1.3, playwright runner boot ~2.5)**
8. Signal-based recorder stop (SIGTERM + spec-tail) instead of stop-file poll + 900 ms flush sleep
9. Keep a warm playwright test-runner (or run the assert via the existing CDP browser with a minimal expect shim) — runner boot is ~80% of the assert pass
10. Overlap: start the assert pass while the recorder is still flushing the last action

**T_package / film (48 s) — quality-gated by G4+G5**
11. PERSONA/dwell tuning: what's the fastest film that still passes G5 SSIM?
12. Parallelize film boot with assert pass browser boot (shared launch)
13. Encode screencast at capture; skip the post-hoc ffmpeg re-mux if any
14. Scene-card duration scaling for short flows

**wildcards**
15. Replace codegen with journal-emitted spec (kills recorder boot, pacing, stop — big; needs G1 golden update by design)
16. Parameterize ports + `.run/` dir to allow parallel experiments in worktrees (harness change — needs human sign-off)

## 6. Orchestration (how the Claude agents run this)

- **Serial experiments.** Shared ports (5199/9333) and `.run/` mean one
  benchmark at a time; timing also demands an uncontended machine. (Idea 16
  is the escape hatch, but hardware contention still poisons timings — keep
  serial even then.)
- **Roles:**
  - *Researcher* (one at a time, long-lived): executes the loop §4. Fresh
    researcher every ~5 experiments to avoid context bloat; the journal +
    ideas.md + leaderboard are the ONLY memory that carries over — write them
    as if the next agent knows nothing else.
  - *Judge* (on demand): reviews G1-failing experiments that claim a
    legitimate spec change; approves/rejects golden updates. Never the same
    agent as the researcher.
  - *Synthesizer* (at stop): reads journal.jsonl end-to-end, writes
    `research/REPORT.md` — kept changes, rejected paths and why, remaining
    ideas, final before/after table.
- **Session protocol for a researcher agent:** read this file + ideas.md +
  the last 10 journal lines; verify leaderboard reproduces (1 bench run,
  gates only — if it doesn't, STOP and journal the discrepancy); then loop
  until out of budget or 4 consecutive REVERTs (plateau signal).

## 7. Stop conditions & targets

- **Plateau:** 4 consecutive failed experiments from the top of the backlog →
  hand off to synthesizer.
- **Targets** (stretch, not gates): T_agent < 8 s, T_package < 30 s.
- **Budget:** cap the program at ~25 experiments (~2 machine-days serial).

## 8. Leaderboard

| date | sha | T_agent (median) | T_package | change |
|---|---|---|---|---|
| 2026-07-07 | baseline | **9334 ms** | 55426 ms | measured by bench.mjs, 3 runs, all gates green (SSIM ~0.998) |

---

*Files this program owns:* `research/bench.mjs` (frozen after exp 0),
`research/golden/*`, `research/ideas.md`, `research/journal.jsonl`,
`research/results/*.json`, `research/REPORT.md`.
