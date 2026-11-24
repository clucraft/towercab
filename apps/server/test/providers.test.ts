import { describe, expect, it } from 'vitest';
import { AGGREGATORS, createAggregatorSource, effectiveMinIntervalMs } from '../src/providers/aggregators';
import { fetchJson, parseRateHeaders, parseRetryAfter } from '../src/providers/http';
import { createOpenSkySource, OPENSKY_TOKEN_URL, parseOpenSkyStates } from '../src/providers/opensky';
import {
  parseReadsbAircraft,
  parseReadsbEnvelope,
  parseReadsbResponse,
  parseReadsbStreamLine,
  resolveDataTime,
} from '../src/providers/readsb';
import { createReadsbLocalSource } from '../src/providers/readsbLocal';
import { ProviderError } from '../src/providers/types';
import { fakeFetch, fixtureJson, fixtureText, sentHeaders } from './helpers';

const UA = 'TowerCab-tests/0 (+https://example.test)';

describe('readsb parser against live fixtures', () => {
  const v2Style = [
    'adsblol-v2-kind.json',
    'adsblol-v2-klaf.json',
    'adsbfi-v3-kind.json',
    'adsbfi-v3-klaf.json',
  ];

  it.each(v2Style)('%s uses the `ac` envelope with `now` in milliseconds', (name) => {
    const json = fixtureJson(name) as { ac: unknown[]; now: number; total: number };
    const envelope = parseReadsbEnvelope(json);
    expect(envelope.aircraft).toHaveLength(json.total);
    expect(envelope.nowMs).toBe(json.now);
    expect(envelope.nowMs).toBeGreaterThan(1.7e12);
  });

  it("adsb.fi's deprecated v2 point endpoint uses `aircraft` with `now` in seconds", () => {
    const json = fixtureJson('adsbfi-v2-legacy-kind.json') as { aircraft: unknown[]; now: number };
    const envelope = parseReadsbEnvelope(json);
    expect(envelope.aircraft).toHaveLength(json.aircraft.length);
    expect(envelope.nowMs).toBe(Math.round(json.now * 1000));
  });

  it('one parser handles every provider: all aircraft with a position come out the same shape', () => {
    for (const name of [...v2Style, 'adsbfi-v2-legacy-kind.json']) {
      const json = fixtureJson(name) as {
        ac?: { lat?: number }[];
        aircraft?: { lat?: number }[];
        now: number;
      };
      const withPosition = (json.ac ?? json.aircraft ?? []).filter((a) => typeof a.lat === 'number').length;
      const receivedAt = (json.now < 1e11 ? json.now * 1000 : json.now) + 150;
      const observations = parseReadsbResponse(json, receivedAt, 'adsbfi');
      expect(observations, name).toHaveLength(withPosition);
      for (const o of observations) {
        expect(o.hex, name).toMatch(/^~?[0-9a-f]{6}$/);
        expect(o.posTime, name).toBeLessThanOrEqual(receivedAt);
        expect(o.posTime, name).toBeGreaterThan(receivedAt - 61_000);
        // Hearing a position is hearing a message: the last message is never older than the position.
        expect(o.seenTime, name).toBeGreaterThanOrEqual(o.posTime);
      }
    }
  });

  it('reads a Purdue Piper taxiing at KLAF: alt_baro is the string "ground", true heading is sent', () => {
    const json = fixtureJson('adsbfi-v3-klaf.json') as { now: number };
    const pdu67 = parseReadsbResponse(json, json.now + 100, 'adsbfi').find((o) => o.hex === 'abea30');
    expect(pdu67).toMatchObject({
      callsign: 'PDU67',
      registration: 'N867PU',
      typeCode: 'P28A',
      category: 'A1',
      addrType: 'adsb_icao',
      altBaro: 'ground',
      altGeomFt: null,
      gsKt: 8.2,
      trackDeg: null,
      trueHeadingDeg: 11.25,
      source: 'adsbfi',
    });
    // seen_pos was 0.111 s.
    expect(pdu67?.posTime).toBe(json.now - 111);
  });

  it('reads an airborne FedEx 767 with both altitudes and the selected altimeter setting', () => {
    const json = fixtureJson('adsblol-v2-kind.json') as { now: number };
    const fdx = parseReadsbResponse(json, json.now + 50, 'adsblol').find((o) => o.hex === 'a0d5d6');
    expect(fdx).toMatchObject({
      callsign: 'FDX3604',
      typeCode: 'B763',
      altBaro: 4675,
      altGeomFt: 4925,
      baroRateFpm: -1600,
      squawk: '4055',
      navQnhHpa: 1032.8,
      source: 'adsblol',
    });
    // "emergency": "none" is the normal state and is not carried.
    expect(fdx?.emergency).toBeUndefined();
  });

  it('carries operator and type description where a provider adds them', () => {
    const json = fixtureJson('adsbfi-v2-legacy-kind.json') as { now: number };
    const fdx = parseReadsbResponse(json, json.now * 1000 + 50, 'adsbfi').find((o) => o.hex === 'a0d5d6');
    expect(fdx).toMatchObject({ operator: 'FEDERAL EXPRESS CORP', typeDesc: 'BOEING 767-300' });
  });
});

