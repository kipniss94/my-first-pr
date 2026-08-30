import { expect, test } from '@playwright/test';
import { dropFile, fixture, watchConsole } from './helpers';

test.describe('the workspace', () => {
  test('opens on an empty desktop with a drop target and nothing else', async ({ page }) => {
    const errors = watchConsole(page);
    await page.goto('/');

    await expect(page.getByTestId('dropzone')).toBeVisible();
    await expect(page.getByRole('banner').getByRole('link', { name: 'DocuView home' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a file' }).first()).toBeVisible();

    // The desktop is the product: no viewer tabs, no marketing sections.
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'From file to view in three steps' })).toHaveCount(0);

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
    // Native CAD formats open, and are labelled for what they really give you.
    await expect(table).toContainText('SolidWorks');
    await expect(table).toContainText('Preview');
    // A format that genuinely does not open still says so.
    await expect(table).toContainText('Not yet');
  });
});

test.describe('upload validation', () => {
  test('dragging a file anywhere over the workspace invites the drop', async ({ page }) => {
    await page.goto('/');
    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['x'], 'a.stl'));
      return transfer;
    });

    await page.locator('body').dispatchEvent('dragenter', { dataTransfer });
    await expect(page.getByTestId('drop-overlay')).toBeVisible();

    await page.locator('body').dispatchEvent('dragleave', { dataTransfer });
    await expect(page.getByTestId('drop-overlay')).toHaveCount(0);
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
    await expect(page.getByTestId('workspace-error')).toContainText('.bin');
    // Still on the workspace: nothing was sent.
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
