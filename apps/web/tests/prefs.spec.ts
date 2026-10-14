import { expect, test } from '@playwright/test';

test.describe('language and theme', () => {
  test('switch to Russian and the light theme, and stay so after a reload', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open a file' })).toBeVisible();

    await page.getByTestId('lang-ru').click();
    await expect(page.getByRole('button', { name: 'Открыть файл' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru');

    await page.getByTestId('theme-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // The server renders the chosen language and theme from the first paint.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('button', { name: 'Открыть файл' })).toBeVisible();

    await page.getByTestId('lang-en').click();
    await page.getByTestId('theme-toggle').click();
    await expect(page.getByRole('button', { name: 'Open a file' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
