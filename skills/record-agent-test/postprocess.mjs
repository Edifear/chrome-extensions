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

  // Codegen swallows a navigation that lands within ~5 s of a click/press/fill
  // (attributed as that action's signal) — re-inject journaled `goto` steps it
  // didn't emit, BEFORE assertion placement relies on them.
  if (timeline?.some((e) => e.verb === 'goto')) out = ensureGotoLines(out, timeline);

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

const GOTO_RE = /^\s+await page\.goto\(/;
const STMT_RE = /^\s+await page\./;

function specStatements(lines) {
  const stmts = []; // ordered `await page.…` statements, tagged goto / non-goto
  for (let i = 0; i < lines.length; i++) {
    if (GOTO_RE.test(lines[i])) stmts.push({ line: i, isGoto: true });
    else if (STMT_RE.test(lines[i])) stmts.push({ line: i, isGoto: false });
  }
  return stmts;
}

// Guarantee every journal `goto` appears in the spec. Codegen only emits a
// standalone `page.goto(…)` when the navigation is >5 s away from the last
// click/press/fill — otherwise it silently attributes it to that action and
// the replayed spec would drive the wrong page. Walk journal steps against
// spec statements (codegen emits one per action) and insert the missing goto
// lines at their journal position. Leaves the source untouched when the
// shapes don't line up.
function ensureGotoLines(source, timeline) {
  const lines = source.split('\n');
  const stmts = specStatements(lines);
  const openingAt = stmts.findIndex((s) => s.isGoto);
  if (openingAt === -1) return source; // no opening navigation — unexpected shape
  const rest = stmts.slice(0, openingAt).concat(stmts.slice(openingAt + 1));

  const steps = timeline.filter((e) => ACTION_VERBS.has(e.verb) || e.verb === 'goto');
  const inserts = new Map(); // spec line index → goto lines to insert after it
  let sp = 0;
  let lastLine = stmts[openingAt].line;
  for (const e of steps) {
    if (e.verb === 'goto') {
      // Already emitted by codegen (navigation landed outside the threshold)?
      if (sp < rest.length && rest[sp].isGoto && lines[rest[sp].line].includes(e.url)) {
        lastLine = rest[sp].line; sp++;
        continue;
      }
      const q = `'${String(e.url).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      const block = inserts.get(lastLine) || [];
      block.push(`  await page.goto(${q});`);
      inserts.set(lastLine, block);
      continue;
    }
    // Action step: skip standalone goto lines codegen recorded on its own
    // (e.g. an app redirect) — they stay in place, unmatched.
    while (sp < rest.length && rest[sp].isGoto) { lastLine = rest[sp].line; sp++; }
    if (sp >= rest.length) return source; // action counts diverge — don't guess
    lastLine = rest[sp].line; sp++;
  }
  if (!inserts.size) return source;

  const result = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    if (inserts.has(i)) result.push(...inserts.get(i));
  }
  return result.join('\n');
}

// Map journal steps 1:1 onto the spec's `await page.…` statements (codegen
// emits exactly one per action). Journal `goto` entries map to
// `await page.goto(…)` lines; the FIRST goto line is the session's opening
// navigation (recorded by `start`, absent from the journal). Returns the
// enriched source, or null if the shapes don't line up (codegen merged, split,
// or added a statement) and the caller should fall back.
function injectPositional(source, timeline, assertLines) {
  const lines = source.split('\n');
  const stmts = specStatements(lines);
  const openingAt = stmts.findIndex((s) => s.isGoto);
  const opening = openingAt !== -1 ? stmts.splice(openingAt, 1)[0] : null;

  const isStep = (e) => ACTION_VERBS.has(e.verb) || e.verb === 'goto';
  const steps = timeline.filter(isStep);
  if (stmts.length !== steps.length) return null;
  for (let k = 0; k < steps.length; k++) {
    if ((steps[k].verb === 'goto') !== stmts[k].isGoto) return null;
  }

  const insertAfter = new Map(); // spec line index → assertion text lines
  let seen = 0;
  for (const e of timeline) {
    if (isStep(e)) { seen++; continue; }
    if (e.verb !== 'assert') continue;
    const anchor = seen === 0 ? (opening ? opening.line : -1) : stmts[seen - 1].line;
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
