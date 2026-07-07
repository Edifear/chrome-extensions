import { test, expect } from '@playwright/test';

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("timed run 3 with DOM-quiet settle and min-gap pacing", async ({ page }) => {
  await page.goto('http://localhost:5199/');
  await page.getByRole('button', { name: 'plus Add an education record' }).click();
  await page.getByRole('combobox', { name: 'Program Type' }).click();
  await page.getByText('Undergraduate').click();
  await page.getByRole('combobox', { name: 'Institution Name' }).fill('Michigan');
  await page.getByText('University of Michigan').nth(1).click();
  await page.getByRole('combobox', { name: 'Degree - optional' }).click();
  await page.getByRole('combobox', { name: 'Degree - optional' }).fill('Bachelor of Arts');
  await page.getByText('Bachelor of Arts (BA)').click();
  await page.getByRole('textbox', { name: 'Start Date' }).click();
  await page.getByRole('textbox', { name: 'Start Date' }).fill('2018-09-01');
  await page.getByRole('textbox', { name: 'Start Date' }).press('Enter');
  await page.getByRole('textbox', { name: 'End Date' }).click();
  await page.getByRole('textbox', { name: 'End Date' }).fill('2022-05-31');
  await page.getByRole('textbox', { name: 'End Date' }).press('Enter');
  await page.getByRole('button', { name: 'Submit' }).click();

  // Asserted automatically: the agent considered the run successful once these appeared.
  await expect(page.getByTestId("education-record")).toBeVisible();
  await expect(page.getByTestId("education-record")).toContainText("University of Michigan");
});