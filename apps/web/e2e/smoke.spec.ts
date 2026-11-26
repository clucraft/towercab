import { expect, test } from '@playwright/test';
import { AIRPORT, aircraft, mockBackend } from './mocks';

/**
 * Smoke test: loads /KLAF with every network dependency mocked (REST API and WebSocket feed) and checks
 * that aircraft appear in the 3D scene.
 */

test('vehicles are listed on their own, and a link that does not apply is left out', async ({ page }) => {
  // As adsb.fi sends one at KDEN, after the server has made sense of it.
  const ops = (at: number) => ({
    hex: 'a7f001',
    addrType: 'adsr_icao',
    callsign: 'OPS8',
    category: 'C1',
    lat: 40.4142,
    lon: -86.9381,
    posTime: at,
    seenTime: at,
    altSource: 'ground',
    onGround: true,
    aglFt: 0,
    gsKt: 46,
    trackDeg: 90,
    headingDeg: 90,
    phase: 'vehicle',
    source: 'adsbfi',
  });
  await mockBackend(page, {
    delta: (at, step) => ({ upserts: [...aircraft(at, step), ops(at)], removed: [] }),
  });
  const { diagram, ...links } = AIRPORT.links;
  expect(diagram).toContain('faa.gov');
  await page.route('**/api/airports/KLAF', (route) => route.fulfill({ json: { ...AIRPORT, links } }));
  await page.goto('/KLAF');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });

  await expect(page.getByTestId('group-vehicles')).toContainText('OPS8');
  await expect(page.getByTestId('group-departing')).toHaveCount(0);
  await expect(page.getByTestId('aircraft-count')).toHaveText('3 aircraft');
  await page.getByTestId('group-vehicles').getByRole('button').click();
  await expect(page.getByTestId('selection-panel')).toContainText('Vehicle');

  const panel = page.getByTestId('side-panel');
  await expect(panel.getByRole('link', { name: 'LiveATC: listen to KLAF' })).toBeVisible();
  await expect(panel.getByRole('link', { name: /diagram/ })).toHaveCount(0);
});

