import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AirportEntrySchema, distanceM, isTimeZone } from '@towercab/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAirportInfo, defaultLinks } from '../src/reference/airportService';
import { geoidUndulationM } from '../src/reference/geoid';
import { MetarService, parseMetar } from '../src/reference/metar';
import { findAirports, findRunways, OurAirportsStore, parseCsv } from '../src/reference/ourairports';
import {
  assembleRings,
  buildOverpassQuery,
  findTower,
  LayoutStore,
  OSM_ATTRIBUTION,
  overpassToLayout,
} from '../src/reference/overpass';
import { PhotoService, parsePhotoResponse } from '../src/reference/photos';
import { timeZoneAt } from '../src/reference/timeZone';
import { fakeFetch, fixtureJson, fixtureText, sentHeaders, upstreamRoutes } from './helpers';

const UA = 'TowerCab-tests/0 (+https://example.test)';

describe('EGM96 geoid', () => {
  it('is about -33 m in central Indiana (computed, not hardcoded)', () => {
    const klaf = geoidUndulationM(40.412875, -86.939363);
    const kind = geoidUndulationM(39.7173, -86.294403);
    for (const n of [klaf, kind]) {
      expect(n).toBeGreaterThan(-35);
      expect(n).toBeLessThan(-31);
    }
    expect(klaf).not.toBe(kind);
  });

  it('follows the well-known shape of the geoid elsewhere', () => {
    // High over the North Atlantic and New Guinea, low south of India.
    expect(geoidUndulationM(64.1, -21.9)).toBeGreaterThan(55);
    expect(geoidUndulationM(-5, 145)).toBeGreaterThan(60);
    expect(geoidUndulationM(5, 79)).toBeLessThan(-90);
  });
});

describe('CSV reader', () => {
  const rows = (text: string) => {
    const out: string[][] = [];
    parseCsv(text, (row) => {
      out.push(row);
      return true;
    });
    return out;
  };

  it('handles quotes, embedded commas, doubled quotes, empty fields and both line endings', () => {
    expect(rows('a,b,c\r\n1,"x, y","say ""hi"""\n,,\n"multi\nline",2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['', '', ''],
      ['multi\nline', '2', '3'],
    ]);
  });

  it('can stop early', () => {
    let seen = 0;
    parseCsv('a\nb\nc\n', () => {
      seen += 1;
      return seen < 2;
    });
    expect(seen).toBe(2);
  });
});