describe('readsb parser edge cases', () => {
  const now = 1_700_000_000_000;

  it('skips aircraft without an address or a current position', () => {
    expect(parseReadsbAircraft({ hex: 'abc123' }, now, 'readsb')).toBeNull();
    expect(parseReadsbAircraft({ hex: 'abc123', lat: 40, lon: null }, now, 'readsb')).toBeNull();
    expect(parseReadsbAircraft({ hex: 'nothex', lat: 40, lon: -86 }, now, 'readsb')).toBeNull();
    expect(parseReadsbAircraft({ hex: 'abc123', lat: 95, lon: -86 }, now, 'readsb')).toBeNull();
    // readsb moves positions older than 60 s out of lat/lon.
    expect(
      parseReadsbAircraft(
        { hex: 'abc123', lastPosition: { lat: 40, lon: -86, seen_pos: 70 } },
        now,
        'readsb',
      ),
    ).toBeNull();
    expect(parseReadsbAircraft('not an object', now, 'readsb')).toBeNull();
  });

  it('keeps the ~ prefix of non-ICAO addresses and lower-cases the rest', () => {
    const o = parseReadsbAircraft({ hex: '~2A1B3C', type: 'tisb_other', lat: 40, lon: -86 }, now, 'readsb');
    expect(o).toMatchObject({ hex: '~2a1b3c', addrType: 'tisb_other' });
  });

  it('tolerates junk in optional fields', () => {
    const o = parseReadsbAircraft(
      {
        hex: 'abc123',
        lat: 40,
        lon: -86,
        alt_baro: 'weird',
        gs: -5,
        track: 400,
        flight: '        ',
        seen_pos: 'x',
        seen: 3,
      },
      now,
      'readsb',
    );
    expect(o).toMatchObject({ altBaro: null, gsKt: null, trackDeg: null });
    expect(o?.callsign).toBeUndefined();
    // No usable seen_pos: fall back to `seen`.
    expect(o?.posTime).toBe(now - 3000);
  });

  it('rejects a body that is not a readsb document', () => {
    expect(() => parseReadsbEnvelope({ error: 'nope' })).toThrow(ProviderError);
    expect(() => parseReadsbEnvelope('nope')).toThrow(ProviderError);
    expect(parseReadsbEnvelope({ ac: null, now: 1 }).aircraft).toEqual([]);
  });

  it("uses the service's own clock only while it agrees with ours", () => {
    expect(resolveDataTime(now - 400, now)).toBe(now - 400);
    // Service clock ahead of ours: positions must not land in our future.
    expect(resolveDataTime(now + 3000, now)).toBe(now);
    // Far behind: a stale cache or a wrong clock. Use our receive time.
    expect(resolveDataTime(now - 60_000, now)).toBe(now);
    expect(resolveDataTime(null, now)).toBe(now);
  });

  it('parses a line of the JSON position stream, which carries its own `now` in seconds', () => {
    const line = JSON.stringify({
      now: now / 1000 - 0.2,
      hex: 'abc123',
      type: 'adsb_icao',
      lat: 40.4,
      lon: -86.9,
      alt_baro: 900,
      seen_pos: 0,
    });
    expect(parseReadsbStreamLine(line, now, 'readsb')).toMatchObject({
      hex: 'abc123',
      posTime: now - 200,
      altBaro: 900,
    });
    expect(parseReadsbStreamLine('', now, 'readsb')).toBeNull();
    expect(parseReadsbStreamLine('{broken', now, 'readsb')).toBeNull();
  });
});

