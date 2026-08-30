import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';

export const FIXTURES = path.resolve(__dirname, '../../../fixtures');

export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

/**
 * Collect console errors so every test can assert the page stayed clean.
 * A few classes of noise are ignored on purpose — they say nothing about the
 * application's own behaviour.
 */
export function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/favicon|ERR_ABORTED|Download the React DevTools/i.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Upload a fixture through the real upload control and wait for the viewer. */
export async function openFixture(page: Page, name: string, options: { expectError?: boolean } = {}) {
  await page.goto('/');
  await page.setInputFiles('[data-testid="file-input"]', fixture(name));

  await page.waitForURL(/\/viewer/, { timeout: 20_000 });

  if (options.expectError) {
    await expect(page.getByTestId('error-panel')).toBeVisible({ timeout: 60_000 });
    return;
  }

  // The stage rail disappears once the document is open.
  await expect(page.getByTestId('stage-rail')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('error-panel')).toHaveCount(0);
}

/**
 * Drop a real file onto the page, the way a person would.
 *
 * The bytes are read in Node and rebuilt into a `File` inside the page, so this
 * exercises the actual `drop` handler rather than the file input behind it. The
 * workspace listens on the window, so anywhere on the page counts.
 */
export async function dropFile(page: Page, name: string, target = 'body') {
  const bytes = await readFile(fixture(name));
  const dataTransfer = await page.evaluateHandle(
    ({ data, fileName }) => {
      const binary = atob(data);
      const buffer = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) buffer[i] = binary.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([buffer], fileName));
      return transfer;
    },
    { data: bytes.toString('base64'), fileName: name },
  );
  await page.locator(target).first().dispatchEvent('drop', { dataTransfer });
}

/**
 * Wait until the 3D canvas has actually drawn geometry.
 *
 * The canvas exists as soon as the scene is constructed, which is well before
 * the model finishes loading — waiting for the element alone would sample an
 * empty frame.
 */
export async function waitForRenderedCanvas(page: Page, selector = '[data-testid="cad-canvas"] canvas') {
  await expect(page.locator(selector).first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => canvasHasContent(page), { timeout: 60_000 }).toBeGreaterThan(1000);
}

/**
 * Sample the WebGL canvas and report how many pixels differ from the clear
 * colour — the cheapest reliable way to prove geometry is actually on screen.
 */
export async function canvasHasContent(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="cad-canvas"] canvas');
    if (!canvas) return -1;
    const context = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!context) return -2;
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(width * height * 4);
    context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
    let different = 0;
    // The renderer clears to #0e131b.
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      if (Math.abs(r - 14) > 8 || Math.abs(g - 19) > 8 || Math.abs(b - 27) > 8) different += 1;
    }
    return different;
  });
}