describe('OurAirports', () => {
  const airportsCsv = fixtureText('ourairports-airports.csv');
  const runwaysCsv = fixtureText('ourairports-runways.csv');

  it('finds KLAF and KIND with the published reference point and field elevation', () => {
    const found = findAirports(airportsCsv, ['KLAF', 'KIND']);
    expect(found.get('KLAF')).toMatchObject({
      ident: 'KLAF',
      name: 'Purdue University Airport',
      lat: 40.412875,
      lon: -86.939363,
      elevationFt: 606,
      municipality: 'West Lafayette',
    });
    expect(found.get('KIND')).toMatchObject({
      name: 'Indianapolis International Airport',
      lat: 39.7173,
      lon: -86.294403,
      elevationFt: 797,
    });
    expect(found.has('KORD')).toBe(false);
  });

  it('also matches on the GPS code, and is not fooled by lower case', () => {
    // The heliport's ident is 00A; its GPS code is K00A.
    expect(findAirports(airportsCsv, ['k00a']).get('K00A')).toMatchObject({ ident: '00A', type: 'heliport' });
    expect(findAirports(airportsCsv, ['ZZZZ']).size).toBe(0);
  });

  it('reads both ends of every KLAF and KIND runway', () => {
    const found = findRunways(runwaysCsv, ['KLAF', 'KIND']);
    expect(found.get('KLAF')?.map((r) => r.id)).toEqual(['05/23', '10/28']);
    expect(
      found
        .get('KIND')
        ?.map((r) => r.id)
        .sort(),
    ).toEqual(['05L/23R', '05R/23L', '14/32']);

    const long = found.get('KLAF')?.find((r) => r.id === '10/28');
    expect(long).toMatchObject({
      lengthFt: 6600,
      widthFt: 150,
      surface: 'ASP',
      lighted: true,
      closed: false,
    });
    expect(long?.ends[0]).toMatchObject({ ident: '10', headingTrue: 100, elevationFt: 600 });
    expect(long?.ends[1]).toMatchObject({ ident: '28', headingTrue: 280, elevationFt: 598 });
    // The coordinates really are 6,600 ft apart.
    const [a, b] = long?.ends ?? [];
    expect(distanceM(a?.lat ?? 0, a?.lon ?? 0, b?.lat ?? 0, b?.lon ?? 0) / 0.3048).toBeCloseTo(6600, -2);
  });

  it('leaves out runways that have no coordinates (the heliport pad)', () => {
    expect(findRunways(runwaysCsv, ['00A']).get('00A')).toBeUndefined();
  });

  describe('store', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'towercab-oa-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('downloads on first use, then answers from the cache', async () => {
      const fetchImpl = fakeFetch(upstreamRoutes());
      const store = new OurAirportsStore({ dataDir: dir, userAgent: UA, fetchImpl });
      const first = await store.lookup(['KLAF', 'KIND']);
      expect([...first.airports.keys()].sort()).toEqual(['KIND', 'KLAF']);
      expect(first.runways.get('KIND')).toHaveLength(3);
      expect(fetchImpl.calls).toHaveLength(2);
      expect(await readFile(join(dir, 'ourairports', 'airports.csv'), 'utf8')).toContain('"KLAF"');

      const again = await store.lookup(['KLAF']);
      expect(again.airports.get('KLAF')?.elevationFt).toBe(606);
      expect(fetchImpl.calls).toHaveLength(2);
    });

    it('refreshes a week-old copy with If-None-Match and keeps it on 304', async () => {
      let now = 1_000_000;
      const fetchImpl = fakeFetch(upstreamRoutes());
      const store = new OurAirportsStore({ dataDir: dir, userAgent: UA, fetchImpl, now: () => now });
      await store.lookup(['KLAF']);
      expect(await store.isStale()).toBe(false);

      now += 8 * 86_400_000;
      expect(await store.isStale()).toBe(true);
      const notModified = fakeFetch([{ match: 'ourairports-data', status: 304 }]);
      const stale = new OurAirportsStore({
        dataDir: dir,
        userAgent: UA,
        fetchImpl: notModified,
        now: () => now,
      });
      expect(await stale.refresh()).toBe(false);
      expect(sentHeaders(notModified.calls[0])['If-None-Match']).toBe('"a1"');
      expect(await stale.isStale()).toBe(false);
      expect((await stale.lookup(['KLAF'])).airports.has('KLAF')).toBe(true);
    });

    it('keeps working from the cache when the download fails, and reports nothing when there is no cache', async () => {
      const down = fakeFetch([{ match: 'ourairports-data', status: 503 }]);
      const empty = new OurAirportsStore({ dataDir: dir, userAgent: UA, fetchImpl: down });
      expect((await empty.lookup(['KLAF'])).airports.size).toBe(0);

      const warm = new OurAirportsStore({
        dataDir: dir,
        userAgent: UA,
        fetchImpl: fakeFetch(upstreamRoutes()),
      });
      await warm.lookup(['KLAF']);
      const offline = new OurAirportsStore({
        dataDir: dir,
        userAgent: UA,
        fetchImpl: down,
        now: () => Date.now() + 30 * 86_400_000,
      });
      expect((await offline.lookup(['KLAF'])).airports.has('KLAF')).toBe(true);
    });
  });
});

