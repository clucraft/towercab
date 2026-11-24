import type { Page } from '@playwright/test';

/**
 * What the browser tests put in place of the server: the REST API and the WebSocket feed, answered from
 * fixed data. No tokens, so the scene is Schematic on a flat surface, the mode that has to work with
 * nothing configured.
 */

export const AIRPORT = {
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

export const CLIENT_CONFIG = {
  version: 'e2e',
  cesiumIonToken: null,
  googleMapsApiKey: null,
  features: { photoreal: false, terrain: false, cameras: false, admin: false, photos: false },
  renderDelayMs: 2500,
  attributions: [{ name: 'adsb.fi', url: 'https://adsb.fi', note: 'open data' }],
};

export const STATUS = {
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
export function aircraft(at: number, step: number) {
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

export async function mockBackend(
  page: Page,
  options: { features?: Partial<(typeof CLIENT_CONFIG)['features']> } = {},
): Promise<{ subscribed: () => string[] }> {
  const subscriptions: string[] = [];
  await page.route('**/api/client-config', (route) =>
    route.fulfill({
      json: { ...CLIENT_CONFIG, features: { ...CLIENT_CONFIG.features, ...options.features } },
    }),
  );
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

export interface SceneHandle {
  stats(): { aircraft: number; mode: string };
  drawn(
    hex: string,
  ): { visible: boolean; lat: number; lon: number; height: number; onGround: boolean } | undefined;
  select(hex: string | null): void;
  readonly view: string;
  readonly matchedCamera: string | null;
  poseHandleAt(which: 'aim' | 'fov'): { x: number; y: number } | null;
  cameraLensAt(id: string): { x: number; y: number } | null;
}
declare global {
  interface Window {
    __towercab?: SceneHandle;
  }
}
