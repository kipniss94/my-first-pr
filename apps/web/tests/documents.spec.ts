import { expect, test } from '@playwright/test';
import { openFixture, watchConsole } from './helpers';

test.describe('PDF viewer', () => {
  test('renders pages, navigates and searches', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'report.pdf');

    // Page one is drawn.
    const firstPage = page.locator('[data-page="1"] canvas');
    await expect(firstPage).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('[data-page="1"] canvas');
          if (!canvas) return 0;
          const context = canvas.getContext('2d');
          if (!context) return 0;
          const data = context.getImageData(0, 0, canvas.width, Math.min(canvas.height, 400)).data;
          let ink = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] < 200) ink += 1;
          }
          return ink;
        }),
      )
      .toBeGreaterThan(200);

    await expect(page.getByTestId('pdf-thumbnails')).toBeVisible();
    await expect(page.locator('text=/\\/ 2/')).toBeVisible();

    // Jump to page two.
    await page.getByTestId('pdf-page-input').fill('2');
    await page.getByTestId('pdf-page-input').press('Enter');
    await page.waitForTimeout(800);
    await expect(page.locator('[data-page="2"] canvas')).toBeVisible();

    // Search.
    await page.getByTestId('pdf-search-toggle').click();
    await page.getByTestId('pdf-search-input').fill('hydraulic manifold');
    await page.getByTestId('pdf-search-input').press('Enter');
    await expect(page.getByTestId('pdf-search-results')).toContainText('1 / 1', { timeout: 30_000 });

    // A term that is not there reports honestly.
    await page.getByTestId('pdf-search-input').fill('zzzznotpresent');
    await page.getByTestId('pdf-search-input').press('Enter');
    await expect(page.getByTestId('pdf-search-results')).toContainText('No matches');

    expect(errors).toEqual([]);
  });

  test('zoom controls change the rendered size', async ({ page }) => {
    await openFixture(page, 'report.pdf');
    const firstPage = page.locator('[data-page="1"]');
    await expect(firstPage).toBeVisible({ timeout: 30_000 });

    const fitWidth = (await firstPage.boundingBox())?.width ?? 0;
    await page.getByRole('button', { name: 'Fit page' }).click();
    await page.waitForTimeout(600);
    const fitPage = (await firstPage.boundingBox())?.width ?? 0;

    expect(fitWidth).toBeGreaterThan(0);
    expect(fitPage).toBeGreaterThan(0);
    expect(fitPage).not.toBe(fitWidth);
  });
});

test.describe('Office viewers', () => {
  test('a Word document keeps its headings, list and table', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'inspection-report.docx');

    const content = page.getByTestId('word-content');
    await expect(content).toBeVisible();
    await expect(content).toContainText('Assembly inspection report');
    await expect(content).toContainText('hydraulic manifold block');
    await expect(content.locator('table')).toBeVisible();
    await expect(content).toContainText('Bore A');
    await expect(content.locator('h1, h2').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the exact page layout can be requested and returns a PDF', async ({ page }) => {
    await openFixture(page, 'inspection-report.docx');
    await page.getByTestId('word-page-layout').click();

    await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('page-layout-back').click();
    await expect(page.getByTestId('word-content')).toBeVisible();
  });

  test('a workbook shows every sheet with formatted values', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'bill-of-materials.xlsx');

    const grid = page.getByTestId('sheet-grid');
    await expect(grid).toBeVisible();
    await expect(grid).toContainText('Manifold block');
    await expect(grid).toContainText('Aluminium 6082');
    // Number format from the workbook is honoured.
    await expect(grid).toContainText('128.40');

    // Second sheet.
    await page.getByTestId('sheet-tab-1').click();
    await expect(page.getByTestId('sheet-tab-1')).toHaveAttribute('aria-pressed', 'true');
    await expect(grid).toContainText('Slot width');
    await expect(grid).toContainText('Checked');
    expect(errors).toEqual([]);
  });

  test('a presentation renders its slides with an outline rail', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'pipeline-overview.pptx');

    await expect(page.getByTestId('slide-rail')).toBeVisible();
    await expect(page.getByTestId('slide-rail')).toContainText('DocuView presentation fixture');
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 45_000 });

    // Selecting a slide from the rail moves the view.
    await page.getByTestId('slide-rail').getByRole('button').nth(1).click();
    await page.waitForTimeout(800);
    await expect(page.locator('[data-page="2"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a CSV opens in the spreadsheet grid', async ({ page }) => {
    await openFixture(page, 'measurements.csv');
    const grid = page.getByTestId('sheet-grid');
    await expect(grid).toBeVisible();
    await expect(grid).toContainText('Bore A');
    await expect(grid).toContainText('nominal_mm');
  });

  test('a plain text file opens in the document viewer', async ({ page }) => {
    await openFixture(page, 'notes.txt');
    await expect(page.getByTestId('word-content')).toContainText('DocuView fixture notes');
  });
});

test.describe('document lifecycle', () => {
  test('the file can be deleted from the viewer', async ({ page }) => {
    await openFixture(page, 'report.pdf');
    await page.getByRole('button', { name: 'Delete this document from the server now' }).click();
    await page.waitForURL(/\/#upload|\/$/, { timeout: 15_000 });
    await expect(page.getByTestId('dropzone')).toBeVisible();
  });

  test('a reloaded viewer URL still finds the document', async ({ page }) => {
    await openFixture(page, 'report.pdf');
    await expect(page).toHaveURL(/job=/);
    await page.reload();
    await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 45_000 });
  });
});
