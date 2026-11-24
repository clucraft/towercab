import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Runway } from '@towercab/shared';
import type { FetchLike } from '../src/providers/http';
import type { AdsbSource, FetchResult, Observation, ProviderId } from '../src/providers/types';

const FIXTURES = join(import.meta.dirname, 'fixtures');

export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

export function fixtureJson(name: string): unknown {
  return JSON.parse(fixtureText(name));
}

export interface FakeRoute {
  /** Substring of the URL this route answers. */
  match: string;
  status?: number;
  body?: string | (() => string);
  headers?: Record<string, string>;
}

export interface FakeFetch extends FetchLike {
  calls: { url: string; init: RequestInit | undefined; at: number }[];
}

/** A `fetch` that answers from a table and records every call. Unknown URLs fail loudly. */
export function fakeFetch(routes: FakeRoute[]): FakeFetch {
  const fn = (async (url: string, init?: RequestInit) => {
    fn.calls.push({ url, init, at: Date.now() });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new TypeError(`fakeFetch: no route for ${url}`);
    const body = typeof route.body === 'function' ? route.body() : (route.body ?? '');
    const status = route.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : body, {
      status,
      headers: { 'content-type': 'application/json', ...route.headers },
    });
  }) as FakeFetch;
  fn.calls = [];
  return fn;
}

/** Request headers of a recorded call, as a plain object. Empty when the call was not made. */
export function sentHeaders(call: FakeFetch['calls'][number] | undefined): Record<string, string> {
  return (call?.init?.headers as Record<string, string> | undefined) ?? {};
}

/** Routes for every upstream the server talks to, answered from the saved fixtures. */
export function upstreamRoutes(): FakeRoute[] {
  return [
    { match: 'opendata.adsb.fi/api/v3/lat/40.41', body: fixtureText('adsbfi-v3-klaf.json') },
    { match: 'opendata.adsb.fi/api/v3/lat/39.71', body: fixtureText('adsbfi-v3-kind.json') },
    {
      match: 'api.adsb.lol/v2/lat/40.41',
      body: fixtureText('adsblol-v2-klaf.json'),
      headers: {
        'x-ratelimit-limit': '500, 500;w=86400',
        'x-ratelimit-remaining': '498',
        'x-ratelimit-reset': '20608',
      },
    },
    {
      match: 'api.adsb.lol/v2/lat/39.71',
      body: fixtureText('adsblol-v2-kind.json'),
      headers: {
        'x-ratelimit-limit': '500, 500;w=86400',
        'x-ratelimit-remaining': '499',
        'x-ratelimit-reset': '20760',
      },
    },
    { match: 'api.airplanes.live', status: 403, body: fixtureText('airplaneslive-403.json') },
    {
      match: 'ourairports-data/airports.csv',
      body: fixtureText('ourairports-airports.csv'),
      headers: { etag: '"a1"' },
    },
    {
      match: 'ourairports-data/runways.csv',
      body: fixtureText('ourairports-runways.csv'),
      headers: { etag: '"r1"' },
    },
    { match: 'overpass', body: fixtureText('overpass-klaf.json') },
    { match: 'aviationweather.gov', body: fixtureText('metar-klaf-kind.json') },
    { match: 'planespotters.net', body: fixtureText('planespotters-a0d5d6.json') },
  ];
}

/** An observation with sensible defaults; override what the test is about. */
export function obs(overrides: Partial<Observation> & { hex: string }): Observation {
  return {
    addrType: 'adsb_icao',
    source: 'adsbfi',
    lat: 40.4129,
    lon: -86.9394,
    posTime: 1_000_000,
    seenTime: 1_000_000,
    altBaro: 1500,
    altGeomFt: null,
    gsKt: 90,
    trackDeg: 100,
    trueHeadingDeg: null,
    baroRateFpm: 0,
    geomRateFpm: null,
    ...overrides,
  };
}

/** KLAF's two runways as OurAirports has them. */
export const KLAF_RUNWAYS: Runway[] = [
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
        lat: 40.41400146484375,
        lon: -86.95089721679688,
        elevationFt: 600,
        headingTrue: 100,
        displacedThresholdFt: 0,
      },
      {
        ident: '28',
        lat: 40.41109848022461,
        lon: -86.92749786376953,
        elevationFt: 598,
        headingTrue: 280,
        displacedThresholdFt: 0,
      },
    ],
  },
];

export const KLAF = { lat: 40.412875, lon: -86.939363, elevationFt: 606 };

/** A scripted data source for scheduler tests. */
export class FakeSource implements AdsbSource {
  readonly label: string;
  calls: { at: number; lat: number; lon: number }[] = [];
  /** Set to make the next calls fail. */
  failWith: Error | null = null;
  observations: Observation[] = [];
  rate: FetchResult['rate'];

  constructor(readonly id: ProviderId) {
    this.label = id;
  }

  async fetchArea(lat: number, lon: number): Promise<FetchResult> {
    this.calls.push({ at: Date.now(), lat, lon });
    if (this.failWith) throw this.failWith;
    return { observations: this.observations, receivedAt: Date.now(), rate: this.rate };
  }
}

/** Smallest gap between consecutive entries of a list of timestamps. */
export function minGap(times: number[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < times.length; i += 1) {
    min = Math.min(min, (times[i] as number) - (times[i - 1] as number));
  }
  return min;
}
