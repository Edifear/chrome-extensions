import { test, expect } from '@playwright/test';

test.use({ storageState: "/Users/sergii/conductor/workspaces/medallion/record-agent-test/.auth/default/storageState.json" });

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("Staff reviewer resolves an unresolved (New) ongoing-monitoring flag from the monitoring flags table: opens the finding, records a review note, submits Resolve, and sees the resolved confirmation", async ({ page }) => {
  await page.goto('http://localhost:8110/organization/b69eafd8-7356-42b4-8c46-da2cc0aeac8e/ongoing-monitoring/flags');
  // Asserted live by the agent: Monitoring flags table lists unresolved flags.
  await expect(page.getByTestId("findings-table")).toBeVisible();
  await expect(page.getByTestId("findings-table")).toContainText("New");
  await page.getByTestId('finding-row-d477d9cb-5521-479d-9c21-c67275d89d5e').getByRole('cell', { name: 'New' }).click();
  await page.getByText('Resolve flag').click();
  await page.getByRole('textbox', { name: 'Review notes' }).fill('Reviewed Medicaid exclusion hit: identity mismatch confirmed with state list. No exclusion applies to this provider. Resolving flag.');
  await page.getByRole('button', { name: 'Submit' }).click();
  // Asserted live by the agent: Flag is resolved.
  await expect(page.getByTestId("flag-review-success")).toBeVisible();
  await expect(page.getByTestId("flag-review-success")).toContainText("Flag resolved");
});