describe('HTTP helper', () => {
  it('reads the quota headers adsb.lol sends', () => {
    const headers = new Headers({
      'x-ratelimit-limit': '500, 500;w=86400',
      'x-ratelimit-remaining': '499',
      'x-ratelimit-reset': '20760',
    });
    expect(parseRateHeaders(headers, 1000)).toEqual({
      limit: 500,
      remaining: 499,
      resetAt: 1000 + 20_760_000,
    });
  });

  it("reads OpenSky's single header, and nothing when there is none", () => {
    expect(parseRateHeaders(new Headers({ 'X-Rate-Limit-Remaining': '399' }), 0)).toEqual({ remaining: 399 });
    expect(parseRateHeaders(new Headers(), 0)).toBeUndefined();
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '120' }), 0)).toBe(120_000);
    const at = Date.UTC(2026, 10, 24, 18, 0, 0);
    expect(parseRetryAfter(new Headers({ 'retry-after': new Date(at + 30_000).toUTCString() }), at)).toBe(
      30_000,
    );
    expect(parseRetryAfter(new Headers({ 'x-rate-limit-retry-after-seconds': '45' }), 0)).toBe(45_000);
    expect(parseRetryAfter(new Headers(), 0)).toBeUndefined();
  });

  it('turns each kind of failure into a ProviderError the backoff can act on', async () => {
    const cases: [number, string][] = [
      [429, 'rate_limited'],
      [403, 'forbidden'],
      [401, 'forbidden'],
      [404, 'bad_request'],
      [502, 'server'],
    ];
    for (const [status, kind] of cases) {
      const fetchImpl = fakeFetch([
        { match: 'x', status, body: '{"error":"no"}', headers: { 'retry-after': '7' } },
      ]);
      await expect(fetchJson({ url: 'https://x.test/', userAgent: UA, fetchImpl })).rejects.toMatchObject({
        kind,
        details: { status, retryAfterMs: 7000 },
      });
    }
    const broken = fakeFetch([{ match: 'x', body: '<html>not json' }]);
    await expect(
      fetchJson({ url: 'https://x.test/', userAgent: UA, fetchImpl: broken }),
    ).rejects.toMatchObject({ kind: 'parse' });
    const down = async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    };
    await expect(fetchJson({ url: 'https://x.test/', userAgent: UA, fetchImpl: down })).rejects.toMatchObject(
      {
        kind: 'network',
        message: 'ECONNREFUSED',
      },
    );
  });

  it('sends the identifying User-Agent', async () => {
    const fetchImpl = fakeFetch([{ match: 'x', body: '{}' }]);
    await fetchJson({ url: 'https://x.test/', userAgent: UA, fetchImpl });
    expect(sentHeaders(fetchImpl.calls[0])['User-Agent']).toBe(UA);
  });
});

