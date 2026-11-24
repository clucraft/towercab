import { expect, type Page, test } from '@playwright/test';

/**
 * Smoke test: loads /KLAF with every network dependency mocked (REST API and WebSocket feed) and checks
 * that aircraft appear in the 3D scene. No tokens, so this also covers Schematic on a flat surface, the
 * mode that has to work with nothing configured.
 */

const AIRPORT = {
  icao: 'KLAF',
  name: 'Purdue University Airport',
  city: 'West Lafayette',
  lat: 40.412875,
  lon: -86.939363,
  elevationFt: 606,
  defaultView: 'overhead',
  available: true,
  geoidUndulationM: -34.32,
  elevationEllipsoidM: 150.39,
  radiusNm: 6,
  ceilingFtAgl: 5000,
  tower: { lat: 40.414761, lon: -86.933297, heightM: 23, approximate: true, source: 'config' },
  runways: [
    {
      id: '05/23',
      lengthFt: 4225,
      widthFt: 100,
      surface: 'ASP',
      lighted: true,
      closed: false,
      ends: [
        {
          ident: '05',
          lat: 40.40819931,
          lon: -86.93900299,
          elevationFt: 593,
          headingTrue: 47.3,
          displacedThresholdFt: 0,
        },
        {
          ident: '23',
          lat: 40.41569901,
          lon: -86.92749786,
          elevationFt: 603,
          headingTrue: 227.3,
          displacedThresholdFt: 0,
        },
      ],
    },
    {
      id: '10/28',
      lengthFt: 6600,
      widthFt: 150,
      surface: 'ASP',
      lighted: true,
      closed: false,
      ends: [
        {
          ident: '10',
          lat: 40.41400146,
          lon: -86.95089722,
          elevationFt: 600,
          headingTrue: 100,
          displacedThresholdFt: 0,
        },
        {
          ident: '28',
          lat: 40.41109848,
          lon: -86.92749786,
          elevationFt: 598,
          headingTrue: 280,
          displacedThresholdFt: 0,
        },
      ],
    },
  ],
  links: {
    liveatc: 'https://www.liveatc.net/search/?icao=KLAF',
    diagram: 'https://www.faa.gov/airports/runway_safety/diagrams/',
    flightaware: 'https://www.flightaware.com/live/airport/KLAF',
  },
  sources: { airport: 'ourairports', layout: null, layoutFetchedAt: null },
  layout: null,
};

const CLIENT_CONFIG = {
  version: 'e2e',
  cesiumIonToken: null,
  googleMapsApiKey: null,
  features: { photoreal: false, terrain: false, cameras: false, admin: false, photos: false },
  renderDelayMs: 2500,
  attributions: [{ name: 'adsb.fi', url: 'https://adsb.fi', note: 'open data' }],
};

const STATUS = {
  pollState: 'active',
  viewers: 1,
  qnhHpa: 1034.3,
  providers: [
    {
      id: 'adsbfi',
      label: 'adsb.fi',
      enabled: true,
      state: 'ok',
      priority: 1,
      requests: 3,
      failures: 0,
      rateLimited: 0,
    },
  ],
};

/** Three aircraft as the server would send them: one parked, one taxiing, one in the pattern. */
function aircraft(at: number, step: number) {
  return [
    {
      hex: 'a9e7a9',
      addrType: 'adsb_icao',
      callsign: 'N73719',
      registration: 'N73719',
      typeCode: 'C172',
      category: 'A1',
      lat: 40.4165,
      lon: -86.9365,
      posTime: at,
      seenTime: at,
      altSource: 'ground',
      onGround: true,
      aglFt: 0,
      gsKt: 0,
      headingDeg: 233,
      phase: 'parked',
      source: 'adsbfi',
    },
    {
      hex: 'abca1f',
      addrType: 'adsb_icao',
      callsign: 'PDU59',
      registration: 'N859PU',
      typeCode: 'P28A',
      category: 'A1',
      lat: 40.4138,
      lon: -86.945 + step * 0.00012,
      posTime: at,
      seenTime: at,
      altSource: 'ground',
      onGround: true,
      aglFt: 0,
      gsKt: 12,
      trackDeg: 90,
      headingDeg: 90,
      phase: 'taxiing',
      source: 'adsbfi',
    },
    {
      hex: 'a2eea2',
      addrType: 'adsb_icao',
      callsign: 'N2884L',
      registration: 'N2884L',
      typeCode: 'P28A',
      category: 'A1',
      lat: 40.424,
      lon: -86.93 - step * 0.0009,
      posTime: at,
      seenTime: at,
      altBaroFt: 1175,
      altGeomFt: 1525,
      altMslFt: 1588,
      heightM: 464.8,
      aglFt: 982,
      altSource: 'geom',
      onGround: false,
      gsKt: 78,
      trackDeg: 280,
      headingDeg: 280,
      vertRateFpm: 0,
      squawk: '1200',
      phase: 'pattern',
      source: 'adsbfi',
    },
  ];
}

