# Ideas backlog

> **HANDOFF (2026-07-07, stopped mid-loop by user).** Leaderboard: 8728 ms @ 2c431b7
> (idea 3 kept). START HERE: idea 8 (signal-based recorder stop) is proven-but-unscored —
> all gates green on 4 runs, finish phase −1.2 s consistently, but the scoring median
> (−1.3%) was drowned by 27% machine noise (conductor workspaces + VM were active; the
> protocol assumes ~3%). `git apply research/results/sigterm-stop.patch`, then re-score
> 3 runs on a genuinely idle machine — cleanest run hit 7645 ms, expect a clear KEEP.
> Also: STEP_GAP_MS 200 is load-bearing (masks the DatePicker async commit — see idea 4
> rejection + idea 17); don't shrink it without a commit-verified wait. Bench runs are
> only valid at 1-min load < 3.5 — gate on that before scoring.

One experiment per idea. Move to Done/Rejected with the journal line's ts.
Baseline phase split (bench run, ms): start ~3600 · open ~600 · plan ~3300 ·
submit ~600 · finish ~1200–3800 · film ~45000 (background).

## Open (ranked by expected ROI)

2. Persistent browser across sessions (profile pool); measure staleness risk
17. Commit-verified wait after picker fills (wait for .ant-picker-dropdown close / value commit) instead of fixed STEP_GAP_MS — unlocks gap ~50 ms that idea 4 proved unsafe today
5. Skip DOM-quiet settle for portal-option clicks (dropdown close needs no wait)
6. Date fill: `pressSequentially` delay 0 vs click+fill+Enter (300–830 ms today)
7. Batch journal/progress writes per plan instead of per step
8. Signal-based recorder stop (SIGTERM + spec-tail) — IMPLEMENTED & GATES-GREEN, needs idle-machine re-score; patch: results/sigterm-stop.patch (see handoff note)
9. Warm playwright runner for the assert pass (runner boot ≈ 80% of it)
10. Start assert pass while the recorder flushes the last action
11. Film: PERSONA/dwell floor that still passes G5 SSIM ≥ 0.90
12. Film: share/parallelize browser boot with the assert pass
13. Film: skip post-hoc remux if screencast already encodes final container
14. Film: scene-card duration scaling for short flows
15. WILDCARD: journal-emitted spec replacing codegen (kills recorder boot + stop; needs judge-approved golden update)
16. HARNESS CHANGE (human sign-off): parameterize ports/.run for worktree parallelism

## Done

- (2026-07-07, 2c431b7) 3. Start-path poll tightening — t_agent 9334→8728ms (KEEP)

## Rejected

- (2026-07-07) 4. Floor-find quiet/STEP_GAP: floor is ~where we are (probes 30/50, 60/100, 60/150 all fail G3 — submit races the DatePicker commit; gap 200 ≈ 1.25× floor, best case <5%). Patch: results/settle-gap-floor.patch. Spawned idea 17.
- (2026-07-07) 1. `warm` command: pre-boot daemon + recorder; rejected by analysis — frozen bench calls `start` directly, a separate warm verb can never appear in T_agent

