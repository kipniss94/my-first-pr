import { existsSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fixture, openFixture, watchConsole } from './helpers';
import { slidesSample, wordSample } from './office-samples';

/** The .docx and .pptx fixtures are written by LibreOffice; without it they do not exist. */
const needs = (name: string) => test.skip(!existsSync(fixture(name)), `${name} is generated with LibreOffice, which is not installed here`);

/** Upload bytes built in the test, the way openFixture uploads a file. */
async function openBuffer(page: Page, name: string, buffer: Buffer) {
  await page.goto('/');
  await page.setInputFiles('[data-testid="file-input"]', { name, mimeType: 'application/octet-stream', buffer });
  await page.waitForURL(/\/viewer/, { timeout: 20_000 });
  await expect(page.getByTestId('stage-rail')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('error-panel')).toHaveCount(0);
}

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
    needs('inspection-report.docx');
    const errors = watchConsole(page);
    await openFixture(page, 'inspection-report.docx');
    // A .docx opens as pages; the reading view is one click away.
    await page.getByTestId('word-view-toggle').getByRole('button').nth(1).click();

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
    needs('inspection-report.docx');
    await openFixture(page, 'inspection-report.docx');
    await page.getByTestId('word-view-toggle').getByRole('button').nth(1).click();
    await page.getByTestId('word-page-layout').click();

    await expect(page.locator('[data-page="1"] canvas')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('page-layout-back').click();
    await expect(page.getByTestId('word-content')).toBeVisible();
  });

  test('a Word document opens as pages with a rail of thumbnails', async ({ page }) => {
    const errors = watchConsole(page);
    await openBuffer(page, 'chapters.docx', await wordSample());

    const pages = page.getByTestId('docx-pages');
    await expect(pages.locator('section.docx')).toHaveCount(3, { timeout: 30_000 });
    await expect(pages).toContainText('Chapter 1');
    await expect(page.getByTestId('docx-page-indicator')).toHaveText('1 / 3');
    const thumbnails = page.getByTestId('docx-thumbnails').getByRole('button');
    await expect(thumbnails).toHaveCount(3);
    // A thumbnail is a copy of its page.
    await expect(thumbnails.nth(0)).toContainText('Chapter 1');

    await thumbnails.nth(2).click();
    await expect(page.getByTestId('docx-page-indicator')).toHaveText('3 / 3');
    await expect(thumbnails.nth(2)).toHaveAttribute('aria-current', 'page');

    // The reading view still reflows the text.
    await page.getByTestId('word-view-toggle').getByRole('button').nth(1).click();
    await expect(page.getByTestId('word-content')).toContainText('Text of page 2.');
    expect(errors).toEqual([]);
  });

  test('a PowerPoint deck is drawn in the browser, a show file too', async ({ page }) => {
    const capabilities = await (await page.request.get('/api/v1/capabilities')).json();
    test.skip(capabilities.libreOffice, 'With LibreOffice the deck is rendered to PDF instead');
    const errors = watchConsole(page);
    // .ppsx is the same package, saved to open as a slide show.
    await openBuffer(page, 'deck.ppsx', await slidesSample());

    const slides = page.getByTestId('pptx-slides');
    await expect(slides.locator('.pptx-preview-slide-wrapper')).toHaveCount(2, { timeout: 30_000 });
    await expect(slides).toContainText('Deck drawn in the browser');
    await expect(page.getByTestId('slide-indicator')).toHaveText('1 / 2');
    const rail = page.getByTestId('slide-rail').getByRole('button');
    await expect(rail).toHaveCount(2);
    await expect(rail.nth(1)).toContainText('Second slide');

    await rail.nth(1).click();
    await expect(page.getByTestId('slide-indicator')).toHaveText('2 / 2');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('slide-indicator')).toHaveText('1 / 2');
    expect(errors).toEqual([]);
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
    needs('pipeline-overview.pptx');
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
