import { expect, test } from '@playwright/test';
import { dropFile, fixture, watchConsole } from './helpers';

test.describe('landing pages', () => {
  test('home page renders and offers the upload box', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Open any document');
    await expect(page.getByTestId('dropzone')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Supported formats' })).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'DocuView home' })).toBeVisible();

    // Nothing should overflow horizontally at desktop width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  for (const route of ['/cad-viewer', '/pdf-viewer', '/office-viewer', '/about', '/privacy', '/terms']) {
    test(`${route} renders with a title and no console errors`, async ({ page }) => {
      const errors = watchConsole(page);
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page).toHaveTitle(/DocuView/);
      expect(errors).toEqual([]);
    });
  }

  test('robots.txt and sitemap.xml are served', async ({ request }) => {
    const robots = await request.get('/robots.txt');
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain('Sitemap:');

    const sitemap = await request.get('/sitemap.xml');
    expect(sitemap.status()).toBe(200);
    const xml = await sitemap.text();
    expect(xml).toContain('/cad-viewer');
    expect(xml).toContain('/pdf-viewer');
  });

  test('the support matrix is rendered from the registry', async ({ page }) => {
    await page.goto('/about');
    const table = page.locator('#matrix');
    await expect(table).toBeVisible();
    await expect(table).toContainText('STEP');
    await expect(table).toContainText('DWG');
    // Proprietary formats must be labelled honestly, not hidden.
    await expect(table).toContainText('Not yet');
  });
});

test.describe('upload validation', () => {
  test('dragging over the drop zone highlights it', async ({ page }) => {
    await page.goto('/');
    const dropzone = page.getByTestId('dropzone');
    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());

    await dropzone.dispatchEvent('dragenter', { dataTransfer });
    await expect(dropzone).toHaveAttribute('data-dragging', 'true');

    await dropzone.dispatchEvent('dragleave', { dataTransfer });
    await expect(dropzone).toHaveAttribute('data-dragging', 'false');
  });

  test('dropping a file opens it', async ({ page }) => {
    await page.goto('/');
    await dropFile(page, 'cube-ascii.stl');
    await page.waitForURL(/\/viewer/, { timeout: 20_000 });
    await expect(page.getByTestId('file-name')).toContainText('cube-ascii.stl');
  });

  test('an unsupported extension is refused before anything is uploaded', async ({ page }) => {
    await page.goto('/');
    await page.setInputFiles('[data-testid="file-input"]', fixture('garbage.bin'));
    await expect(page.getByTestId('upload-error')).toContainText('.bin');
    // Still on the home page: nothing was sent.
    expect(page.url()).not.toContain('/viewer');
  });

  test('the viewer route without a document offers a way to open one', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/viewer');
    await expect(page.getByRole('heading', { name: 'No document open' })).toBeVisible();
    await expect(page.getByTestId('dropzone')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
