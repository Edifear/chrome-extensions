# AntD Lab — Learnings

Findings from driving the Medallion `MedicalProgramModal` replica (antd 4.24.0,
the exact widget stack) with Agent Flow Studio in a learning session.
Flow: `tests/antd-lab-education-widgets.spec.ts`, package:
`~/Recordings/antd-lab-education-widgets/`.

The lab reproduces the Medallion feedback-doc pathologies **deterministically**
— same failures, same generated locators — so studio fixes can be regression-
tested here without a Medallion worktree.

## Running the lab

```
cd antd-lab && npm install && npm run dev        # http://localhost:5199
FORM_URL=http://localhost:5199/ node scripts/session.mjs start
```

`?appointments=1` enables the Form.List contacts section. Field ids match the
real app (`onboarding-education_*`).

## AntD driving knowledge (confirmed in the lab)

1. **`select` verb fails on AntD Select** — `locator.selectOption: Element is
   not a <select> element` (it's a `role=combobox` input; options render in a
   `.ant-select-dropdown` portal on `<body>`). Working pattern:
   `click --selector '#<form>_<field>'` → optional `fill --label '<id>'` to
   filter → `click --selector '.ant-select-item-option[title="<full label>"]'`.
   The option's `title` attribute equals its full visible label.
2. **DatePicker input is `readonly` until clicked** (rc-picker typing mode).
   A `fill` without a preceding click on the input times out on
   "element is not editable".
   *Resolved:* the `fill` verb now detects `.ant-picker` ancestors and clicks
   first automatically (daemon.mjs).
3. **`fill()` never commits a date.** The wrapper's commit path is the
   per-keystroke `onKeyDown` parser (or Enter, or a calendar-cell click);
   `fill()` fires no keydowns, so blur reverts the value. rc-picker *does*
   parse the text on input events (that's why the panel navigates on fill)
   and commits it on **Enter**.
   *Resolved:* picker fills auto-commit as click → fill → `press('Enter')`;
   codegen records `fill` + `press('Enter')` with robust `getByRole` locators
   — dates are ONE verb and the calendar-cell dance is gone. The journal
   entry carries `commit: 'enter'` so the film replay presses Enter too
   (closing the panel instead of leaving it overlaying the next target).
   Proven: `tests/antd-lab-fast-datepicker.spec.ts` (assert pass green).
4. **Two-picker collision reproduced exactly.** The first picker's panel stays
   mounted (hidden) after closing; for the second picker codegen emitted
   `getByRole('table').getByText('15')` → strict-mode violation, 2 elements
   (day 15 in both panels). First picker got the robust
   `getByText('8', { exact: true })`. Codegen's exact/non-exact choice is
   value-dependent and uncontrollable — as in the Medallion session.
5. **Failed studio verbs still pollute the recording.** Two failed `select`
   probes left 3 recorded `combobox.click()` lines (each probe clicks to
   anchor before `selectOption` throws). Probing costs spec cleanliness —
   clean re-drives (or spec post-processing) matter.
6. **AutoComplete portal picks record fragile.** Clicking the Stanford hit
   was recorded as `getByText('Stanford University').nth(1)` — index-based
   because the text appears in both the input and the dropdown.
7. **AntD select values are invisible to the snapshot.** The chosen value
   renders in a `.ant-select-selection-item` div, not in the input, so
   `text "Degree" = ""` even after a successful pick. Don't re-try a pick
   because the snapshot looks empty; assert on downstream effects instead.
8. **Icon buttons leak the icon name into the accessible name** —
   `getByRole('button', { name: 'plus Add an education record' })`.
9. **Radio via `toggle` verb works**; codegen records it as
   `getByRole('radio', { name: 'No' }).check()` (fine at replay).
10. **MaskedInput (react-input-mask) accepts plain `fill`** — digits are
    formatted by the mask (`5551234567` → `555-123-4567`).
11. **The `[id=...]` fallback of `fill --label` is load-bearing** for
    DatePicker and select filter inputs (no label association). E.g.
    `fill --label 'onboarding-education_start_date'`.
12. **Conditional fields react to programmatic driving** exactly as to human
    input (`Form.useWatch`): completed=No reveals the incompletion reason,
    `in_process` flips End Date to "- optional", country=US swaps the State
    input for a select — snapshot diffs show all of it.

## Studio bugs found by the lab (fixed in this session)

1. **Film pass: wheel-scroll + raw clicks vs scrollable modal bodies**
   (`studio/motion.mjs`). `humanScroll` clamped only against the viewport, so
   a field clipped inside the modal's scrollable body was "in view" and never
   scrolled; `humanClick` then raw-clicked coordinates the body clips — the
   click landed on the modal **mask**, and `maskClosable: true` (Medallion's
   staff-mode setting, replicated here) silently closed the modal. Every later
   action failed with "target never became visible". Fixed: `humanScroll` now
   clamps against the nearest scrollable ancestor's clip rect and parks the
   cursor over it before wheeling (wheel scrolls the element under the
   cursor); `humanClick` verifies the click point actually hits the target
   (`elementFromPoint`) and falls back to `locator.click()` otherwise.
2. **Film failure diagnostics** (`studio/film.mjs`): "target never became
   visible" now reports the resolved locator and per-strategy candidate
   counts — this is what turned a mystery into finding #1.

## Timing facts (instrumented runs, 2026-07-06)

- Actions themselves are cheap: clicks 12–95 ms, fills 18–97 ms, auto-commit
  date fills ~300–830 ms. Snapshot capture: 1–6 ms. Client round trip: ~50 ms.
- **A click's spec line does NOT flush until the next input event** — codegen
  holds it in its navigation-attribution window. So spec-tailing is the right
  "recorder done" signal for fills (flushes in ~260 ms) but the WRONG one for
  clicks; DOM-mutation-quiet is the right post-click settle signal.
- **Inter-action spacing does not affect capture correctness** — the recorder
  commits a pending action when the next event arrives. 200 ms gaps produced
  byte-perfect specs (verified: full 10-step flow, assert pass green).
- `finish` is ~96 % film; `--film-async` returns after the assert pass (~3–4 s)
  and packages the video in the background.

## What this confirms for the roadmap

- **Journal-based locator rewriting works.** The red spec was made green by
  replacing the one fragile codegen line with the journal's original selector
  (`.ant-picker-cell[title="2026-05-15"]`) — the exact transform the planned
  post-processing step would apply automatically.
- **A `press` verb** would let dates commit via Enter after `fill`, removing
  the calendar-cell dance (finding 3) and the fragile-locator class entirely.
- **AntD-aware `select`** should detect `role=combobox` / `.ant-select` and
  run the open→filter→click-by-title pattern (finding 1).
