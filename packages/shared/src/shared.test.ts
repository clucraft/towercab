import { describe, expect, it } from 'vitest';
import { aircraftLabel, describeAddrType } from './aircraft';
import { KNOWN_TYPE_COUNT, MODEL_CLASSES, resolveAircraftType } from './aircraftTypes';
import { AirportEntrySchema } from './airport';
import { type Runway, rankRunwaysByWind } from './airportInfo';
import { CameraConfigSchema } from './camera';
import { ClientMessageSchema } from './messages';
import { describeWind, hpaToInHg } from './metar';
import { TYPE_ARTICLE_COUNT, typeArticle } from './typeArticles';

describe('articles about aircraft types', () => {
  it('has one for every type the local field sees, whatever the spelling of the designator', () => {
    for (const code of ['C152', 'C172', 'P28A', 'P28R', 'PA44', 'SR22', 'BE58', 'PC12', 'CRJ9', 'B738'])
      expect(typeArticle(code), code).not.toBeNull();
    expect(typeArticle(' p28r ')).toBe('Piper PA-28 Cherokee');
    expect(TYPE_ARTICLE_COUNT).toBeGreaterThan(400);
  });

  it('has none for an unknown type, and is not fooled by the names of object members', () => {
    for (const code of ['ZZZZ', '', null, undefined, 'constructor', '__proto__', 'TOSTRING'])
      expect(typeArticle(code), String(code)).toBeNull();
  });
});

describe('aircraft type table', () => {
  const required = [
    ['C152', 'C172', 'P28A', 'PA44', 'SR22', 'BE58'],
    ['PC12', 'C25B', 'CL30', 'E55P'],
    ['CRJ2', 'CRJ9', 'E75L'],
    ['A319', 'A320', 'A321', 'B737', 'B738', 'B739', 'B38M', 'B752'],
    ['B763', 'B77L', 'MD11', 'A306'],
  ].flat();

  it('covers every type the build prompt asks for, with plausible dimensions', () => {
    for (const code of required) {
      const info = resolveAircraftType(code, null);
      expect(info.matched, code).toBe('type');
      expect(MODEL_CLASSES, code).toContain(info.class);
      expect(info.wingspanM, code).toBeGreaterThan(7);
      expect(info.wingspanM, code).toBeLessThan(80);
      expect(info.lengthM, code).toBeGreaterThan(6);
    }
    expect(KNOWN_TYPE_COUNT).toBeGreaterThan(100);
  });

  it('keeps a Cessna 172 and a FedEx 777 at their real, very different sizes', () => {
    expect(resolveAircraftType('C172', 'A1').wingspanM).toBeCloseTo(11.0, 1);
    expect(resolveAircraftType('B77L', 'A5').wingspanM).toBeCloseTo(64.8, 1);
    expect(resolveAircraftType('MD11', 'A5').class).toBe('widebody-tri');
  });

  it('falls back to the emitter category, then to a generic aircraft', () => {
    expect(resolveAircraftType('ZZZZ', 'A1')).toMatchObject({ class: 'ga-single-low', matched: 'category' });
    expect(resolveAircraftType(null, 'A5')).toMatchObject({ class: 'widebody-twin', matched: 'category' });
    expect(resolveAircraftType(undefined, 'A7')).toMatchObject({ class: 'helicopter', matched: 'category' });
    expect(resolveAircraftType(undefined, 'C2')).toMatchObject({
      class: 'ground-vehicle',
      matched: 'category',
    });
    expect(resolveAircraftType(null, null)).toMatchObject({ class: 'generic', matched: 'generic' });
    expect(resolveAircraftType(' c172 ', null).matched).toBe('type');
  });
});

describe('labels', () => {
  it('prefers callsign, then registration, then hex', () => {
    expect(aircraftLabel({ callsign: 'PDU67', registration: 'N867PU', hex: 'abea30' })).toBe('PDU67');
    expect(aircraftLabel({ registration: 'N867PU', hex: 'abea30' })).toBe('N867PU');
    expect(aircraftLabel({ hex: 'abea30' })).toBe('ABEA30');
  });

  it('names the data link', () => {
    expect(describeAddrType('adsb_icao')).toBe('ADS-B');
    expect(describeAddrType('mlat')).toBe('MLAT');
    expect(describeAddrType('tisb_trackfile')).toBe('TIS-B');
    expect(describeAddrType('adsr_icao')).toContain('ADS-R');
  });
});

