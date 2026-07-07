import { test, expect } from '@playwright/test';

test.use({ storageState: "/Users/sergii/conductor/workspaces/medallion/record-agent-test/.auth/default/storageState.json" });

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("Provider adds a new in-progress Education record (Stanford University, BS) on the onboarding Professional History page and it appears in the Education list", async ({ page }) => {
  await page.goto('http://localhost:8110/onboarding/education');
  await page.getByRole('button', { name: 'plus-circle Add Education' }).click();
  await page.getByRole('combobox', { name: 'Program Type' }).click();
  await page.getByText('Undergraduate', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Institution Name' }).fill('Stanford University');
  await page.getByRole('combobox', { name: 'Degree' }).click();
  await page.getByRole('combobox', { name: 'Degree' }).fill('Bachelor of Science (BS)');
  await page.getByText('Bachelor of Science (BS)').click();
  await page.getByRole('textbox', { name: 'Start Date' }).click();
  await page.getByRole('textbox', { name: 'Start Date' }).fill('2024-11-08');
  await page.getByText('8', { exact: true }).click();
  await page.getByLabel('Add an Event: Education').getByText('No', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Program Incompletion Reason' }).click();
  await page.getByText('Future graduation date /').click();
  await page.getByRole('textbox', { name: 'Enter a location' }).fill('450 Serra Mall');
  await page.getByRole('textbox', { name: 'City' }).fill('Stanford');
  await page.getByRole('textbox', { name: 'Postal / Zip Code' }).fill('94305');
  await page.getByRole('combobox', { name: 'Country' }).click();
  await page.getByRole('combobox', { name: 'Country' }).fill('United States');
  await page.getByText('United States', { exact: true }).click();
  await page.getByRole('combobox', { name: 'State' }).click();
  await page.getByRole('combobox', { name: 'State' }).fill('California');
  await page.getByText('CA - California').click();
  await page.getByRole('button', { name: 'Submit' }).click();
  // Asserted live by the agent: Education record added.
  await expect(page.getByTestId("medical-program-block-education")).toBeVisible();
  await expect(page.getByTestId("medical-program-block-education")).toContainText("Stanford University");
});