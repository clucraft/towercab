import { expect, type Page, test } from '@playwright/test';
import { mockBackend } from './mocks';

/** A 2x1 pixel picture, so that nothing is fetched from outside. */
const PICTURE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="500" height="337"%3E%3Crect width="500" height="337" fill="%23456"/%3E%3C/svg%3E';

const TYPE_PHOTO = {
  subject: 'Piper PA-28 Cherokee',
  thumbnail: PICTURE,
  width: 500,
  height: 337,
  link: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
  author: 'A. Photographer',
  license: 'CC BY-SA 2.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0',
};
const AIRCRAFT_PHOTO = {
  thumbnail: PICTURE,
  width: 420,
  height: 280,
  link: 'https://www.planespotters.net/photo/1/example',
  photographer: 'P. Spotter',
};

async function open(
  page: Page,
  answers: { aircraft?: object | null; type?: object | null },
  asked: string[] = [],
): Promise<void> {
  await mockBackend(page, { features: { photos: true, typePhotos: true } });
  await page.route('**/api/photos/*', (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { photo: answers.aircraft ?? null } });
  });
  await page.route('**/api/type-photos/*', (route) => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { photo: answers.type ?? null } });
  });
  await page.goto('/KLAF');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => window.__towercab?.drawn('a2eea2') !== undefined), { timeout: 30_000 })
    .toBe(true);
  await page.evaluate(() => window.__towercab?.select('a2eea2'));
  await expect(page.getByTestId('selection-panel')).toContainText('N2884L');
}

test('an aircraft nobody has photographed shows its type, with the credit the licence asks for', async ({
  page,
}) => {
  const asked: string[] = [];
  await open(page, { type: TYPE_PHOTO }, asked);
  const picture = page.getByTestId('picture-type');
  await expect(picture.getByRole('img', { name: 'Piper PA-28 Cherokee' })).toBeVisible();
  await expect(picture).toContainText('Piper PA-28 Cherokee (not this aircraft). Photo: A. Photographer');
  await expect(picture.getByRole('link', { name: 'CC BY-SA 2.0' })).toHaveAttribute(
    'href',
    TYPE_PHOTO.licenseUrl,
  );
  await expect(picture.getByRole('link', { name: 'Wikimedia Commons' })).toHaveAttribute(
    'href',
    TYPE_PHOTO.link,
  );
  expect(asked).toEqual(['/api/photos/a2eea2', '/api/type-photos/P28A']);
});

test('a photo of the aircraft itself comes first, and the type is not asked for', async ({ page }) => {
  const asked: string[] = [];
  await open(page, { aircraft: AIRCRAFT_PHOTO, type: TYPE_PHOTO }, asked);
  await expect(page.getByTestId('picture-aircraft')).toContainText('© P. Spotter · planespotters.net');
  await expect(page.getByTestId('picture-type')).toHaveCount(0);
  expect(asked).toEqual(['/api/photos/a2eea2']);
});

test('without any picture, or with one that does not load, the panel shows the details alone', async ({
  page,
}) => {
  await open(page, { type: { ...TYPE_PHOTO, thumbnail: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==' } });
  await expect(page.locator('.selection .photo')).toHaveCount(0);
  await expect(page.getByTestId('selection-panel')).toContainText('P28A');
});

test('on a phone the picture is there, in a strip, and the badges stay clear of the credits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 839 });
  await open(page, { type: TYPE_PHOTO });
  const image = page.getByTestId('picture-type').getByRole('img');
  await expect(image).toBeVisible();
  const box = await image.boundingBox();
  expect(box?.height).toBeLessThan(100);

  const badges = await page.locator('.badges').boundingBox();
  const credits = await page.locator('.scene .cesium-viewer-bottom').boundingBox();
  const panel = await page.getByTestId('selection-panel').boundingBox();
  if (!badges || !credits || !panel) throw new Error('something is not on the page');
  expect(badges.y + badges.height).toBeLessThan(credits.y);
  expect(badges.x).toBeGreaterThan(panel.x + panel.width);
  expect(panel.y + panel.height).toBeLessThan(credits.y);

  // Aircraft labels are drawn behind the panel, not across it.
  const top = await page.evaluate(
    ([x, y]) => document.elementsFromPoint(x as number, y as number)[0]?.closest('aside')?.className ?? null,
    [panel.x + panel.width / 2, panel.y + 12],
  );
  expect(top).toBe('selection');
  const order = await page.evaluate(() =>
    ['.label-overlay', '.selection', '.cesium-viewer-bottom'].map((s) =>
      Number(getComputedStyle(document.querySelector(s) as Element).zIndex),
    ),
  );
  expect(order).toEqual([2, 2, 3]);
});