async function mockBackend(page: Page): Promise<{ subscribed: () => string[] }> {
  const subscriptions: string[] = [];
  await page.route('**/api/client-config', (route) => route.fulfill({ json: CLIENT_CONFIG }));
  await page.route('**/api/airports', (route) =>
    route.fulfill({
      json: [
        {
          icao: 'KLAF',
          name: AIRPORT.name,
          city: AIRPORT.city,
          lat: AIRPORT.lat,
          lon: AIRPORT.lon,
          elevationFt: 606,
          defaultView: 'overhead',
          available: true,
        },
      ],
    }),
  );
  await page.route('**/api/airports/KLAF', (route) => route.fulfill({ json: AIRPORT }));
  // A real observation from KLAF (2026-11-24 20:54Z), as the server decodes it.
  await page.route('**/api/metar/KLAF', (route) =>
    route.fulfill({
      json: {
        metar: {
          icao: 'KLAF',
          raw: 'METAR KLAF 242054Z 05005KT 10SM FEW034 04/M04 A3050 RMK AO2 SLP334 T00391039 55013',
          obsTime: Date.now() - 20 * 60_000,
          fetchedAt: Date.now(),
          tempC: 3.9,
          dewpointC: -3.9,
          windDirDeg: 50,
          windVariable: false,
          windSpeedKt: 5,
          windGustKt: null,
          visibility: '10+',
          altimHpa: 1032.9,
          flightCategory: 'VFR',
          clouds: [{ cover: 'FEW', baseFt: 3400 }],
        },
      },
    }),
  );

  await page.routeWebSocket('**/ws', (socket) => {
    let seq = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    socket.send(
      JSON.stringify({ type: 'hello', serverTime: Date.now(), version: 'e2e', pingIntervalMs: 20_000 }),
    );
    socket.onMessage((data) => {
      const message = JSON.parse(String(data)) as { type: string; icao?: string };
      if (message.type !== 'subscribe' || !message.icao) return;
      subscriptions.push(message.icao);
      const t0 = Date.now();
      socket.send(
        JSON.stringify({
          type: 'snapshot',
          serverTime: t0,
          icao: message.icao,
          seq,
          aircraft: aircraft(t0 - 400, 0),
          trails: {},
          status: STATUS,
        }),
      );
      // Deltas every second, each with positions a little further along.
      timer = setInterval(() => {
        seq += 1;
        const t = Date.now();
        socket.send(
          JSON.stringify({
            type: 'delta',
            serverTime: t,
            icao: message.icao,
            seq,
            upserts: aircraft(t - 400, seq),
            removed: [],
          }),
        );
      }, 1000);
    });
    socket.onClose(() => clearInterval(timer));
  });
  return { subscribed: () => subscriptions };
}

interface SceneHandle {
  stats(): { aircraft: number; mode: string };
  drawn(
    hex: string,
  ): { visible: boolean; lat: number; lon: number; height: number; onGround: boolean } | undefined;
  select(hex: string | null): void;
}
declare global {
  interface Window {
    __towercab?: SceneHandle;
  }
}

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
  await expect(panel.getByRole('link', { name: /LiveATC/ })).toHaveAttribute('target', '_blank');
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