describe('aggregator adapters', () => {
  it('build the URLs that were verified live', async () => {
    const fetchImpl = fakeFetch([{ match: 'http', body: '{"ac":[],"now":1795544190001}' }]);
    for (const id of ['adsblol', 'adsbfi', 'airplaneslive'] as const) {
      await createAggregatorSource(AGGREGATORS[id], { userAgent: UA, fetchImpl }).fetchArea(
        40.412875,
        -86.939363,
        6,
      );
    }
    expect(fetchImpl.calls.map((c) => c.url)).toEqual([
      'https://api.adsb.lol/v2/lat/40.4129/lon/-86.9394/dist/6',
      'https://opendata.adsb.fi/api/v3/lat/40.4129/lon/-86.9394/dist/6',
      'https://api.airplanes.live/v2/point/40.4129/-86.9394/6',
    ]);
  });

  it('round the radius up and cap it at the 250 NM the APIs allow', async () => {
    const fetchImpl = fakeFetch([{ match: 'http', body: '{"ac":[]}' }]);
    const source = createAggregatorSource(AGGREGATORS.adsbfi, { userAgent: UA, fetchImpl });
    await source.fetchArea(40, -86, 6.2);
    await source.fetchArea(40, -86, 900);
    expect(fetchImpl.calls[0]?.url).toMatch(/dist\/7$/);
    expect(fetchImpl.calls[1]?.url).toMatch(/dist\/250$/);
  });

  it('send an adsb.lol key as x-api-key and report the quota from the answer', async () => {
    const fetchImpl = fakeFetch([
      {
        match: 'adsb.lol',
        body: fixtureText('adsblol-v2-klaf.json'),
        headers: { 'x-ratelimit-remaining': '7100', 'x-ratelimit-limit': '7200' },
      },
    ]);
    const source = createAggregatorSource(AGGREGATORS.adsblol, {
      userAgent: UA,
      fetchImpl,
      apiKey: 'test-key',
    });
    const result = await source.fetchArea(40.41, -86.94, 6);
    expect(sentHeaders(fetchImpl.calls[0])['x-api-key']).toBe('test-key');
    expect(result.rate).toMatchObject({ remaining: 7100, limit: 7200 });
    expect(result.observations).toHaveLength(5);
  });

  it("surface airplanes.live's refusal as `forbidden`, with its message", async () => {
    const fetchImpl = fakeFetch([
      { match: 'airplanes.live', status: 403, body: fixtureText('airplaneslive-403.json') },
    ]);
    const source = createAggregatorSource(AGGREGATORS.airplaneslive, { userAgent: UA, fetchImpl });
    await expect(source.fetchArea(40, -86, 6)).rejects.toMatchObject({
      kind: 'forbidden',
      message: expect.stringContaining('contact@airplanes.live'),
    });
  });
});

describe('request spacing from config', () => {
  it('uses the built-in gap when config says nothing', () => {
    expect(effectiveMinIntervalMs(AGGREGATORS.adsbfi, undefined)).toBe(1100);
    expect(effectiveMinIntervalMs(AGGREGATORS.adsblol, undefined)).toBe(10_000);
  });

  it('lets config slow a source down as far as it likes', () => {
    expect(effectiveMinIntervalMs(AGGREGATORS.adsbfi, 5000)).toBe(5000);
    expect(effectiveMinIntervalMs(AGGREGATORS.adsblol, 60_000)).toBe(60_000);
  });

  it('never lets config undercut a published limit or a floor', () => {
    // adsb.fi publishes one request per second: the built-in gap is the floor.
    expect(effectiveMinIntervalMs(AGGREGATORS.adsbfi, 250)).toBe(1100);
    expect(effectiveMinIntervalMs(AGGREGATORS.airplaneslive, 250)).toBe(1100);
    // adsb.lol's built-in gap is a cautious default; it can be lowered, but only to its floor.
    expect(effectiveMinIntervalMs(AGGREGATORS.adsblol, 5000)).toBe(5000);
    expect(effectiveMinIntervalMs(AGGREGATORS.adsblol, 250)).toBe(3000);
  });
});

describe('local readsb receiver', () => {
  it('reads aircraft.json and keeps only what is inside the radius', async () => {
    // A receiver hears a wide area; this body has the KLAF traffic plus one aircraft far away.
    const klaf = fixtureJson('adsbfi-v3-klaf.json') as { ac: Record<string, unknown>[]; now: number };
    const body = JSON.stringify({
      now: klaf.now / 1000,
      messages: 123456,
      aircraft: [...klaf.ac, { hex: 'aaaaaa', lat: 41.97, lon: -87.9, alt_baro: 30000, seen_pos: 1 }],
    });
    const fetchImpl = fakeFetch([{ match: 'ultrafeeder', body }]);
    const source = createReadsbLocalSource({
      url: 'http://ultrafeeder/data/aircraft.json',
      userAgent: UA,
      fetchImpl,
      now: () => klaf.now + 100,
    });
    const result = await source.fetchArea(40.412875, -86.939363, 6);
    expect(result.observations.map((o) => o.hex)).not.toContain('aaaaaa');
    expect(result.observations.length).toBeGreaterThan(0);
    expect(result.observations.every((o) => o.source === 'readsb')).toBe(true);
  });
});

