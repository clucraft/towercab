import { expect, type Page, test } from '@playwright/test';
import { mockBackend } from './mocks';

/**
 * Cesium stops for good when drawing a frame throws, and when the browser takes the graphics context away (on a
 * phone mostly because memory ran out). Either way the page builds a new scene and carries on.
 */

const ready = (page: Page) =>
  expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });

const allDrawn = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() =>
          ['a9e7a9', 'abca1f', 'a2eea2'].every((hex) => window.__towercab?.drawn(hex)?.visible),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);

/** Marks the scene on show, so that its successor can be told from it. */
const mark = (page: Page) =>
  page.evaluate(() => {
    (window.__towercab as unknown as { marked?: boolean }).marked = true;
  });
const replaced = (page: Page) =>
  expect
    .poll(
      () =>
        page.evaluate(() => {
          const scene = window.__towercab as unknown as { marked?: boolean } | undefined;
          return scene !== undefined && !scene.marked;
        }),
      { timeout: 60_000 },
    )
    .toBe(true);

/** Makes the next frame throw, as a bug in the scene would. */
const breakRendering = (page: Page) =>
  page.evaluate(() => {
    const { viewer } = window.__towercab as unknown as {
      viewer: { scene: { primitives: { add(p: object): void }; requestRender(): void } };
    };
    viewer.scene.primitives.add({
      update() {
        throw new Error('broken on purpose');
      },
      isDestroyed: () => false,
      destroy() {},
    });
    viewer.scene.requestRender();
  });

test('a scene that fails while drawing is built again, with the same view and selection', async ({
  page,
}) => {
  await mockBackend(page);
  await page.goto('/KLAF?view=rwy-10');
  await ready(page);
  await allDrawn(page);
  await page.evaluate(() => window.__towercab?.select('a2eea2'));
  await expect(page.getByTestId('selection-panel')).toContainText('N2884L');

  await mark(page);
  await breakRendering(page);
  await replaced(page);
  await ready(page);
  await allDrawn(page);
  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0);
  await expect(page.locator('canvas.label-overlay')).toHaveCount(1);
  await expect(page).toHaveURL(/view=rwy-10/);
  await expect(page.getByTestId('selection-panel')).toContainText('N2884L');
  // Live traffic was not interrupted by it.
  await expect(page.getByTestId('connection')).toHaveText('live');
});

test('a lost graphics context is survived, too', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/KLAF');
  await ready(page);
  await allDrawn(page);
  await mark(page);
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.cesium-widget canvas');
    canvas?.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
  });
  await replaced(page);
  await ready(page);
  await allDrawn(page);
});

test('a scene that keeps failing is given up on, with a way to try again', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/KLAF');
  for (let i = 0; i < 4; i += 1) {
    await ready(page);
    await mark(page);
    await breakRendering(page);
    if (i < 3) await replaced(page);
  }
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('could not be started again');
  await expect(alert).toContainText('broken on purpose');
  // The rest of the page still works.
  await expect(page.getByTestId('aircraft-count')).toHaveText('3 aircraft');
  await alert.getByRole('button', { name: 'Reload the page' }).click();
  await ready(page);
  await allDrawn(page);
});
