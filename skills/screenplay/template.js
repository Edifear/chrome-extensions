// Stub for a new annotated flow.
//
// Author this file then run:
//   bash <skill-dir>/record.sh path/to/this-file.js
//
// Conventions:
//   - File MUST be a single async-arrow expression (no top-level statements).
//   - Trailing `;` after the closing `}` is stripped at run time.
//   - The `>>>HELPERS<<<` marker is replaced with helpers.js. After replacement
//     these names are in scope:
//       wait(ms)
//       chapter(title, description, durationMs?=2200)
//       highlightBox(locator, label, opts?) → disposable | null
//       stickyBadge(text, position?='top-right', tone?='success') → disposable
//   - OUTPUT path is relative to the playwright-cli working directory
//     (typically the project root).

async (page) => {
    // >>>HELPERS<<<

    const URL = 'http://localhost:3000/.../the/page/under/test';
    const OUTPUT = 'playwright-recording-FLOWNAME.webm';

    // ---------- preflight: navigate + assert baseline ----------

    await page.goto(URL);
    await page.waitForLoadState('networkidle');
    // Replace with an assertion that proves the page is in a known starting state.
    // e.g. await page.getByText('Some baseline label').waitFor({ timeout: 15000 });
    await wait(500);

    // ---------- start recording ----------

    await page.screencast.start({
        path: OUTPUT,
        size: { width: 1280, height: 800 },
    });
    await page.screencast.showActions();

    // ---------- Scene 1 ----------

    await chapter('Scene title', 'One-line description shown under the title');

    // Discover via earlier playwright-cli snapshot. Prefer role/text → testid → css.
    // const trigger = page.getByRole('button', { name: 'Submit' });
    // await highlightBox(trigger, 'Click Submit');
    // await wait(1500);
    // await trigger.click();

    // After action, anchor on a sync barrier (text/locator that proves the action took effect).
    // await page.getByText('Success').waitFor({ timeout: 10000 });

    // ---------- Scene 2 ----------

    // await chapter('Next scene', '...');
    // ...

    // ---------- outro ----------

    await chapter(
        'FLOW NAME — Verified ✓',
        'short summary of what was demonstrated',
        2400
    );

    await page.screencast.stop();
}
