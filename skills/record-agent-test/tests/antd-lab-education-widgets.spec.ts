import { test, expect } from '@playwright/test';

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("drives every AntD widget of the Medallion education modal replica and verifies the record card", async ({ page }) => {
  await page.goto('http://localhost:5199/');
  await page.getByRole('button', { name: 'plus Add an education record' }).click();
  await page.getByRole('combobox', { name: 'Program Type' }).click();
  await page.getByRole('combobox', { name: 'Program Type' }).click();
  await page.getByRole('combobox', { name: 'Program Type' }).click();
  await page.getByText('Undergraduate').click();
  await page.getByRole('combobox', { name: 'Institution Name' }).fill('Stanford');
  await page.getByText('Stanford University').nth(1).click();
  await page.getByRole('combobox', { name: 'Degree - optional' }).click();
  await page.getByRole('combobox', { name: 'Degree - optional' }).fill('Bachelor of Science');
  await page.getByText('Bachelor of Science (BS)').click();
  await page.getByRole('textbox', { name: 'Start Date' }).click();
  await page.getByRole('textbox', { name: 'Start Date' }).fill('2024-11-08');
  await page.getByRole('textbox', { name: 'City' }).click();
  await page.getByRole('textbox', { name: 'Start Date' }).click();
  await page.getByRole('textbox', { name: 'Start Date' }).fill('2024-11-08');
  await page.getByText('8', { exact: true }).click();
  await page.getByRole('textbox', { name: 'End Date' }).click();
  await page.getByRole('textbox', { name: 'End Date' }).fill('2026-05-15');
  // Codegen emitted `getByRole('table').getByText('15')` here — a strict-mode
  // violation (day 15 exists in BOTH mounted picker panels). Rewritten to the
  // journal's original selector, which is unambiguous by construction.
  await page.locator('.ant-picker-cell[title="2026-05-15"]').click();
  await page.getByRole('radio', { name: 'No' }).check();
  await page.getByRole('combobox', { name: 'Program Incompletion Reason' }).click();
  await page.getByText('Future graduation date /').click();
  await page.getByRole('textbox', { name: 'Phone Number - optional' }).fill('5551234567');
  await page.getByRole('textbox', { name: 'Additional Notes - optional' }).fill('Recorded by Agent Flow Studio in the AntD lab');
  await page.getByRole('button', { name: 'Submit' }).click();

  // Asserted automatically: the agent considered the run successful once these appeared.
  await expect(page.getByTestId("education-record")).toBeVisible();
  await expect(page.getByTestId("education-record")).toContainText("Stanford University");
  await expect(page.getByTestId("education-list")).toBeVisible();
  await expect(page.getByTestId("education-list")).toContainText("Program Not Completed");
});