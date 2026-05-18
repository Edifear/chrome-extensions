async (page) => {
    // >>>HELPERS<<<

    const ORG_ID = 'b69eafd8-7356-42b4-8c46-da2cc0aeac8e';
    const URL = `http://localhost:3001/organization/${ORG_ID}/credentialing/ready`;
    const OUTPUT = 'frontend_service/playwright-recording-search-by-name.webm';

    // ---------- preflight ----------
    await page.goto(URL);
    await page.waitForLoadState('networkidle');
    await page.getByText(/1 - 10 of 10 Requests/).waitFor({ timeout: 15000 });
    await wait(500);

    await page.screencast.start({ path: OUTPUT, size: { width: 1280, height: 800 } });
    await page.screencast.showActions();

    const nameSearchBtn = page
        .getByRole('columnheader', { name: 'Name sortable' })
        .getByRole('button', { name: 'search' });
    const nameInput = page.getByTestId('name-filter-dropdown-search-input');

    // ---------- Scene 1: exact match ----------
    await chapter(
        'Search by Name',
        'Filter the credentialing table using the Name column search'
    );

    await highlightBox(nameSearchBtn, 'Click the search icon on the Name column');
    await wait(1600);
    await nameSearchBtn.click();
    await nameInput.waitFor();
    await wait(400);

    await highlightBox(nameInput, 'Type a provider name', { duration: 1200 });
    await nameInput.pressSequentially('Jack', { delay: 80 });
    await wait(400);
    await page.keyboard.press('Enter');

    await page.getByText(/1 - 1 of 1 Requests/).waitFor({ timeout: 10000 });
    await wait(400);
    await highlightBox(
        page.getByRole('row', { name: /Jack Smith/ }).first(),
        '✓ Filtered to Jack Smith',
        { color: 'rgb(40, 170, 100)', duration: 2000 }
    );
    const urlBadge = await stickyBadge('URL → ?search=Jack', 'top-right', 'success');
    await wait(2200);
    await urlBadge.dispose();

    // ---------- Scene 2: empty state ----------
    await chapter('No Results', 'Searching for a name that does not exist', 2000);

    await nameSearchBtn.click();
    await nameInput.waitFor();
    await nameInput.fill('');
    await nameInput.pressSequentially('ZZZNonExistentName', { delay: 50 });
    await wait(300);
    await page.keyboard.press('Enter');
    await page.getByText('No data').waitFor({ timeout: 10000 });
    await wait(400);
    await highlightBox(page.getByText('No data'), 'Empty state shown', {
        color: 'rgb(220, 80, 80)',
        duration: 2200,
        side: 'top',
    });
    await wait(2400);

    // ---------- Scene 3: partial / case-insensitive ----------
    await chapter(
        'Case-Insensitive Partial Match',
        'Lowercase "smith" matches both "Silversmith" and "Smith"'
    );

    await nameSearchBtn.click();
    await nameInput.waitFor();
    await nameInput.fill('');
    await nameInput.pressSequentially('smith', { delay: 80 });
    await wait(400);
    await page.keyboard.press('Enter');
    await page.getByText(/1 - 2 of 2 Requests/).waitFor({ timeout: 10000 });
    await wait(400);
    const o1 = await highlightBox(
        page.getByRole('row', { name: /Whitaker Silversmith/ }).first(),
        'Whitaker Silversmith',
        { color: 'rgb(255, 150, 30)' }
    );
    const o2 = await highlightBox(
        page.getByRole('row', { name: /Jack Smith/ }).first(),
        'Jack Smith',
        { color: 'rgb(255, 150, 30)' }
    );
    await wait(2400);
    if (o1) await o1.dispose();
    if (o2) await o2.dispose();

    // ---------- Scene 4: reset ----------
    await chapter('Reset', 'Clearing the filter restores all rows', 2000);

    await nameSearchBtn.click();
    const resetBtn = page.getByRole('button', { name: 'Reset' });
    await highlightBox(resetBtn, 'Click Reset', { duration: 1200 });
    await wait(1300);
    await resetBtn.click();
    await page.getByText(/1 - 10 of 10 Requests/).waitFor({ timeout: 10000 });
    await wait(400);
    const resetBadge = await stickyBadge('URL cleared · 10 of 10 restored');
    await wait(1800);
    await resetBadge.dispose();

    // ---------- outro ----------
    await chapter(
        'Search by Name — Verified ✓',
        'Exact match · No data · Case-insensitive partial · Reset',
        2400
    );

    await page.screencast.stop();
};
