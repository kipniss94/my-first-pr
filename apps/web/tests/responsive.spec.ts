import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers';

/**
 * Mobile is a supported but secondary target: the marketing pages and the
 * document viewers must work, and nothing may overflow horizontally.
 */
test.describe('mobile layout', () => {
  for (const route of ['/', '/cad-viewer', '/office-viewer', '/about']) {
    test(`${route} fits the viewport`, async ({ page }) => {
      const errors = watchConsole(page);
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    });
  }

  test('the upload box is reachable and tappable', async ({ page }) => {
    await page.goto('/');
    const dropzone = page.getByTestId('dropzone');
    await dropzone.scrollIntoViewIfNeeded();
    await expect(dropzone).toBeVisible();
    const box = await dropzone.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(120);
  });
});
