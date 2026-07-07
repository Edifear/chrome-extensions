# Ideas backlog

One experiment per idea. Move to Done/Rejected with the journal line's ts.
Baseline phase split (bench run, ms): start ~3600 · open ~600 · plan ~3300 ·
submit ~600 · finish ~1200–3800 · film ~45000 (background).

## Open (ranked by expected ROI)

2. Persistent browser across sessions (profile pool); measure staleness risk
4. Floor-find DOM-quiet window (120 ms) and STEP_GAP_MS (200 ms): halve until G1/G2 break, add 50% margin, freeze
5. Skip DOM-quiet settle for portal-option clicks (dropdown close needs no wait)
6. Date fill: `pressSequentially` delay 0 vs click+fill+Enter (300–830 ms today)
7. Batch journal/progress writes per plan instead of per step
8. Signal-based recorder stop (SIGTERM + spec-tail) vs stop-file poll + 900 ms sleep
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

- (2026-07-07) 1. `warm` command: pre-boot daemon + recorder; rejected by analysis — frozen bench calls `start` directly, a separate warm verb can never appear in T_agent

