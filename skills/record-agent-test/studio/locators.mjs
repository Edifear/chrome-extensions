// Locator contract (SPEC §4.1) — one module owns the target-description →
// Playwright-locator mapping for BOTH the live drive (daemon) and the film
// replay, so the film targets exactly what the agent targeted.
//
// Target descriptors stored in the journal:
//   { kind: 'label',  label }     getByLabel exact → fallback non-exact .first()
//   { kind: 'button', name }      getByRole('button', exact) → fallback .first()
//   { kind: 'text',   text }      getByText(text).first()
//   { kind: 'css',    selector }  locator(selector).first()
//   { kind: 'testid', testid }    getByTestId(testid)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function resolveTarget(page, target, { retryMs = 2000 } = {}) {
  switch (target?.kind) {
    case 'label': {
      // Mirror the snapshot's labelOf() fallback chain: real <label>/aria-label
      // → placeholder → element id. Whatever name the snapshot showed the
      // agent must resolve back to the same control.
      //
      // The chain probes with count(), which is a point-in-time check — a
      // conditional field that mounts a beat after the previous action would
      // lock onto the never-matching [id=…] fallback. Retry the whole chain
      // briefly before settling on the fallback.
      const deadline = Date.now() + retryMs;
      for (;;) {
        const exact = page.getByLabel(target.label, { exact: true });
        if (await exact.count()) return exact.first();
        const loose = page.getByLabel(target.label);
        if (await loose.count()) return loose.first();
        const placeholder = page.getByPlaceholder(target.label);
        if (await placeholder.count()) return placeholder.first();
        const byId = page.locator(`[id=${JSON.stringify(target.label)}]`).first();
        if (await byId.count()) return byId;
        if (Date.now() >= deadline) return byId;
        await sleep(60);
      }
    }
    case 'button': {
      const deadline = Date.now() + retryMs;
      for (;;) {
        const exact = page.getByRole('button', { name: target.name, exact: true });
        if (await exact.count()) return exact.first();
        const loose = page.getByRole('button', { name: target.name }).first();
        if (await loose.count()) return loose;
        if (Date.now() >= deadline) return loose;
        await sleep(60);
      }
    }
    case 'text':
      return page.getByText(target.text).first();
    case 'css':
      return page.locator(target.selector).first();
    case 'testid':
      return page.getByTestId(target.testid);
    default:
      throw new Error(`unknown target descriptor: ${JSON.stringify(target)}`);
  }
}

// Human-readable name of a target, for errors and auto-captions.
export function describeTarget(target) {
  if (!target) return '(no target)';
  const val = target.label ?? target.name ?? target.text ?? target.selector ?? target.testid;
  return `${target.kind} ${JSON.stringify(val)}`;
}

// Auto-caption for a journal entry when the agent gave no --note (SPEC §4).
export function autoCaption(entry) {
  const t = entry.target || {};
  const name = t.label ?? t.name ?? t.text ?? t.selector ?? t.testid ?? '';
  switch (entry.verb) {
    case 'fill': return `Fill ${name}`;
    case 'select': return `Select ${JSON.stringify(entry.option)} in ${name}`;
    case 'toggle': return `Toggle ${name}`;
    case 'click': return `Click ${name}`;
    case 'goto': {
      try { const u = new URL(entry.url); return `Go to ${u.pathname}${u.search}`; }
      catch { return `Go to ${entry.url}`; }
    }
    case 'assert': return entry.title || `Verify ${entry.testid}`;
    default: return entry.title || entry.verb;
  }
}