describe('METAR', () => {
  const json = fixtureJson('metar-klaf-kind.json');

  it('decodes the KIND observation captured live', () => {
    const metar = parseMetar(json, 'KIND', 5000);
    expect(metar).toMatchObject({
      icao: 'KIND',
      raw: 'SPECI KIND 241757Z 05011G18KT 10SM FEW030 BKN250 05/M06 A3050 RMK AO2 T00501056',
      obsTime: 1795543020000,
      fetchedAt: 5000,
      tempC: 5,
      dewpointC: -5.6,
      windDirDeg: 50,
      windVariable: false,
      windSpeedKt: 11,
      windGustKt: 18,
      visibility: '10+',
      altimHpa: 1032.9,
      flightCategory: 'VFR',
    });
    expect(metar?.clouds).toEqual([
      { cover: 'FEW', baseFt: 3000 },
      { cover: 'BKN', baseFt: 25000 },
    ]);
  });

  it('picks the right station out of a multi-station answer, and copes with odd answers', () => {
    expect(parseMetar(json, 'KLAF', 0)?.icao).toBe('KLAF');
    expect(parseMetar(json, 'KORD', 0)).toBeNull();
    expect(parseMetar(null, 'KLAF', 0)).toBeNull();
    expect(
      parseMetar(
        [{ icaoId: 'KLAF', rawOb: 'KLAF 241754Z VRB04KT 10SM CLR', wdir: 'VRB', wspd: 4 }],
        'KLAF',
        0,
      ),
    ).toMatchObject({
      windDirDeg: null,
      windVariable: true,
      windSpeedKt: 4,
      altimHpa: null,
    });
  });

  it('caches for five minutes and never fetches on its own', async () => {
    let now = 1_000_000;
    const fetchImpl = fakeFetch(upstreamRoutes());
    const service = new MetarService({ userAgent: UA, fetchImpl, now: () => now });
    expect((await service.get('KLAF'))?.icao).toBe('KLAF');
    expect(fetchImpl.calls[0]?.url).toBe('https://aviationweather.gov/api/data/metar?ids=KLAF&format=json');

    now += 299_000;
    await service.get('KLAF');
    expect(service.peek('KLAF')?.icao).toBe('KLAF');
    expect(fetchImpl.calls).toHaveLength(1);

    now += 2000;
    await service.get('KLAF');
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('answers everyone who asks at the same moment from one fetch', async () => {
    const fetchImpl = fakeFetch(upstreamRoutes());
    const service = new MetarService({ userAgent: UA, fetchImpl, now: () => 1_000_000 });
    const answers = await Promise.all([service.get('KLAF'), service.get('KLAF'), service.get('KLAF')]);
    expect(answers.map((m) => m?.icao)).toEqual(['KLAF', 'KLAF', 'KLAF']);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('serves the last report when a refresh fails, and waits before retrying', async () => {
    let now = 1_000_000;
    let fail = false;
    const good = fakeFetch(upstreamRoutes());
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (fail) return new Response('busy', { status: 503 });
      return good(url, init);
    };
    const service = new MetarService({ userAgent: UA, fetchImpl, now: () => now });
    await service.get('KIND');
    fail = true;
    now += 400_000;
    expect((await service.get('KIND'))?.altimHpa).toBe(1032.9);
    const callsAfterFailure = good.calls.length;
    fail = false;
    now += 30_000;
    await service.get('KIND');
    expect(good.calls.length).toBe(callsAfterFailure);
    now += 31_000;
    await service.get('KIND');
    expect(good.calls.length).toBe(callsAfterFailure + 1);
  });
});

describe('Overpass layout', () => {
  const layout = overpassToLayout(fixtureJson('overpass-klaf.json'), 123);
  const kinds = (kind: string) => layout.features.filter((f) => f.properties.kind === kind);

  it('asks one question per airport, by ICAO tag, for aeroways and buildings inside the aerodrome', () => {
    const query = buildOverpassQuery('klaf');
    expect(query).toContain('["aeroway"="aerodrome"]["icao"="KLAF"]');
    expect(query).toContain('map_to_area');
    expect(query).toContain('nwr["aeroway"](area.a)');
    expect(query).toContain('way["building"](area.a)');
    expect(query).toContain('out tags geom');
    // The code is the only thing interpolated; nothing else can get into the query.
    expect(buildOverpassQuery('K"];node(1);out;//')).toContain('["icao"="KNODE1OUT"]');
  });

  it('converts the KLAF answer captured live', () => {
    expect(layout.type).toBe('FeatureCollection');
    expect(layout.attribution).toBe(OSM_ATTRIBUTION);
    expect(layout.fetchedAt).toBe(123);
    expect(kinds('runway')).toHaveLength(2);
    expect(kinds('taxiway')).toHaveLength(37);
    expect(kinds('holding_position')).toHaveLength(17);
    expect(kinds('apron')).toHaveLength(3);
    expect(kinds('hangar')).toHaveLength(7);
    expect(kinds('building')).toHaveLength(14);
    // The aerodrome comes back twice (boundary and area query) and is kept once.
    expect(kinds('aerodrome')).toHaveLength(1);
    // Things that are not drawn are left out.
    expect(layout.features.some((f) => f.properties.kind === 'communication')).toBe(false);
  });

  it('gives each kind the geometry it is drawn with', () => {
    for (const f of kinds('runway')) expect(f.geometry.type).toBe('LineString');
    for (const f of kinds('taxiway')) expect(f.geometry.type).toBe('LineString');
    for (const f of kinds('holding_position')) expect(f.geometry.type).toBe('Point');
    for (const f of [...kinds('apron'), ...kinds('hangar'), ...kinds('building'), ...kinds('aerodrome')]) {
      expect(f.geometry.type).toBe('Polygon');
    }
    const runwayRefs = kinds('runway')
      .map((f) => f.properties.ref)
      .sort();
    expect(runwayRefs).toEqual(['05/23', '10/28']);
    // Taxiway letters come from the OSM ref tag.
    expect(kinds('taxiway').filter((f) => typeof f.properties.ref === 'string').length).toBeGreaterThan(10);
    // Coordinates are [lon, lat] and inside the airport.
    const runway = kinds('runway')[0];
    if (runway?.geometry.type !== 'LineString') throw new Error('expected a line');
    for (const [lon, lat] of runway.geometry.coordinates) {
      expect(lon).toBeGreaterThan(-86.96);
      expect(lon).toBeLessThan(-86.92);
      expect(lat).toBeGreaterThan(40.4);
      expect(lat).toBeLessThan(40.42);
    }
  });

  it('finds no tower at KLAF, because OpenStreetMap has none mapped there', () => {
    expect(findTower(layout)).toBeNull();
  });

  it('finds a mapped tower, as a node or as a building outline', () => {
    const node = overpassToLayout(
      {
        elements: [
          { type: 'node', id: 1, lat: 39.71, lon: -86.29, tags: { aeroway: 'tower', height: '104' } },
        ],
      },
      0,
    );
    expect(findTower(node)).toEqual({ lat: 39.71, lon: -86.29, heightM: 104 });

    const square = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 2 },
      { lat: 2, lon: 2 },
      { lat: 2, lon: 0 },
      { lat: 0, lon: 0 },
    ];
    const way = overpassToLayout(
      {
        elements: [
          {
            type: 'way',
            id: 2,
            geometry: square,
            tags: { man_made: 'tower', 'tower:type': 'airport_control', building: 'yes' },
          },
        ],
      },
      0,
    );
    expect(findTower(way)).toEqual({ lat: 1, lon: 1, heightM: null });
  });

  it('assembles multipolygon relations from way fragments, with holes', () => {
    expect(
      assembleRings([
        [
          [0, 0],
          [4, 0],
          [4, 4],
        ],
        [
          [0, 0],
          [0, 4],
          [4, 4],
        ],
      ]),
    ).toHaveLength(1);
    expect(
      assembleRings([
        [
          [0, 0],
          [1, 1],
        ],
      ]),
    ).toEqual([]);

    const g = (points: number[][]) => points.map(([lon, lat]) => ({ lat, lon }));
    const relation = overpassToLayout(
      {
        elements: [
          {
            type: 'relation',
            id: 9,
            tags: { type: 'multipolygon', aeroway: 'apron' },
            members: [
              {
                type: 'way',
                role: 'outer',
                geometry: g([
                  [0, 0],
                  [10, 0],
                  [10, 10],
                ]),
              },
              {
                type: 'way',
                role: 'outer',
                geometry: g([
                  [10, 10],
                  [0, 10],
                  [0, 0],
                ]),
              },
              {
                type: 'way',
                role: 'inner',
                geometry: g([
                  [4, 4],
                  [6, 4],
                  [6, 6],
                  [4, 6],
                  [4, 4],
                ]),
              },
            ],
          },
        ],
      },
      0,
    );
    const apron = relation.features[0];
    expect(apron?.geometry.type).toBe('Polygon');
    if (apron?.geometry.type !== 'Polygon') throw new Error('expected a polygon');
    expect(apron.geometry.coordinates).toHaveLength(2);
    expect(apron.geometry.coordinates[0]).toHaveLength(5);
  });

  describe('store', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'towercab-osm-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('fetches with an identifying User-Agent, caches to /data/osm/{icao}.geojson and tells listeners', async () => {
      const fetchImpl = fakeFetch(upstreamRoutes());
      const store = new LayoutStore({ dataDir: dir, userAgent: UA, fetchImpl });
      const updates: string[] = [];
      store.onUpdate((icao) => updates.push(icao));

      const fetched = await store.refresh('KLAF');
      expect(fetched?.features.length).toBeGreaterThan(70);
      const call = fetchImpl.calls[0];
      expect(call?.url).toBe('https://overpass-api.de/api/interpreter');
      expect(call?.init?.method).toBe('POST');
      expect(sentHeaders(call)['User-Agent']).toBe(UA);
      expect(decodeURIComponent(String(call?.init?.body))).toContain('"icao"="KLAF"');
      expect(updates).toEqual(['KLAF']);

      const onDisk = JSON.parse(await readFile(join(dir, 'osm', 'KLAF.geojson'), 'utf8'));
      expect(onDisk.features).toHaveLength(fetched?.features.length ?? -1);

      // A new process reads the cache and does not ask Overpass again.
      const offline = new LayoutStore({ dataDir: dir, userAgent: UA, fetchImpl: fakeFetch([]) });
      expect((await offline.get('KLAF'))?.features.length).toBe(fetched?.features.length);
    });

    it('backs off and retries when the server is at capacity, as its 502 asks', async () => {
      let attempts = 0;
      const waits: number[] = [];
      const fetchImpl = async () => {
        attempts += 1;
        if (attempts < 3) return new Response('# 502 Gateway Timeout', { status: 502 });
        return new Response(fixtureText('overpass-klaf.json'), { status: 200 });
      };
      const store = new LayoutStore({
        dataDir: dir,
        userAgent: UA,
        fetchImpl,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      expect((await store.refresh('KLAF'))?.features.length).toBeGreaterThan(70);
      expect(attempts).toBe(3);
      expect(waits).toEqual([10_000, 30_000]);
    });

    it('gives up after the last retry and leaves the cached copy in place', async () => {
      const warm = new LayoutStore({ dataDir: dir, userAgent: UA, fetchImpl: fakeFetch(upstreamRoutes()) });
      await warm.refresh('KLAF');
      const down = new LayoutStore({
        dataDir: dir,
        userAgent: UA,
        fetchImpl: async () => new Response('busy', { status: 502 }),
        sleep: async () => {},
      });
      expect(await down.refresh('KLAF')).toBeNull();
      expect((await down.get('KLAF'))?.features.length).toBeGreaterThan(70);
    });

    it('answers at once with what it has and fetches a missing layout in the background', async () => {
      const fetchImpl = fakeFetch(upstreamRoutes());
      const store = new LayoutStore({ dataDir: dir, userAgent: UA, fetchImpl });
      const updated = new Promise<string>((resolve) => store.onUpdate(resolve));
      expect(await store.get('KLAF')).toBeNull();
      expect(await updated).toBe('KLAF');
      expect((await store.get('KLAF'))?.features.length).toBeGreaterThan(70);
      expect(fetchImpl.calls).toHaveLength(1);
    });
  });
});

