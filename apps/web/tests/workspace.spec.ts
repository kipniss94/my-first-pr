import { expect, test } from '@playwright/test';
import { fixture, openFixture, watchConsole } from './helpers';

/**
 * The workspace is meant to be the whole product: drop a file, it opens; come
 * back and it is still there as a tile; click the tile and it opens again
 * without being sent anywhere. These tests hold that promise honest.
 */
test.describe('workspace cache', () => {
  test('remembers a document and reopens it from its card', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'cube-ascii.stl');
    await expect(page.getByTestId('file-name')).toContainText('cube-ascii.stl');

    await page.goto('/');
    const card = page.getByTestId('document-card').filter({ hasText: 'cube-ascii.stl' });
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Reopening must not upload anything: the job is still on the server, so
    // the browser only fetches the prepared geometry.
    const uploads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/v1/uploads')) uploads.push(request.url());
    });

    await card.click();
    await page.waitForURL(/\/viewer/, { timeout: 20_000 });
    await expect(page.getByTestId('file-name')).toContainText('cube-ascii.stl');
    await expect(page.getByTestId('stage-rail')).toHaveCount(0, { timeout: 30_000 });
    expect(uploads).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a card carries the thumbnail the viewer drew', async ({ page }) => {
    await openFixture(page, 'cube-ascii.stl');
    await expect(page.locator('[data-testid="cad-canvas"] canvas')).toBeVisible({ timeout: 30_000 });
    // Give the viewer a moment to hand its snapshot to the cache.
    await page.waitForTimeout(1500);

    await page.goto('/');
    const image = page.getByTestId('document-card').filter({ hasText: 'cube-ascii.stl' }).locator('img');
    await expect(image).toBeVisible({ timeout: 15_000 });
    const width = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
    expect(width).toBeGreaterThan(0);
  });

  test('a document can be removed, and the whole workspace cleared', async ({ page }) => {
    await openFixture(page, 'notes.txt');
    await page.goto('/');

    const card = page.getByTestId('document-card').filter({ hasText: 'notes.txt' });
    await expect(card).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Remove notes\.txt/ }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId('dropzone')).toBeVisible();
  });

  test('the filter narrows the desktop', async ({ page }) => {
    await openFixture(page, 'cube-ascii.stl');
    await page.goto('/');
    await openFixture(page, 'notes.txt');
    await page.goto('/');

    await expect(page.getByTestId('document-card')).toHaveCount(2, { timeout: 15_000 });
    await page.getByTestId('workspace-filter').fill('notes');
    await expect(page.getByTestId('document-card')).toHaveCount(1);
    await expect(page.getByTestId('document-card')).toContainText('notes.txt');
  });
});

test.describe('native CAD', () => {
  test('a SolidWorks part opens from the preview stored inside it', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'bracket.sldprt');

    // The point of the whole feature: no dead end, no "export to STEP first".
    await expect(page.getByTestId('error-panel')).toHaveCount(0);
    await expect(page.getByTestId('native-preview')).toBeVisible({ timeout: 30_000 });

    // And it is labelled for what it is, rather than pretending to be geometry.
    await expect(page.getByText('Preview', { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId('native-properties')).toContainText('Bracket 10640.00.00.04');
    await expect(page.getByTestId('native-properties')).toContainText('SolidWorks 2021');
    expect(errors).toEqual([]);
  });

  test('a SolidWorks assembly lists the components it is waiting for', async ({ page }) => {
    await openFixture(page, 'frame.sldasm');

    await expect(page.getByTestId('component-list')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('component-list')).toContainText('bracket.sldprt');
    await expect(page.getByTestId('component-list')).toContainText('pin_8x40.SLDPRT');
    await expect(page.getByTestId('component-count')).toContainText('0/3');
    await expect(page.getByTestId('component-dropzone')).toBeVisible();
  });

  test('supplying a component builds the model from it', async ({ page }) => {
    await openFixture(page, 'frame.sldasm');
    await expect(page.getByTestId('component-dropzone')).toBeVisible({ timeout: 30_000 });

    // A component the assembly did not name is still accepted — the person
    // adding it knows their model better than our reference scan does.
    await page.setInputFiles('[data-testid="component-input"]', [fixture('cube-ascii.stl')]);

    await expect(page.getByTestId('component-list')).toContainText('cube-ascii.stl');
    // Once it is ready the viewer switches from the picture to real geometry.
    await expect(page.locator('[data-testid="cad-canvas"] canvas')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Geometry', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  });
});
