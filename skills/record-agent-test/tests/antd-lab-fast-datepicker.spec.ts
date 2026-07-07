import { test, expect } from '@playwright/test';

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("enters both dates through single fill verbs and verifies the education card", async ({ page }) => {
  await page.goto('http://localhost:5199/');
  await page.getByRole('button', { name: 'plus Add an education record' }).click();
  await page.getByRole('combobox', { name: 'Program Type' }).click();
  await page.getByText('Undergraduate').click();
  await page.getByRole('combobox', { name: 'Institution Name' }).fill('Johns Hopkins');
  await page.getByText('Johns Hopkins University').nth(1).click();
  await page.getByRole('textbox', { name: 'Start Date' }).click();
  await page.getByRole('textbox', { name: 'Start Date' }).fill('2019-09-01');
  await page.getByRole('textbox', { name: 'Start Date' }).press('Enter');
  await page.getByRole('textbox', { name: 'End Date' }).click();
  await page.getByRole('textbox', { name: 'End Date' }).fill('2023-05-31');
  await page.getByRole('textbox', { name: 'End Date' }).press('Enter');
  await page.getByRole('button', { name: 'Submit' }).click();

  // Asserted automatically: the agent considered the run successful once these appeared.
  await expect(page.getByTestId("education-record")).toBeVisible();
  await expect(page.getByTestId("education-record")).toContainText("Johns Hopkins University");
});