describe('timeZoneAt', () => {
  // Each of these checked against the US National Weather Service (api.weather.gov/points) on 2026-11-25.
  it.each([
    ['KLAF', 40.412875, -86.939363, 'America/Indiana/Indianapolis'],
    ['KIND', 39.7173, -86.294403, 'America/Indiana/Indianapolis'],
    ['KGYY, in the part of Indiana that goes by Chicago', 41.617087, -87.413206, 'America/Chicago'],
    ['KEVV, in the other such part', 38.0369987488, -87.5324020386, 'America/Chicago'],
    ['KPHX, without summer time', 33.435302, -112.005905, 'America/Phoenix'],
    ['PANC', 61.179004, -149.992561, 'America/Anchorage'],
  ])('%s', (_name, lat, lon, zone) => {
    expect(timeZoneAt(lat, lon)).toBe(zone);
  });

  it('gives a zone that can be used, whatever the position', () => {
    for (let lat = -90; lat <= 90; lat += 15) {
      for (let lon = -180; lon <= 180; lon += 15) expect(isTimeZone(timeZoneAt(lat, lon))).toBe(true);
    }
    expect(timeZoneAt(Number.NaN, 0)).toBe('UTC');
    expect(timeZoneAt(200, 0)).toBe('UTC');
  });

  it('can be overridden in the config, with a name that exists', () => {
    const entry = (timezone: string) => AirportEntrySchema.safeParse({ icao: 'KTEL', timezone });
    expect(entry('America/Indiana/Tell_City').success).toBe(true);
    expect(entry('Central').success).toBe(false);
  });
});