describe('config schemas', () => {
  it('normalises the ICAO code and fills airport defaults', () => {
    expect(AirportEntrySchema.parse({ icao: ' kind ' })).toMatchObject({
      icao: 'KIND',
      radiusNm: 6,
      ceilingFtAgl: 5000,
      tower: null,
      defaultView: 'overhead',
    });
    expect(() => AirportEntrySchema.parse({ icao: 'TOOLONG' })).toThrow();
    expect(() => AirportEntrySchema.parse({ icao: 'KLAF', radiusNm: -1 })).toThrow();
  });

  it('marks a hand-entered tower as approximate unless told otherwise', () => {
    const entry = AirportEntrySchema.parse({ icao: 'KLAF', tower: { lat: 40.41, lon: -86.94, heightM: 20 } });
    expect(entry.tower).toEqual({ lat: 40.41, lon: -86.94, heightM: 20, approximate: true });
  });

  it('validates a camera with a pose', () => {
    const camera = CameraConfigSchema.parse({
      id: 'ramp-cam',
      airport: 'klaf',
      name: 'Ramp',
      kind: 'hls',
      source: 'https://cams.example.test/ramp/index.m3u8',
      pose: { lat: 40.41, lon: -86.94, heightM: 12, headingDeg: 135 },
    });
    expect(camera).toMatchObject({ airport: 'KLAF', enabled: true, proxy: false, refreshSeconds: 30 });
    expect(camera.pose).toMatchObject({ pitchDeg: 0, hfovDeg: 60 });
    expect(() => CameraConfigSchema.parse({ ...camera, kind: 'rtsp' })).toThrow();
    expect(() => CameraConfigSchema.parse({ ...camera, id: 'has spaces' })).toThrow();
  });
});

describe('WebSocket client messages', () => {
  it('accepts the three message types and nothing else', () => {
    expect(ClientMessageSchema.parse({ type: 'subscribe', icao: 'klaf' })).toEqual({
      type: 'subscribe',
      icao: 'KLAF',
    });
    expect(ClientMessageSchema.safeParse({ type: 'unsubscribe' }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'pong', t: 1 }).success).toBe(true);
    expect(ClientMessageSchema.safeParse({ type: 'subscribe' }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ type: 'shutdown' }).success).toBe(false);
  });
});

describe('wind', () => {
  const end = (ident: string, headingTrue: number) => ({
    ident,
    headingTrue,
    lat: 0,
    lon: 0,
    elevationFt: 0,
    displacedThresholdFt: 0,
  });
  // KLAF: 05/23 and 10/28, true headings from OurAirports.
  const runways: Runway[] = [
    {
      id: '05/23',
      lengthFt: 4225,
      widthFt: 100,
      surface: 'ASP',
      lighted: true,
      closed: false,
      ends: [end('05', 47.3), end('23', 227.3)],
    },
    {
      id: '10/28',
      lengthFt: 6600,
      widthFt: 150,
      surface: 'ASP',
      lighted: true,
      closed: false,
      ends: [end('10', 100), end('28', 280)],
    },
  ];

  it('ranks runway ends by headwind', () => {
    const ranked = rankRunwaysByWind(runways, 50, 11);
    expect(ranked[0]?.ident).toBe('05');
    expect(ranked[0]?.headwindKt).toBeCloseTo(11, 0);
    expect(ranked[0]?.crosswindKt).toBeLessThan(1);
    expect(ranked[ranked.length - 1]?.ident).toBe('23');
    expect(ranked[ranked.length - 1]?.headwindKt).toBeLessThan(0);
  });

  it('prefers the runway into a westerly wind', () => {
    expect(rankRunwaysByWind(runways, 270, 15)[0]?.ident).toBe('28');
  });

  it('has no opinion in calm or variable wind, and skips closed runways', () => {
    expect(rankRunwaysByWind(runways, 50, 2)).toEqual([]);
    expect(rankRunwaysByWind(runways, null, 10)).toEqual([]);
    const closed = runways.map((r) => (r.id === '05/23' ? { ...r, closed: true } : r));
    expect(rankRunwaysByWind(closed, 50, 11).map((r) => r.ident)).toEqual(['10', '28']);
  });

  it('describes wind the way a pilot reads it', () => {
    expect(describeWind({ windDirDeg: 50, windVariable: false, windSpeedKt: 11, windGustKt: 18 })).toBe(
      '050° at 11 kt, gusting 18',
    );
    expect(describeWind({ windDirDeg: null, windVariable: true, windSpeedKt: 4, windGustKt: null })).toBe(
      'Variable at 4 kt',
    );
    expect(describeWind({ windDirDeg: 0, windVariable: false, windSpeedKt: 0, windGustKt: null })).toBe(
      'Calm',
    );
    expect(hpaToInHg(1032.9)).toBeCloseTo(30.5, 1);
  });
});