describe('OpenSky adapter', () => {
  it('converts the state vectors captured at KIND to common units', () => {
    const json = fixtureJson('opensky-states-kind.json') as { states: unknown[][] };
    const observations = parseOpenSkyStates(json);
    expect(observations.length).toBe(
      json.states.filter((s) => s[5] != null && s[6] != null && s[3] != null).length,
    );
    const allegiant = observations.find((o) => o.hex === 'a1be79');
    expect(allegiant).toMatchObject({
      callsign: 'AAY9295',
      source: 'opensky',
      addrType: 'adsb_icao',
      squawk: '4220',
    });
    // 403.86 m baro, 525.78 m geometric, 79.31 m/s, -3.58 m/s.
    expect(allegiant?.altBaro).toBeCloseTo(1325, 0);
    expect(allegiant?.altGeomFt).toBeCloseTo(1725, 0);
    expect(allegiant?.gsKt).toBeCloseTo(154.2, 0);
    expect(allegiant?.baroRateFpm).toBeCloseTo(-705, 0);
    expect(allegiant?.posTime).toBe(1795544214000);
  });

  it('treats on_ground as the ground flag and an empty box as no aircraft', () => {
    const state = [
      'abc123',
      'TEST1   ',
      'United States',
      1795544214,
      1795544214,
      -86.29,
      39.71,
      null,
      true,
      3.1,
      90,
      null,
      null,
      null,
      null,
      false,
      0,
    ];
    expect(parseOpenSkyStates({ time: 1, states: [state] })[0]).toMatchObject({
      altBaro: 'ground',
      altGeomFt: null,
    });
    expect(parseOpenSkyStates({ time: 1, states: null })).toEqual([]);
    expect(() => parseOpenSkyStates({ time: 1, states: 'x' })).toThrow(ProviderError);
  });

  it('asks for a bounding box around the airport, anonymously when there are no credentials', async () => {
    const fetchImpl = fakeFetch([
      {
        match: 'states/all',
        body: fixtureText('opensky-states-kind.json'),
        headers: { 'X-Rate-Limit-Remaining': '399' },
      },
    ]);
    const source = createOpenSkySource({ userAgent: UA, fetchImpl });
    const result = await source.fetchArea(39.7173, -86.2944, 8);
    const url = new URL(fetchImpl.calls[0]?.url as string);
    expect(url.origin + url.pathname).toBe('https://opensky-network.org/api/states/all');
    expect(Number(url.searchParams.get('lamax')) - Number(url.searchParams.get('lamin'))).toBeCloseTo(
      16 / 60,
      3,
    );
    expect(sentHeaders(fetchImpl.calls[0]).Authorization).toBeUndefined();
    expect(result.rate).toEqual({ remaining: 399 });
    // The box is square; aircraft in its corners are outside the 8 NM circle and are dropped.
    expect(result.observations.length).toBeLessThanOrEqual(
      (fixtureJson('opensky-states-kind.json') as { states: unknown[] }).states.length,
    );
  });

  it('gets an OAuth2 token with client credentials, reuses it, and renews it after a 401', async () => {
    let tokens = 0;
    let rejectNext = false;
    const fetchImpl = fakeFetch([]);
    const impl = async (url: string, init?: RequestInit) => {
      fetchImpl.calls.push({ url, init, at: Date.now() });
      if (url === OPENSKY_TOKEN_URL) {
        tokens += 1;
        return Response.json({ access_token: `token-${tokens}`, expires_in: 1800 });
      }
      if (rejectNext) {
        rejectNext = false;
        return new Response('{}', { status: 401 });
      }
      return Response.json({ time: 1, states: null });
    };
    const source = createOpenSkySource({
      userAgent: UA,
      fetchImpl: impl,
      clientId: 'id',
      clientSecret: 'secret',
    });

    await source.fetchArea(39.7, -86.3, 8);
    await source.fetchArea(39.7, -86.3, 8);
    expect(tokens).toBe(1);
    const tokenCall = fetchImpl.calls.find((c) => c.url === OPENSKY_TOKEN_URL);
    expect(tokenCall?.init?.method).toBe('POST');
    expect(String(tokenCall?.init?.body)).toBe(
      'grant_type=client_credentials&client_id=id&client_secret=secret',
    );
    const auth = (i: number) => sentHeaders(fetchImpl.calls[i]).Authorization;
    expect(auth(1)).toBe('Bearer token-1');

    rejectNext = true;
    await source.fetchArea(39.7, -86.3, 8);
    expect(tokens).toBe(2);
    expect(auth(fetchImpl.calls.length - 1)).toBe('Bearer token-2');
  });
});
