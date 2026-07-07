import { test, expect } from '@playwright/test';

test.use({
  viewport: {
    height: 800,
    width: 1280
  }
});

test("navigates from the signup page to checkout via goto and applies a promo code", async ({ page }) => {
  await page.goto('http://localhost:5188/');
  await page.getByTestId('open-form').click();
  await page.goto('http://localhost:5188/checkout.html');
  await page.getByRole('textbox', { name: 'Promo code' }).fill('ROAST10');
  await page.getByTestId('apply-promo').click();
  // Asserted live by the agent: Promo confirmed on page B.
  await expect(page.getByTestId("promo-note")).toBeVisible();
  await expect(page.getByTestId("promo-note")).toContainText("ROAST10 applied");
});