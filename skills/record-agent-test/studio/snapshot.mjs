// Snapshot capture + diffing (SPEC §2.3).
//
// captureSnapshot(page)  → structured control/region list (the exact
//                          page.evaluate extracted from the old session.mjs)
// formatSnapshot(data)   → the full model-friendly text view
// diffSnapshot(prev, next) → compact "Changed:" view keyed by
//                          (kind, label/name/testid); regions whose visibility
//                          flipped ALWAYS appear, with their full text.

export async function captureSnapshot(page) {
  return page.evaluate(() => {
    const labelOf = (el) =>
      (el.labels && el.labels[0] && el.labels[0].innerText.trim()) ||
      el.getAttribute('aria-label') ||
      el.getAttribute('placeholder') ||
      el.id || '';
    const out = [];
    for (const el of document.querySelectorAll('input, select, textarea, button')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || el.type === 'submit') {
        out.push({ kind: 'button', name: (el.innerText || el.value || '').trim() });
      } else if (tag === 'select') {
        out.push({ kind: 'select', label: labelOf(el), value: el.value,
          options: Array.from(el.options).filter((o) => o.value).map((o) => o.textContent.trim()) });
      } else if (el.type === 'radio') {
        out.push({ kind: 'radio', label: labelOf(el), checked: el.checked });
      } else if (el.type === 'checkbox') {
        out.push({ kind: 'checkbox', label: labelOf(el), checked: el.checked });
      } else {
        out.push({ kind: 'text', label: labelOf(el), value: el.value });
      }
    }
    for (const el of document.querySelectorAll('[data-testid]')) {
      const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      out.push({ kind: 'region', testid: el.getAttribute('data-testid'),
        visible, text: visible ? el.innerText.trim() : '' });
    }
    return out;
  });
}

function line(c) {
  if (c.kind === 'button') return `- button "${c.name}"`;
  if (c.kind === 'select') return `- select "${c.label}" = ${JSON.stringify(c.value)} (options: ${c.options.join(', ')})`;
  if (c.kind === 'radio') return `- radio "${c.label}" [${c.checked ? 'x' : ' '}]`;
  if (c.kind === 'checkbox') return `- checkbox "${c.label}" [${c.checked ? 'x' : ' '}]`;
  if (c.kind === 'region') return `- region testid="${c.testid}" ${c.visible ? `visible: ${JSON.stringify(c.text)}` : '(hidden)'}`;
  return `- text "${c.label}" = ${JSON.stringify(c.value)}`;
}

export function formatSnapshot(data) {
  return data.map(line).join('\n');
}

const keyOf = (c) => `${c.kind}:${c.label ?? c.name ?? c.testid ?? ''}`;

function changedLine(c, prev) {
  if (c.kind === 'region') {
    if (prev === undefined) return `${line(c)}   (new)`;
    if (prev.visible !== c.visible) {
      return c.visible
        ? `- region testid="${c.testid}" now visible: ${JSON.stringify(c.text)}`
        : `- region testid="${c.testid}" now hidden`;
    }
    return `${line(c)}   (text changed)`;
  }
  const was = prev === undefined ? undefined
    : prev.kind === 'radio' || prev.kind === 'checkbox' ? (prev.checked ? '[x]' : '[ ]')
    : JSON.stringify(prev.value);
  return `${line(c)}${prev === undefined ? '   (new)' : `   (was ${was})`}`;
}

function isChanged(prev, next) {
  if (next.kind === 'region') return prev.visible !== next.visible || prev.text !== next.text;
  if (next.kind === 'radio' || next.kind === 'checkbox') return prev.checked !== next.checked;
  if (next.kind === 'button') return false; // same key ⇒ same name
  return prev.value !== next.value;
}

// Returns the diff text per SPEC §2.3. `prev`/`next` are captureSnapshot() arrays.
export function diffSnapshot(prev, next) {
  const prevMap = new Map(prev.map((c) => [keyOf(c), c]));
  const seen = new Set();
  const changed = [];
  let changedControls = 0;
  let changedRegions = 0;
  for (const c of next) {
    const k = keyOf(c);
    seen.add(k);
    const p = prevMap.get(k);
    if (p === undefined || isChanged(p, c)) {
      changed.push(changedLine(c, p));
      c.kind === 'region' ? changedRegions++ : changedControls++;
    }
  }
  for (const p of prev) {
    if (!seen.has(keyOf(p))) {
      changed.push(`- ${p.kind} ${JSON.stringify(p.label ?? p.name ?? p.testid ?? '')} removed`);
    }
  }
  const controls = next.filter((c) => c.kind !== 'region').length;
  const regions = next.length - controls;
  if (!changed.length) return `No changes. ${controls} controls, ${regions} regions (snapshot --full to see all)`;
  return `Changed:\n${changed.join('\n')}\n` +
    `Unchanged: ${controls - changedControls} controls, ${regions - changedRegions} regions (snapshot --full to see all)`;
}