test('aircraft from the feed appear in the 3D scene', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const backend = await mockBackend(page);

  await page.goto('/KLAF');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  // No tokens: Schematic, and Photoreal is not on offer.
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-mode', 'schematic');
  await expect(page.getByRole('button', { name: 'Photoreal' })).toBeDisabled();

  await expect(page.getByTestId('connection')).toHaveText('live');
  await expect(page.getByTestId('aircraft-count')).toHaveText('3 aircraft');
  expect(backend.subscribed()).toEqual(['KLAF']);

  // All three are drawn; the one on the ground stands on the (flat) surface and the other is above it.
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          ['a9e7a9', 'abca1f', 'a2eea2'].every((hex) => window.__towercab?.drawn(hex)?.visible),
        ),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  const drawn = await page.evaluate(() => ({
    count: window.__towercab?.stats().aircraft,
    parked: window.__towercab?.drawn('a9e7a9'),
    flying: window.__towercab?.drawn('a2eea2'),
  }));
  expect(drawn.count).toBe(3);
  expect(drawn.parked?.onGround).toBe(true);
  expect(drawn.parked?.height).toBeCloseTo(0, 1);
  // 464.8 m on the ellipsoid, less the 150.4 m field elevation the flat scene is measured from.
  expect(drawn.flying?.height).toBeGreaterThan(300);
  expect(drawn.flying?.height).toBeLessThan(330);

  // It moves: the taxiing aircraft is further east a few seconds later.
  const before = await page.evaluate(() => window.__towercab?.drawn('abca1f')?.lon ?? 0);
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => window.__towercab?.drawn('abca1f')?.lon ?? 0);
  expect(after).toBeGreaterThan(before);

  // Selecting shows the details panel.
  await page.evaluate(() => window.__towercab?.select('a2eea2'));
  const panel = page.getByTestId('selection-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('N2884L');
  await expect(panel).toContainText('Pattern');
  await expect(panel.getByRole('button', { name: 'Follow' })).toBeEnabled();

  await expect(page.getByText('Not for navigation or operational use.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the scene keeps drawing when an aircraft leaves and another takes its place', async ({ page }) => {
  // Two aircraft in the same phase, then one of them goes, then a third arrives in that phase. Trails of
  // one phase look the same, and once shared a Cesium object that left with the first aircraft.
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const second = (at: number, step: number, hex: string) => ({
    ...aircraft(at, step)[2],
    hex,
    callsign: `N${hex}`,
    registration: `N${hex}`,
    lat: 40.404,
  });
  await mockBackend(page, {
    delta: (at, step) => ({
      upserts: [
        ...aircraft(at, step),
        ...(step < 8 ? [second(at, step, 'aaaaa1')] : []),
        ...(step > 12 ? [second(at, step, 'aaaaa2')] : []),
      ],
      removed: step === 8 ? ['aaaaa1'] : [],
    }),
  });
  await page.goto('/KLAF');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  const visible = (hex: string) => page.evaluate((h) => window.__towercab?.drawn(h)?.visible ?? false, hex);
  await page.evaluate(() => {
    (window.__towercab as unknown as { first?: boolean }).first = true;
  });
  await expect.poll(() => visible('aaaaa1'), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => visible('aaaaa1'), { timeout: 30_000 }).toBe(false);
  await expect.poll(() => visible('aaaaa2'), { timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(3000);

  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0);
  const at = () => page.evaluate(() => window.__towercab?.drawn('a2eea2')?.lon ?? 0);
  const before = await at();
  await page.waitForTimeout(2500);
  expect(await at()).toBeLessThan(before);
  // It was never built again to get here, which would hide a failure.
  expect(await page.evaluate(() => (window.__towercab as unknown as { first?: boolean }).first)).toBe(true);
  expect(errors).toEqual([]);
});

test('following goes on while others leave, and ends when the followed aircraft does', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  // Two in the pattern; the one that is not followed goes first, then the followed one.
  const other = (at: number, step: number) => ({
    ...aircraft(at, step)[2],
    hex: 'aaaaa1',
    callsign: 'NOTHER',
    lat: 40.404,
  });
  await mockBackend(page, {
    delta: (at, step) => ({
      upserts: [
        ...aircraft(at, step).filter((a) => a.hex !== 'a2eea2' || step < 18),
        ...(step < 8 ? [other(at, step)] : []),
      ],
      removed: step === 8 ? ['aaaaa1'] : step === 18 ? ['a2eea2'] : [],
    }),
  });
  await page.goto('/KLAF');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  const visible = (hex: string) => page.evaluate((h) => window.__towercab?.drawn(h)?.visible ?? false, hex);
  await expect.poll(() => visible('aaaaa1'), { timeout: 30_000 }).toBe(true);
  await page.evaluate(() => window.__towercab?.follow('a2eea2'));
  await expect(page).toHaveURL(/view=follow/);

  // Any scene but this one would mean that it failed and was built again.
  await page.evaluate(() => {
    (window.__towercab as unknown as { first?: boolean }).first = true;
  });
  await expect.poll(() => visible('aaaaa1'), { timeout: 30_000 }).toBe(false);
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__towercab?.view)).toBe('follow');
  const at = () => page.evaluate(() => window.__towercab?.drawn('a2eea2')?.lon ?? 0);
  const before = await at();
  await page.waitForTimeout(2000);
  expect(await at()).toBeLessThan(before);

  await expect.poll(() => visible('a2eea2'), { timeout: 30_000 }).toBe(false);
  await expect(page.getByTestId('selection-panel')).toHaveCount(0);
  expect(await page.evaluate(() => window.__towercab?.view)).toBe('free');
  // The others are still there and still moving.
  expect(await visible('abca1f')).toBe(true);
  expect(
    await page.evaluate(() => (window.__towercab as unknown as { first?: boolean }).first),
    'the scene was built again',
  ).toBe(true);
  await expect(page.locator('.cesium-widget-errorPanel')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the view presets and the URL stay in step', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/KLAF?view=rwy-10');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page).toHaveURL(/view=rwy-10/);

  await page.getByTestId('view-tower').click();
  await expect(page).toHaveURL(/view=tower/);
  await page.keyboard.press('2');
  await expect(page).toHaveURL(/view=overhead/);
  await expect(page.getByTestId('view-overhead')).toHaveAttribute('aria-pressed', 'true');
});

test('the side panel lists the traffic, the weather hint and the sources', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/KLAF');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });

  const panel = page.getByTestId('side-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /N2884L/ })).toBeVisible();
  // Wind from 050 degrees: runway 05 faces straight into it.
  await expect(panel.getByTestId('runway-hint')).toContainText('runway 05');
  await expect(panel.getByRole('link', { name: 'LiveATC: listen to KLAF' })).toHaveAttribute(
    'target',
    '_blank',
  );
  await expect(page.getByTestId('credits')).toContainText('CesiumJS');

  // Picking a row selects that aircraft in the scene.
  await panel.getByRole('button', { name: /N2884L/ }).click();
  await expect(page.getByTestId('selection-panel')).toContainText('N2884L');

  // The panel can be put away and brought back.
  await page.getByTestId('panel-toggle').click();
  await expect(panel).toBeHidden();
  await page.getByTestId('panel-toggle').click();
  await expect(panel).toBeVisible();
});

