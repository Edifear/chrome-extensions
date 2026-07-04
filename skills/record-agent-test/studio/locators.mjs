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

export async function resolveTarget(page, target) {
  switch (target?.kind) {
    case 'label': {
      // Mirror the snapshot's labelOf() fallback chain: real <label>/aria-label
      // → placeholder → element id. Whatever name the snapshot showed the
      // agent must resolve back to the same control.
      const exact = page.getByLabel(target.label, { exact: true });
      if (await exact.count()) return exact.first();
      const loose = page.getByLabel(target.label);
      if (await loose.count()) return loose.first();
      const placeholder = page.getByPlaceholder(target.label);
      if (await placeholder.count()) return placeholder.first();
      return page.locator(`[id=${JSON.stringify(target.label)}]`).first();
    }
    case 'button': {
      const exact = page.getByRole('button', { name: target.name, exact: true });
      return (await exact.count()) ? exact.first() : page.getByRole('button', { name: target.name }).first();
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
    case 'assert': return entry.title || `Verify ${entry.testid}`;
    default: return entry.title || entry.verb;
  }
}
