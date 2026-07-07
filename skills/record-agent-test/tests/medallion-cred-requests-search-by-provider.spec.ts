import { test, expect } from '@playwright/test';

test.use({ storageState: "/Users/sergii/conductor/workspaces/medallion/kyiv/.auth/default/storageState.json" });

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("Global provider search on the credentialing requests page navigates to the matching request and filters the table to that provider", async ({ page }) => {
  await page.goto('http://localhost:8112/organization/b69eafd8-7356-42b4-8c46-da2cc0aeac8e/credentialing/ready');
  await page.locator('#rc_select_0').fill('Kiana');
  await page.locator('#rc_select_0').click();
  await page.getByText('Kiana Mills').first().click();
  // Asserted live by the agent: Table filtered to the searched provider.
  await expect(page.getByTestId("credentialing-table-name-idx-0")).toBeVisible();
  await expect(page.getByTestId("credentialing-table-name-idx-0")).toContainText("Kiana Mills");
});