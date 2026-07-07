import { test, expect } from '@playwright/test';

test.use({ storageState: "/Users/sergii/conductor/workspaces/medallion/record-agent-test/.auth/default/storageState.json" });

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("searching the credentialing requests page by provider NPI filters the table to the matching provider", async ({ page }) => {
  await page.goto('http://localhost:8110/organization/b69eafd8-7356-42b4-8c46-da2cc0aeac8e/credentialing/ready');
  await page.locator('#rc_select_0').fill('1234124223');
  await page.locator('#rc_select_0').click();
  await page.getByText('NPI:').click();
  // Asserted live by the agent: Table filtered to the provider found by NPI.
  await expect(page.getByTestId("credentialing-table-name-idx-0")).toBeVisible();
  await expect(page.getByTestId("credentialing-table-name-idx-0")).toContainText("John Francis");
});