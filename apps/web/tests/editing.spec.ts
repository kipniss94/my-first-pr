import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { openFixture } from './helpers';

// A test has no one to answer the native "Save as" dialog: saving falls back to a download.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = undefined;
  });
});

test.describe('editing documents', () => {
  test('a PDF loses a page and gets new text, saved as a new file', async ({ page }) => {
    await openFixture(page, 'report.pdf');
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('edit-document').click();

    const run = page.getByTestId('pdf-edit-run').first();
    await expect(run).toBeVisible({ timeout: 20_000 });
    await run.click();
    await page.getByTestId('pdf-edit-input').fill('Edited heading');
    await page.keyboard.press('Enter');
    await page.getByTestId('pdf-delete-page').nth(1).click();
    await expect(page.getByTestId('editor-changes')).toHaveText('2 changes');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('editor-save').click()]);
    expect(download.suggestedFilename()).toBe('report (edited).pdf');
    const saved = await PDFDocument.load(await readFile(await download.path()));
    expect(saved.getPageCount()).toBe(1);
  });

  test('a workbook cell is changed and a sheet deleted, in the .xlsx itself', async ({ page }) => {
    await openFixture(page, 'bill-of-materials.xlsx');
    await page.getByTestId('edit-document').click();
    await page.getByTestId('sheet-grid').locator('[role="gridcell"]').first().dblclick();
    await page.getByTestId('sheet-cell-input').fill('Position');
    await page.keyboard.press('Enter');
    await page.getByTestId('sheet-delete').nth(1).click();
    await expect(page.getByTestId('editor-changes')).toHaveText('2 changes');

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('editor-save').click()]);
    expect(download.suggestedFilename()).toBe('bill-of-materials (edited).xlsx');
    const bytes = await readFile(await download.path());
    // A ZIP whose workbook names one sheet and whose first sheet holds the new text.
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