test('the sky follows the sun over the airport, and the panel has its local times', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await mockBackend(page);
  const sky = () => page.evaluate(() => window.__towercab?.skyState);

  // Half an hour after sunset in Indiana.
  await page.goto('/KLAF?sky=2026-11-25T22:50Z');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  const daylight = page.getByTestId('daylight');
  await expect(daylight).toContainText('17:50 EST');
  await expect(daylight).toContainText('07:45');
  await expect(daylight).toContainText('17:24');
  await expect(daylight).toContainText('Civil twilight');
  await expect(daylight).toContainText('November 25, 2026');
  expect(await sky()).toMatchObject({ phase: 'civil' });

  // The sky is nowhere: were it somewhere, zooming over it would throw the camera a long way.
  await page.getByTestId('view-tower').click();
  await page.waitForTimeout(2500);
  const pointedAt = await page.evaluate(() => {
    interface Vec {
      x: number;
      y: number;
      z: number;
    }
    interface Inside {
      viewer: {
        camera: {
          position: { constructor: new (x: number, y: number, z: number) => Vec };
          getPickRay(at: { x: number; y: number }): { origin: Vec; direction: Vec };
        };
        scene: {
          canvas: { clientWidth: number; clientHeight: number };
          cartesianToCanvasCoordinates(v: Vec): { x: number; y: number };
          pickPosition(at: { x: number; y: number }): Vec | undefined;
        };
      };
    }
    const { camera, scene } = (window.__towercab as unknown as Inside).viewer;
    const { clientWidth, clientHeight } = scene.canvas;
    const at = (y: number) => {
      const { origin: o, direction: d } = camera.getPickRay({ x: clientWidth / 2, y: clientHeight * y });
      const Vec = camera.position.constructor;
      const ahead = new Vec(o.x + d.x * 100, o.y + d.y * 100, o.z + d.z * 100);
      return scene.pickPosition(scene.cartesianToCanvasCoordinates(ahead)) !== undefined;
    };
    return { sky: at(0.05), ground: at(0.9) };
  });
  expect(pointedAt).toEqual({ sky: false, ground: true });

  // Back to now, whatever that is here: the sun as drawn is where it is.
  await daylight.getByRole('button', { name: 'Back to now' }).click();
  await expect(page).not.toHaveURL(/sky=/);
  await expect.poll(async () => (await sky())?.setting).toBe('real');

  // Always day, and remembered.
  await page.getByTestId('sky-toggle').uncheck();
  expect(await sky()).toMatchObject({ phase: 'day', setting: 'day' });
  await page.reload();
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  expect(await sky()).toMatchObject({ setting: 'day' });
  await page.getByTestId('sky-toggle').check();
  expect(await sky()).toMatchObject({ setting: 'real' });
  expect(errors).toEqual([]);
});

test.describe('for a viewer in another time zone', () => {
  test.use({ timezoneId: 'Asia/Tokyo' });

  test('the times are the airport’s', async ({ page }) => {
    await mockBackend(page);
    await page.goto('/KLAF?sky=2026-11-25T22:50Z');
    await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
    expect(await page.evaluate(() => new Date(Date.UTC(2026, 10, 25, 22, 50)).getHours())).toBe(7);
    await expect(page.getByTestId('daylight')).toContainText('17:50 EST');
    await expect(page.getByTestId('daylight')).toContainText('November 25, 2026');
  });
});

test('a recording plays back without the live feed', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const backend = await mockBackend(page);

  await page.goto('/KLAF?replay=klaf-pattern');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  // It says what it is, and never claims to be live.
  await expect(page.getByTestId('connection')).toHaveText('replay', { timeout: 20_000 });
  await expect(page.getByTestId('aircraft-count')).not.toHaveText('0 aircraft', { timeout: 20_000 });
  await expect
    .poll(async () => page.evaluate(() => window.__towercab?.stats().aircraft ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(0);
  expect(backend.subscribed()).toEqual([]);
  expect(errors).toEqual([]);
});

test('a small landscape screen starts with the panel closed', async ({ page }) => {
  await page.setViewportSize({ width: 740, height: 360 });
  await mockBackend(page);
  await page.goto('/KLAF');
  await expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });
  await expect(page.getByTestId('side-panel')).toBeHidden();
  await page.getByTestId('panel-toggle').click();
  await expect(page.getByTestId('side-panel')).toBeVisible();
  // Nothing makes the page itself scroll sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
