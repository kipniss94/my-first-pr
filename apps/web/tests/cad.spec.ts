import { expect, test } from '@playwright/test';
import { canvasHasContent, openFixture, waitForRenderedCanvas, watchConsole } from './helpers';

test.describe('CAD viewer', () => {
  test('opens a binary STL and draws it', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'stepped-block.stl');

    await waitForRenderedCanvas(page);
    await expect(page.getByTestId('file-name')).toContainText('stepped-block.stl');
    await expect(page.getByTestId('model-tree')).toBeVisible();

    const litPixels = await canvasHasContent(page);
    expect(litPixels).toBeGreaterThan(1000);
    expect(errors).toEqual([]);
  });

  test('opens a STEP assembly with its component tree and B-Rep faces', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'bracket-assembly.step');
    await waitForRenderedCanvas(page);

    const tree = page.getByTestId('model-tree');
    await expect(tree).toContainText('Bracket assembly');
    await expect(tree).toContainText('BasePlate');
    await expect(tree).toContainText('Riser');
    await expect(page.locator('text=/2 parts ·/')).toBeVisible();

    // Selecting a component fills the properties panel with real numbers.
    await tree.getByRole('button', { name: 'BasePlate', exact: true }).click();
    const properties = page.getByTestId('properties-panel');
    await expect(properties).toBeVisible();
    await expect(properties).toContainText('Solid (B-Rep)');
    await expect(properties).toContainText('B-Rep faces');
    // The base plate is 80 x 60 x 8 mm.
    await expect(properties).toContainText('80.00 mm');
    await expect(properties).toContainText('60.00 mm');
    expect(errors).toEqual([]);
  });

  test('navigation, standard views and display modes all respond', async ({ page }) => {
    await openFixture(page, 'cube.step');
    await waitForRenderedCanvas(page);

    const canvas = page.locator('[data-testid="cad-canvas"] canvas').first();
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // Orbit: drag across the canvas and confirm the image changed.
    const before = await canvasHasContent(page);
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + 160, centre.y + 90, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const afterOrbit = await canvasHasContent(page);
    expect(afterOrbit).toBeGreaterThan(500);
    expect(afterOrbit).not.toBe(before);

    // Zoom with the wheel.
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(300);
    expect(await canvasHasContent(page)).toBeGreaterThan(500);

    // Pan with the right mouse button.
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(centre.x - 120, centre.y, { steps: 8 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(300);

    // Fit brings it back.
    await page.getByTestId('fit-button').click();
    await page.waitForTimeout(400);
    expect(await canvasHasContent(page)).toBeGreaterThan(1000);

    // Every standard view is reachable. The menu closes when an item is picked,
    // so each pass opens it again.
    for (const view of ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'] as const) {
      await page.getByTestId('views-button').click();
      await page.getByTestId(`view-${view}`).click();
      await page.waitForTimeout(250);
      expect(await canvasHasContent(page)).toBeGreaterThan(500);
    }

    // Display modes.
    await page.getByTestId('display-wireframe').click();
    await page.waitForTimeout(300);
    expect(await canvasHasContent(page)).toBeGreaterThan(50);
    await page.getByTestId('display-shaded-edges').click();
    await page.waitForTimeout(300);
    expect(await canvasHasContent(page)).toBeGreaterThan(500);
    await page.getByTestId('display-shaded').click();
  });

  test('clicking a part selects it and shows properties', async ({ page }) => {
    await openFixture(page, 'cube.step');
    await waitForRenderedCanvas(page);

    const canvas = page.locator('[data-testid="cad-canvas"] canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const properties = page.getByTestId('properties-panel');
    await expect(properties).toBeVisible();
    await expect(properties).toContainText('Cube');
    // A 40 mm cube: 64 000 mm³ shown as 64 cm³.
    await expect(properties).toContainText('64000.00 mm³');
  });

  test('measuring a distance produces a numeric readout', async ({ page }) => {
    await openFixture(page, 'cube.step');
    await waitForRenderedCanvas(page);

    await page.getByTestId('tool-distance').click();
    const canvas = page.locator('[data-testid="cad-canvas"] canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');

    // Two points on the visible faces of the cube.
    await page.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.42);
    await page.waitForTimeout(200);
    await page.mouse.click(box.x + box.width * 0.58, box.y + box.height * 0.58);

    const list = page.getByTestId('measurement-list');
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(list).toContainText('Distance');
    await expect(list).toContainText('mm');
    await expect(list).toContainText('ΔX');
  });

  test('the section plane cuts the model and can be moved', async ({ page }) => {
    await openFixture(page, 'hollow-block.step');
    await waitForRenderedCanvas(page);

    const before = await canvasHasContent(page);
    await page.getByTestId('toolbar-section').click();
    await expect(page.getByTestId('section-toggle')).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(500);

    const afterCut = await canvasHasContent(page);
    expect(afterCut).toBeGreaterThan(200);
    expect(afterCut).not.toBe(before);

    // Moving the plane changes what is on screen.
    const slider = page.getByTestId('section-position');
    await slider.fill('0.2');
    await page.waitForTimeout(400);
    const moved = await canvasHasContent(page);
    expect(moved).not.toBe(afterCut);

    // The readout follows the plane.
    await expect(page.locator('text=/Section [XYZ] @/')).toBeVisible();
  });

  test('hiding and isolating components works from the tree', async ({ page }) => {
    await openFixture(page, 'bracket-assembly.step');
    await waitForRenderedCanvas(page);

    const full = await canvasHasContent(page);
    const row = page.getByTestId('model-tree').locator('li', { hasText: 'Riser' }).first();
    await row.hover();
    await row.getByRole('button', { name: /^Isolate/ }).first().click();
    await page.waitForTimeout(400);

    const isolated = await canvasHasContent(page);
    expect(isolated).toBeGreaterThan(100);
    expect(isolated).toBeLessThan(full);
  });

  test('a DXF drawing renders with its layers', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'plate.dxf');

    const canvas = page.getByTestId('dxf-canvas');
    await expect(canvas).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Layers' })).toBeVisible();
    await expect(page.locator('text=OUTLINE')).toBeVisible();
    await expect(page.locator('text=HOLES')).toBeVisible();

    const drawn = await page.evaluate(() => {
      const element = document.querySelector<HTMLCanvasElement>('[data-testid="dxf-canvas"]');
      if (!element) return -1;
      const context = element.getContext('2d');
      if (!context) return -2;
      const data = context.getImageData(0, 0, element.width, element.height).data;
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 60 || data[i + 1] > 60 || data[i + 2] > 60) lit += 1;
      }
      return lit;
    });
    expect(drawn).toBeGreaterThan(200);
    expect(errors).toEqual([]);
  });

  test('a corrupt CAD file fails politely instead of crashing', async ({ page }) => {
    const errors = watchConsole(page);
    await openFixture(page, 'broken.step', { expectError: true });

    const panel = page.getByTestId('error-panel');
    await expect(panel).toContainText("We couldn't read the geometry");
    await expect(panel).toContainText('reference:');
    // A next step is always offered.
    await expect(page.getByRole('link', { name: 'Upload another file' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a text file named .stl opens as text and says so', async ({ page }) => {
    await openFixture(page, 'not-a-model.stl');
    await expect(page.getByTestId('warnings')).toContainText('but its contents are');
    await expect(page.getByTestId('word-content')).toBeVisible();
  });
});