describe('buildAirportInfo', () => {
  const record = {
    ident: 'KLAF',
    type: 'medium_airport',
    name: 'Purdue University Airport',
    lat: 40.412875,
    lon: -86.939363,
    elevationFt: 606,
    municipality: 'West Lafayette',
  };
  const entry = (extra: object = {}) =>
    AirportEntrySchema.parse({ icao: 'KLAF', defaultView: 'tower', ...extra });

  it('needs only the ICAO code: everything else comes from the data', () => {
    const info = buildAirportInfo(entry(), record, [], null);
    expect(info).toMatchObject({
      icao: 'KLAF',
      name: 'Purdue University Airport',
      city: 'West Lafayette',
      lat: 40.412875,
      lon: -86.939363,
      elevationFt: 606,
      radiusNm: 6,
      ceilingFtAgl: 5000,
      defaultView: 'tower',
      timezone: 'America/Indiana/Indianapolis',
      tower: null,
      available: true,
      sources: { airport: 'ourairports', layout: null, layoutFetchedAt: null },
    });
    // 606 ft is 184.7 m above sea level; the ellipsoid is about 34 m higher than the geoid here.
    expect(info?.geoidUndulationM).toBeCloseTo(-34.3, 0);
    expect(info?.elevationEllipsoidM).toBeCloseTo(184.71 + (info?.geoidUndulationM ?? 0), 1);
    expect(info?.links).toEqual(defaultLinks('KLAF'));
  });

  it('lets config override any value', () => {
    const info = buildAirportInfo(
      entry({
        name: 'LAF',
        lat: 40.5,
        elevationFt: 610,
        radiusNm: 9,
        timezone: 'America/Chicago',
        links: { diagram: 'https://example.test/laf.pdf' },
        tower: { lat: 40.41, lon: -86.94, heightM: 18, approximate: false },
      }),
      record,
      [],
      null,
    );
    expect(info).toMatchObject({ name: 'LAF', lat: 40.5, lon: -86.939363, elevationFt: 610, radiusNm: 9 });
    expect(info?.timezone).toBe('America/Chicago');
    expect(info?.tower).toEqual({
      lat: 40.41,
      lon: -86.94,
      heightM: 18,
      approximate: false,
      source: 'config',
    });
    expect(info?.links.diagram).toBe('https://example.test/laf.pdf');
    expect(info?.links.liveatc).toBe('https://www.liveatc.net/search/?icao=KLAF');
  });

  it('works from config alone when the data has no such airport, and not at all without a position', () => {
    expect(
      buildAirportInfo(entry({ lat: 40.4, lon: -86.9, elevationFt: 600 }), undefined, [], null),
    ).toMatchObject({
      name: 'KLAF',
      sources: { airport: 'config' },
    });
    expect(buildAirportInfo(entry(), undefined, [], null)).toBeNull();
  });

  it('takes the tower from OpenStreetMap when config has none, marked approximate, eye level below the roof', () => {
    const layout = overpassToLayout(
      {
        elements: [
          { type: 'node', id: 1, lat: 40.4135, lon: -86.9361, tags: { aeroway: 'tower', height: '24' } },
        ],
      },
      777,
    );
    const info = buildAirportInfo(entry(), record, [], layout);
    expect(info?.tower).toEqual({
      lat: 40.4135,
      lon: -86.9361,
      heightM: 21,
      approximate: true,
      source: 'osm',
    });
    expect(info?.sources).toMatchObject({ layout: 'osm', layoutFetchedAt: 777 });
  });
});

