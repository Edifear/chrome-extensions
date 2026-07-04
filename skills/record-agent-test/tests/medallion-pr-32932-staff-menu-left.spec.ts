import { test, expect } from '@playwright/test';

test.use({ storageState: "/Users/sergii/conductor/workspaces/medallion/minsk/.auth/default/storageState.json" });

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("staff menu renders beside the logo in the V2 top bar and opens from its new position", async ({ page }) => {
  await page.goto('http://localhost:8115/organization/06d67cbd-dd25-4c67-9f32-8de768edbf84/providers');
  // Asserted live by the agent: V2 top bar renders.
  await expect(page.getByTestId("navbar-v2")).toBeVisible();
  // Asserted live by the agent: Staff menu present in its new spot next to the logo.
  await expect(page.getByTestId("navbar-v2-staff-menu")).toBeVisible();
  await expect(page.getByTestId("navbar-v2-staff-menu")).toContainText("Staff Menu");
  await page.getByTestId('navbar-v2-staff-menu').click();
});