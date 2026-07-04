import { test, expect } from '@playwright/test';

test.use({ storageState: "/Users/sergii/conductor/workspaces/medallion/md-session-test/.auth/default/storageState.json" });

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("searches the provider directory and finds Live Demo", async ({ page }) => {
  await page.goto('http://localhost:8114/organization/c9403249-6b16-4dd0-8c30-17b58b2d886a/providers');
  await page.getByRole('textbox', { name: 'Search by Name' }).fill('Live');
  // Asserted live by the agent: Provider found in the directory.
  await expect(page.getByTestId("provider-cell-profile-link-row-0")).toBeVisible();
  await expect(page.getByTestId("provider-cell-profile-link-row-0")).toContainText("Live Demo");
});