describe('planespotters photos', () => {
  it('reads the answer captured live', () => {
    expect(parsePhotoResponse(fixtureJson('planespotters-a0d5d6.json'))).toEqual({
      thumbnail: 'https://t.plnspttrs.net/11887/1958654_99424f06a6_280.jpg',
      width: 420,
      height: 280,
      link: 'https://www.planespotters.net/photo/1958654/n153fe-fedex-express-boeing-767-3s2f?utm_source=api',
      photographer: 'Ruoyang Yan',
    });
  });

  it('has no photo for an empty answer and refuses non-https links', () => {
    expect(parsePhotoResponse({ photos: [] })).toBeNull();
    expect(parsePhotoResponse({ error: 'x' })).toBeNull();
    expect(
      parsePhotoResponse({
        photos: [
          {
            thumbnail: { src: 'javascript:alert(1)' },
            link: 'https://www.planespotters.net/x',
            photographer: 'x',
          },
        ],
      }),
    ).toBeNull();
  });

  it('asks once per aircraft and remembers the answer, including "no photo"', async () => {
    const fetchImpl = fakeFetch([
      { match: '/hex/a0d5d6', body: fixtureText('planespotters-a0d5d6.json') },
      { match: '/hex/abcdef', body: '{"photos":[]}' },
      { match: '/hex/ffffff', status: 500, body: 'oops' },
    ]);
    const service = new PhotoService({ userAgent: UA, fetchImpl });
    const [a, b] = await Promise.all([service.get('A0D5D6'), service.get('a0d5d6')]);
    expect(a?.photographer).toBe('Ruoyang Yan');
    expect(b).toBe(a);
    expect(await service.get('abcdef')).toBeNull();
    expect(await service.get('abcdef')).toBeNull();
    expect(await service.get('ffffff')).toBeNull();
    expect(await service.get('ffffff')).toBeNull();
    expect(fetchImpl.calls).toHaveLength(3);
    expect(sentHeaders(fetchImpl.calls[0])['User-Agent']).toBe(UA);
  });
});
