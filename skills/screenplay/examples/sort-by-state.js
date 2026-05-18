async (page) => {
    // >>>HELPERS<<<

    const ORG_ID = 'b69eafd8-7356-42b4-8c46-da2cc0aeac8e';
    const PROVIDER_ID = 'b52df13e-e308-4049-8507-cae592704e83';
    const URL = `http://localhost:3001/organization/${ORG_ID}/providers/${PROVIDER_ID}/licenses/existing`;
    const OUTPUT = 'frontend_service/playwright-recording-sort-by-state.webm';

    // ---------- preflight ----------
    await page.goto(URL);
    await page.waitForLoadState('networkidle');
    await page.getByText(/1 - 4 of 4 Licenses/).waitFor({ timeout: 15000 });
    await wait(500);

    await page.screencast.start({ path: OUTPUT, size: { width: 1280, height: 800 } });
    await page.screencast.showActions();

    // The accessible name of the State column changes once it's sorted
    // ("State sortable" → "State caret-up caret-down filter"), so anchor on the
    // common prefix.
    const stateHeader = page.getByRole('columnheader', { name: /^State/ });

    // Helper: read the first row's State cell text (AR / AZ / CA / MO).
    // The state code is the cell with one of those exact two-letter values.
    const firstStateCell = (code) =>
        page.getByRole('cell', { name: code, exact: true }).first();

    // ---------- Scene 1: intro ----------
    await chapter(
        'Sort by State',
        'Cycle the State column through ascending → descending → unsorted'
    );

    await highlightBox(stateHeader, 'State column · sortable');
    await wait(1600);

    const baselineBadge = await stickyBadge(
        'Default order: MO · CA · AR · AZ',
        'top-right',
        'neutral'
    );
    await wait(1800);
    await baselineBadge.dispose();

    // ---------- Scene 2: ascending ----------
    await chapter(
        'Ascending',
        'Click State once → URL gains ?ordering=state, rows reorder A→Z',
        2000
    );

    await stateHeader.click();
    await page.waitForURL(/ordering=state(&|$)/, { timeout: 10000 });
    // Wait for the header label to flip (the active sort indicator appears)
    await page
        .getByRole('columnheader', { name: /State caret-up caret-down/ })
        .waitFor({ timeout: 5000 });
    await wait(600);

    await highlightBox(stateHeader, '↑ Ascending sort active', {
        color: 'rgb(60, 110, 200)',
        duration: 1800,
    });
    await wait(1900);

    await highlightBox(firstStateCell('AR'), 'AR is now the first state', {
        color: 'rgb(40, 170, 100)',
        duration: 2000,
    });
    const ascUrlBadge = await stickyBadge('URL → ?ordering=state', 'top-right', 'info');
    await wait(2200);
    await ascUrlBadge.dispose();

    // ---------- Scene 3: descending ----------
    await chapter(
        'Descending',
        'Click State again → URL becomes ?ordering=-state, rows reverse',
        2000
    );

    await stateHeader.click();
    await page.waitForURL(/ordering=-state(&|$)/, { timeout: 10000 });
    await wait(600);

    await highlightBox(stateHeader, '↓ Descending sort active', {
        color: 'rgb(220, 140, 30)',
        duration: 1800,
    });
    await wait(1900);

    await highlightBox(firstStateCell('MO'), 'MO is now the first state', {
        color: 'rgb(40, 170, 100)',
        duration: 2000,
    });
    const descUrlBadge = await stickyBadge('URL → ?ordering=-state', 'top-right', 'warn');
    await wait(2200);
    await descUrlBadge.dispose();

    // ---------- Scene 4: clear ----------
    await chapter(
        'Clear Sort',
        'Click State a third time → ordering removed, default order restored',
        2000
    );

    await stateHeader.click();
    await page.waitForURL((u) => !u.searchParams.has('ordering'), {
        timeout: 10000,
    });
    await wait(600);

    await highlightBox(stateHeader, 'Sort cleared', {
        color: 'rgb(150, 150, 150)',
        duration: 1500,
    });
    const clearedBadge = await stickyBadge(
        'URL cleared · default order restored',
        'top-right',
        'success'
    );
    await wait(2000);
    await clearedBadge.dispose();

    // ---------- outro ----------
    await chapter(
        'Sort by State — Verified ✓',
        'Asc · Desc · Clear — three-state cycle on a single column',
        2400
    );

    await page.screencast.stop();
};
