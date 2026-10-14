import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { openFixture, waitForRenderedCanvas, watchConsole } from './helpers';

/**
 * Saving a model in other formats, then opening what was saved: the file has
 * to come back as the same model, not merely be written.
 */

test.beforeEach(async ({ page }) => {
  // The browser's own "Save as" dialog cannot be driven here; the download it
  // falls back to can.
  await page.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
});

async function exportAs(page: Page, format: string, name: string): Promise<string> {
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-menu')).toBeVisible();
  const download = page.waitForEvent('download', { timeout: 60_000 });
  await page.getByTestId(`export-${format}`).click();
  const file = test.info().outputPath(name);
  await (await download).saveAs(file);
  return file;
}

async function reopen(page: Page, file: string) {
  await page.goto('/');
  await page.setInputFiles('[data-testid="file-input"]', file);
  await page.waitForURL(/\/viewer/, { timeout: 20_000 });
  await expect(page.getByTestId('stage-rail')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('error-panel')).toHaveCount(0);
  await waitForRenderedCanvas(page);
}

test.describe('saving a model in other formats', () => {
  test('an assembly saved as STEP opens again with its parts, names and sizes', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'bracket-assembly.step');
    await waitForRenderedCanvas(page);

    const file = await exportAs(page, 'step', 'bracket.step');
    const text = await readFile(file, 'utf8');
    expect(text.startsWith('ISO-10303-21;')).toBe(true);
    expect(text.match(/MANIFOLD_SOLID_BREP\(/g)).toHaveLength(2);
    expect(text).toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
    expect(text).toContain("'BasePlate'");
    // Flat faces stay whole: the two boxes have six faces each, not twelve triangles.
    expect(text.match(/ADVANCED_FACE\(/g)).toHaveLength(12);

    await reopen(page, file);
    const tree = page.getByTestId('model-tree');
    await expect(tree).toContainText('BasePlate');
    await expect(tree).toContainText('Riser');
    await tree.getByRole('button', { name: 'BasePlate', exact: true }).click();
    const properties = page.getByTestId('properties-panel');
    await expect(properties).toContainText('Solid (B-Rep)');
    await expect(properties).toContainText('80.00 mm');
    await expect(properties).toContainText('60.00 mm');
    expect(errors).toEqual([]);
  });

  test('a part with a hole keeps the hole as a hole in its STEP faces', async ({ page }) => {
    await openFixture(page, 'hollow-block.step');
    await waitForRenderedCanvas(page);
    const text = await readFile(await exportAs(page, 'step', 'hollow.step'), 'utf8');
    // Six outer faces and four bore walls; the top and bottom have the bore as an inner loop.
    expect(text.match(/ADVANCED_FACE\(/g)).toHaveLength(10);
    expect(text.match(/FACE_BOUND\(/g)).toHaveLength(2);
    expect(text).toContain('CLOSED_SHELL');
  });

  for (const format of ['stl', '3mf', 'obj', 'ply', 'glb'] as const) {
    test(`the selected part saved as ${format.toUpperCase()} opens again at its size`, async ({ page }) => {
      const errors = watchConsole(page);
      await openFixture(page, 'bracket-assembly.step');
      await waitForRenderedCanvas(page);
      await page.getByTestId('model-tree').getByRole('button', { name: 'BasePlate', exact: true }).click();
      await page.getByTestId('export-button').click();
      await page.getByTestId('export-scope-selection').click();
      await page.getByTestId('export-button').click();

      const file = await exportAs(page, format, `base-plate.${format}`);
      expect((await readFile(file)).length).toBeGreaterThan(100);

      await reopen(page, file);
      const tree = page.getByTestId('model-tree');
      // The part itself: the deepest row of the tree.
      await tree.locator('button[title$="double-click to isolate"]').last().click();
      const properties = page.getByTestId('properties-panel');
      // 80 x 60 x 8 mm, whichever way up the format stores it.
      await expect(properties).toContainText('80.00 mm');
      await expect(properties).toContainText('60.00 mm');
      await expect(properties).toContainText('8.00 mm');
      expect(errors).toEqual([]);
    });
  }
});
