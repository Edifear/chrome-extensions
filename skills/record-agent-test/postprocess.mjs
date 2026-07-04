// Enrich a raw codegen recording into a meaningful test:
//   - give the test a real name
//   - append the agent's "success criterion" as a Playwright assertion
//
// Codegen records *actions* but not *assertions* (those normally require a human
// clicking "assert" in the Inspector). Since our agent already decides when it's
// "happy" — when the success banner appears — we turn that exact condition into
// the test's assertion, so the generated test verifies an outcome, not just steps.

// Accepts either a single `assertion` object (legacy), an ordered `assertions`
// array — both shaped { testId, containsText? } — or a `timeline` (the studio
// journal's entries). With a timeline, each assertion is injected at its
// journal POSITION: a mid-flow assertion on transient UI (a cart total, an
// open modal) would fail if appended at the end, after later steps hid it.
export function enrichTest(source, { title = 'agent recorded flow', assertion, assertions, timeline, storageState } = {}) {
  let out = source;

  // Rename the default `test('test', ...)` to something meaningful.
  out = out.replace(/test\(\s*(['"])test\1\s*,/, `test(${JSON.stringify(title)},`);

  // Recorded against a prewarmed session: the replay needs the same auth.
  // Multiple test.use() calls at file level merge, so this composes with the
  // viewport block codegen already emits.
  if (storageState && !out.includes('storageState')) {
    out = out.replace(/^(import .*@playwright\/test.*;\n)/m,
      `$1\ntest.use({ storageState: ${JSON.stringify(storageState)} });\n`);
  }

  const assertLines = (a, indent = '  ') => {
    const l = [`${indent}await expect(page.getByTestId(${JSON.stringify(a.testId)})).toBeVisible();`];
    if (a.containsText) {
      l.push(`${indent}await expect(page.getByTestId(${JSON.stringify(a.testId)})).toContainText(${JSON.stringify(a.containsText)});`);
    }
    return l;
  };

  if (timeline?.some((e) => e.verb === 'assert')) {
    const positional = injectPositional(out, timeline, assertLines);
    if (positional !== null) return positional;
    // Statement count didn't match the journal (codegen merged or split an
    // action) — fall through to end-of-test injection.
    assertions = timeline
      .filter((e) => e.verb === 'assert')
      .map((e) => ({ testId: e.testid, containsText: e.contains }));
  }

  const list = (assertions ?? (assertion ? [assertion] : [])).filter((a) => a?.testId);
  if (list.length) {
    const lines = [
      '',
      '  // Asserted automatically: the agent considered the run successful once these appeared.',
    ];
    for (const a of list) lines.push(...assertLines(a));
    const block = lines.join('\n') + '\n';
    // Insert just before the final `});` that closes the test body.
    const idx = out.lastIndexOf('});');
    if (idx !== -1) out = out.slice(0, idx) + block + out.slice(idx);
  }

  return out;
}

const ACTION_VERBS = new Set(['fill', 'select', 'toggle', 'click']);

// Map journal actions 1:1 onto the spec's `await page.…` statements (codegen
// emits exactly one per action; `goto` is excluded). Returns the enriched
// source, or null if the counts don't line up and the caller should fall back.
function injectPositional(source, timeline, assertLines) {
  const lines = source.split('\n');
  const stmtIdx = [];
  let gotoIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s+await page\.goto\(/.test(lines[i])) { gotoIdx = i; continue; }
    if (/^\s+await page\./.test(lines[i])) stmtIdx.push(i);
  }
  const actions = timeline.filter((e) => ACTION_VERBS.has(e.verb));
  if (stmtIdx.length !== actions.length) return null;

  const insertAfter = new Map(); // spec line index → assertion text lines
  let seen = 0;
  for (const e of timeline) {
    if (ACTION_VERBS.has(e.verb)) { seen++; continue; }
    if (e.verb !== 'assert') continue;
    const anchor = seen === 0 ? gotoIdx : stmtIdx[seen - 1];
    if (anchor === -1) return null;
    const block = insertAfter.get(anchor) || [];
    block.push(
      `  // Asserted live by the agent${e.title ? `: ${e.title}` : ''}.`,
      ...assertLines({ testId: e.testid, containsText: e.contains })
    );
    insertAfter.set(anchor, block);
  }

  const result = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    if (insertAfter.has(i)) result.push(...insertAfter.get(i));
  }
  return result.join('\n');
}
