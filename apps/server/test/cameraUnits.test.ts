import { parseYouTubeSource } from '@towercab/shared';
import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  parseWindyWebcams,
  parseYouTubeSearch,
  searchWindy,
  searchYouTube,
  WINDY_ATTRIBUTION,
  WindyImages,
  youtubeQueries,
} from '../src/cameras/discovery';
import { DiscoveryService } from '../src/cameras/discoveryService';
import { FrameChecker, framingBlocked } from '../src/cameras/frameCheck';
import { CameraStore, type DiscoveryResult } from '../src/cameras/store';
import { ConfigFileSchema } from '../src/config/schema';
import { ProviderError } from '../src/providers/types';
import { fakeFetch, fixtureJson, fixtureText, sentHeaders } from './helpers';

const KLAF = {
  icao: 'KLAF',
  name: 'Purdue University Airport',
  city: 'Lafayette',
  lat: 40.4123,
  lon: -86.9369,
};
const UA = 'TowerCab-test/0 (+https://example.test)';

const result = (id: string, extra: Partial<DiscoveryResult> = {}): DiscoveryResult => ({
  id,
  airport: 'KLAF',
  provider: 'youtube',
  externalId: id.replace(/^yt-/, ''),
  name: `Camera ${id}`,
  kind: 'youtube',
  source: id.replace(/^yt-/, ''),
  link: `https://video.example.test/${id}`,
  ...extra,
});

describe('YouTube source', () => {
  it('reads ids and the usual addresses', () => {
    const video = { type: 'video', videoId: 'AAAAAAAAAAA' };
    const channel = { type: 'channel', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' };
    expect(parseYouTubeSource('AAAAAAAAAAA')).toEqual(video);
    expect(parseYouTubeSource(' AAAAAAAAAAA ')).toEqual(video);
    expect(parseYouTubeSource('https://www.youtube.com/watch?v=AAAAAAAAAAA&t=10s')).toEqual(video);
    expect(parseYouTubeSource('https://youtu.be/AAAAAAAAAAA?si=x')).toEqual(video);
    expect(parseYouTubeSource('https://www.youtube.com/live/AAAAAAAAAAA')).toEqual(video);
    expect(parseYouTubeSource('https://www.youtube.com/embed/AAAAAAAAAAA')).toEqual(video);
    expect(parseYouTubeSource('https://m.youtube.com/watch?v=AAAAAAAAAAA')).toEqual(video);
    expect(parseYouTubeSource('channel:UCaaaaaaaaaaaaaaaaaaaaaa')).toEqual(channel);
    expect(parseYouTubeSource('UCaaaaaaaaaaaaaaaaaaaaaa')).toEqual(channel);
    expect(parseYouTubeSource('https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa/live')).toEqual(
      channel,
    );
    expect(
      parseYouTubeSource('https://www.youtube.com/embed/live_stream?channel=UCaaaaaaaaaaaaaaaaaaaaaa'),
    ).toEqual(channel);
  });

  it('refuses what it cannot be sure about', () => {
    for (const bad of [
      '',
      'short',
      'https://www.youtube.com/@somehandle/live',
      'https://www.youtube.com/watch?v=tooshort',
      'https://evil.test/watch?v=AAAAAAAAAAA',
      'https://youtube.com.evil.test/watch?v=AAAAAAAAAAA',
      'javascript:alert(1)',
      'channel:notachannelid',
    ]) {
      expect(parseYouTubeSource(bad), bad).toBeNull();
    }
  });
});

describe('camera entries in the config file', () => {
  const base = { airports: [{ icao: 'KLAF' }] };
  const check = (extra: object) => ConfigFileSchema.safeParse({ ...base, ...extra });
  const messages = (extra: object) => check(extra).error?.issues.map((i) => i.message) ?? [];
  const cam = (extra: object) => ({ id: 'c1', airport: 'KLAF', name: 'Cam', ...extra });

  it('accepts each kind with a source that fits it', () => {
    const parsed = check({
      proxy: { allowlist: ['cams.example.test', '192.168.1.20:8080'] },
      cameras: [
        cam({ id: 'a', kind: 'youtube', source: 'https://youtu.be/AAAAAAAAAAA' }),
        cam({ id: 'b', kind: 'hls', source: 'https://open.example.test/live.m3u8' }),
        cam({ id: 'c', kind: 'hls', source: 'https://cams.example.test/live.m3u8', proxy: true }),
        cam({ id: 'd', kind: 'mjpeg', source: 'http://user:pw@192.168.1.20:8080/video', proxy: true }),
        cam({ id: 'e', kind: 'snapshot', source: 'windy:1234567890' }),
        cam({ id: 'f', kind: 'iframe', source: 'https://page.example.test/cam' }),
        cam({ id: 'g', kind: 'webrtc', source: 'ramp_cam-1' }),
      ],
    });
    expect(parsed.error?.issues).toBeUndefined();
  });

  it('says what is wrong with a source', () => {
    expect(
      messages({ cameras: [cam({ kind: 'youtube', source: 'https://www.youtube.com/@handle' })] })[0],
    ).toMatch(/youtube source is the video id of the live stream/);
    // A channel is understood, and refused with the way to do it instead.
    expect(
      messages({ cameras: [cam({ kind: 'youtube', source: 'channel:UCaaaaaaaaaaaaaaaaaaaaaa' })] })[0],
    ).toMatch(/a channel cannot be played, only a video/);
    expect(messages({ cameras: [cam({ kind: 'hls', source: 'rtsp://cam/stream' })] })[0]).toMatch(
      /must be an http or https address/,
    );
    expect(messages({ cameras: [cam({ kind: 'webrtc', source: 'rtsp://cam/stream' })] })[0]).toMatch(
      /name of a go2rtc stream/,
    );
    expect(
      messages({ cameras: [cam({ kind: 'iframe', source: 'https://x.example.test/', proxy: true })] })[0],
    ).toMatch(/iframe camera cannot be proxied/);
  });

  it('refuses a proxied camera whose host is not on the allowlist', () => {
    const issue = messages({
      proxy: { allowlist: ['other.example.test'] },
      cameras: [cam({ kind: 'hls', source: 'https://cams.example.test/live.m3u8', proxy: true })],
    })[0];
    expect(issue).toBe('camera c1 is proxied, but cams.example.test is not on proxy.allowlist');
  });

  it('refuses to hand an address with a password to browsers', () => {
    const issue = messages({
      cameras: [cam({ kind: 'mjpeg', source: 'http://admin:secret@cam.example.test/v' })],
    })[0];
    expect(issue).toMatch(/contains a user name or password; set "proxy: true"/);
    expect(issue).not.toContain('secret');
  });

  it('refuses a malformed allowlist entry, naming it', () => {
    expect(messages({ proxy: { allowlist: ['https://cams.example.test/'] } })[0]).toMatch(
      /"https:\/\/cams.example.test\/" is not a valid allowlist entry/,
    );
  });
});

describe('camera queue', () => {
  it('keeps new finds pending and does not undo a decision when a camera is found again', () => {
    const store = new CameraStore(':memory:');
    expect(store.recordResults([result('yt-AAAAAAAAAAA'), result('yt-BBBBBBBBBBB')], 1000)).toEqual({
      added: 2,
      seenAgain: 0,
    });
    expect(store.list().map((c) => [c.id, c.status, c.enabled])).toEqual([
      ['yt-AAAAAAAAAAA', 'pending', true],
      ['yt-BBBBBBBBBBB', 'pending', true],
    ]);

    expect(store.update('yt-AAAAAAAAAAA', { status: 'approved', name: 'Ramp, looking north' })).toBe(true);
    expect(store.update('yt-BBBBBBBBBBB', { status: 'rejected' })).toBe(true);
    expect(store.update('yt-nope', { status: 'approved' })).toBe(false);

    // The same two turn up in a later search, one with a new thumbnail, plus a new one.
    const again = store.recordResults(
      [
        result('yt-AAAAAAAAAAA', {
          name: 'Whatever the title is now',
          thumbnail: 'https://thumbs.example.test/new.jpg',
        }),
        result('yt-BBBBBBBBBBB'),
        result('yt-CCCCCCCCCCC'),
      ],
      5000,
    );
    expect(again).toEqual({ added: 1, seenAgain: 2 });
    const a = store.get('yt-AAAAAAAAAAA');
    expect(a).toMatchObject({
      status: 'approved',
      name: 'Ramp, looking north',
      thumbnail: 'https://thumbs.example.test/new.jpg',
      foundAt: 1000,
      lastSeenAt: 5000,
    });
    expect(store.get('yt-BBBBBBBBBBB')?.status).toBe('rejected');
    expect(store.list({ status: 'pending' }).map((c) => c.id)).toEqual(['yt-CCCCCCCCCCC']);
    expect(store.list({ airport: 'KIND' })).toEqual([]);
    store.close();
  });

  it('stores poses, validates them on the way out, and removes them', () => {
    const store = new CameraStore(':memory:');
    const pose = { lat: 40.41, lon: -86.93, heightM: 12, headingDeg: 230, pitchDeg: -4, hfovDeg: 55 };
    store.setPose('ramp', pose, 1);
    store.setPose('ramp', { ...pose, headingDeg: 240 }, 2);
    expect(store.poses().get('ramp')).toEqual({ ...pose, headingDeg: 240 });
    store.setPose('ramp', null, 3);
    expect(store.poses().size).toBe(0);
    store.close();
  });

  it('remembers the last run per airport and provider', () => {
    const store = new CameraStore(':memory:');
    store.recordRun({ airport: 'KLAF', provider: 'youtube', ranAt: 10, ok: true, found: 3 });
    store.recordRun({
      airport: 'KLAF',
      provider: 'youtube',
      ranAt: 20,
      ok: false,
      found: 0,
      message: 'quota',
    });
    store.recordRun({ airport: 'KLAF', provider: 'windy', ranAt: 15, ok: true, found: 1 });
    expect(store.lastRun('KLAF', 'youtube')).toEqual({
      airport: 'KLAF',
      provider: 'youtube',
      ranAt: 20,
      ok: false,
      found: 0,
      message: 'quota',
    });
    expect(store.lastRun('KIND', 'youtube')).toBeNull();
    expect(store.runs()).toHaveLength(2);
    store.close();
  });
});

describe('YouTube discovery', () => {
  it('keeps live videos only, and cleans up the titles', () => {
    const found = parseYouTubeSearch(
      fixtureJson('documented/youtube-search.json'),
      'KLAF',
      'live near the airport',
    );
    expect(found.map((c) => c.id)).toEqual(['yt-AAAAAAAAAAA', 'yt-BBBBBBBBBBB']);
    expect(found[0]).toMatchObject({
      airport: 'KLAF',
      provider: 'youtube',
      externalId: 'AAAAAAAAAAA',
      name: "Example Field & Tower Cam 'LIVE' 24/7",
      kind: 'youtube',
      source: 'AAAAAAAAAAA',
      attribution: 'Example Spotters on YouTube',
      link: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
      thumbnail: 'https://thumbs.example.test/AAAAAAAAAAA/medium.jpg',
      detail: { channel: 'Example Spotters', foundBy: 'live near the airport' },
    });
    expect(found[1]?.thumbnail).toBe('https://thumbs.example.test/BBBBBBBBBBB/default.jpg');
  });

  it('copes with an empty or unexpected answer', () => {
    expect(parseYouTubeSearch({}, 'KLAF', 'x')).toEqual([]);
    expect(
      parseYouTubeSearch({ items: [{}, { id: {} }, { id: { videoId: 'bad id' } }] }, 'KLAF', 'x'),
    ).toEqual([]);
    expect(() => parseYouTubeSearch({ items: 'nope' }, 'KLAF', 'x')).toThrow();
  });

  it('decodes the entities search results come with', () => {
    expect(decodeEntities('A &amp; B &#39;live&#39; &quot;4K&quot; &lt;3 &#x2708;')).toBe(
      'A & B \'live\' "4K" <3 ✈',
    );
  });

  it('runs one search by location and three by keyword, with the key in a header', async () => {
    const fetchImpl = fakeFetch([
      { match: 'googleapis.com/youtube/v3/search', body: fixtureText('documented/youtube-search.json') },
    ]);
    const found = await searchYouTube(KLAF, { apiKey: 'test-key', radiusKm: 10, userAgent: UA, fetchImpl });
    // The same two videos came back from every search; they are listed once.
    expect(found.map((c) => c.id)).toEqual(['yt-AAAAAAAAAAA', 'yt-BBBBBBBBBBB']);
    expect(found[0]?.detail?.foundBy).toBe('live near the airport');

    expect(fetchImpl.calls).toHaveLength(youtubeQueries(KLAF).length);
    expect(fetchImpl.calls).toHaveLength(4);
    const urls = fetchImpl.calls.map((c) => new URL(c.url));
    for (const url of urls) {
      expect(url.searchParams.get('type')).toBe('video');
      expect(url.searchParams.get('eventType')).toBe('live');
      expect(url.searchParams.get('part')).toBe('snippet');
      // The key is never part of the address.
      expect(url.search).not.toContain('test-key');
      expect(url.searchParams.has('key')).toBe(false);
    }
    expect(sentHeaders(fetchImpl.calls[0])['X-Goog-Api-Key']).toBe('test-key');
    expect(urls[0]?.searchParams.get('location')).toBe('40.41230,-86.93690');
    expect(urls[0]?.searchParams.get('locationRadius')).toBe('10km');
    expect(urls[0]?.searchParams.has('q')).toBe(false);
    expect(urls.slice(1).map((u) => u.searchParams.get('q'))).toEqual([
      'KLAF live',
      'Lafayette airport live',
      'plane spotting Lafayette',
    ]);
    expect(urls[1]?.searchParams.has('location')).toBe(false);
  });

  it('reports what Google says when the key is wrong (real response)', async () => {
    const fetchImpl = fakeFetch([
      { match: 'googleapis.com', status: 400, body: fixtureText('youtube-error-invalid-key.json') },
    ]);
    const attempt = searchYouTube(KLAF, { apiKey: 'wrong', radiusKm: 10, userAgent: UA, fetchImpl });
    await expect(attempt).rejects.toBeInstanceOf(ProviderError);
    await expect(attempt).rejects.toThrow('HTTP 400: API key not valid. Please pass a valid API key.');
    // It stops at the first refusal instead of spending three more calls.
    expect(fetchImpl.calls).toHaveLength(1);
  });
});

describe('Windy discovery', () => {
  it('keeps active webcams that have a page to link to', () => {
    const found = parseWindyWebcams(fixtureJson('documented/windy-webcams.json'), KLAF);
    expect(found.map((c) => c.id)).toEqual(['windy-1234567890', 'windy-1234567893']);
    expect(found[0]).toMatchObject({
      provider: 'windy',
      externalId: '1234567890',
      name: 'Example Town: Airport Road',
      kind: 'snapshot',
      source: 'windy:1234567890',
      attribution: WINDY_ATTRIBUTION,
      link: 'https://windy.example.test/webcams/1234567890',
    });
    // 40.43 N, 86.91 W is about 3 km from the field.
    expect(found[0]?.detail?.distanceKm).toBeGreaterThan(2.5);
    expect(found[0]?.detail?.distanceKm).toBeLessThan(3.5);
    // Image addresses expire, so none is stored with the queue entry.
    expect(found[0]?.thumbnail).toBeUndefined();
  });

  it('asks for webcams near the airport with the key in the documented header', async () => {
    const fetchImpl = fakeFetch([
      { match: 'api.windy.com/webcams/api/v3/webcams', body: fixtureText('documented/windy-webcams.json') },
    ]);
    const found = await searchWindy(KLAF, { apiKey: 'windy-key', radiusKm: 15, userAgent: UA, fetchImpl });
    expect(found).toHaveLength(2);
    const url = new URL(fetchImpl.calls[0]?.url ?? '');
    expect(url.pathname).toBe('/webcams/api/v3/webcams');
    expect(url.searchParams.get('nearby')).toBe('40.4123,-86.9369,15');
    expect(url.searchParams.get('include')).toBe('images,location,urls');
    expect(url.search).not.toContain('windy-key');
    expect(sentHeaders(fetchImpl.calls[0])['x-windy-api-key']).toBe('windy-key');
  });

  it('reports what Windy says when the key is wrong (real response)', async () => {
    const fetchImpl = fakeFetch([
      { match: 'api.windy.com', status: 401, body: fixtureText('windy-error-invalid-key.json') },
    ]);
    await expect(
      searchWindy(KLAF, { apiKey: 'wrong', radiusKm: 15, userAgent: UA, fetchImpl }),
    ).rejects.toThrow('HTTP 401: Invalid API key');
  });

  it('keeps an image address for eight minutes, then asks again', async () => {
    let issued = 0;
    const single = () => {
      issued += 1;
      const cam = (fixtureJson('documented/windy-webcams.json') as { webcams: object[] }).webcams[0];
      return JSON.stringify(cam).replaceAll('token=first', `token=${issued}`);
    };
    const fetchImpl = fakeFetch([{ match: 'api.windy.com/webcams/api/v3/webcams/1234567890', body: single }]);
    let now = 1_000_000;
    const images = new WindyImages({ userAgent: UA, fetchImpl, apiKey: () => 'windy-key', now: () => now });

    const first = await images.imageUrl('1234567890');
    expect(first).toBe('https://images.example.test/1234567890/preview.jpg?token=1');
    now += 7 * 60_000;
    expect(await images.imageUrl('1234567890')).toBe(first);
    expect(fetchImpl.calls).toHaveLength(1);
    now += 2 * 60_000;
    expect(await images.imageUrl('1234567890')).toBe(
      'https://images.example.test/1234567890/preview.jpg?token=2',
    );
    expect(fetchImpl.calls).toHaveLength(2);
    expect(fetchImpl.calls[0]?.url).toBe(
      'https://api.windy.com/webcams/api/v3/webcams/1234567890?include=images',
    );

    // Several viewers at the moment of expiry share one request.
    now += 9 * 60_000;
    const both = await Promise.all([images.imageUrl('1234567890'), images.imageUrl('1234567890')]);
    expect(new Set(both).size).toBe(1);
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it('has nothing to offer without a key, or for an id that is not one', async () => {
    const fetchImpl = fakeFetch([]);
    const none = new WindyImages({ userAgent: UA, fetchImpl, apiKey: () => undefined });
    expect(none.available).toBe(false);
    expect(await none.imageUrl('1234567890')).toBeNull();
    const some = new WindyImages({ userAgent: UA, fetchImpl, apiKey: () => 'k' });
    expect(await some.imageUrl('../../etc')).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });
});

describe('discovery runs', () => {
  const setup = (
    overrides: { enabled?: boolean; youtube?: string; windy?: string; youtubeStatus?: number } = {},
  ) => {
    const store = new CameraStore(':memory:');
    const fetchImpl = fakeFetch([
      {
        match: 'googleapis.com/youtube/v3/search',
        status: overrides.youtubeStatus ?? 200,
        body:
          (overrides.youtubeStatus ?? 200) === 200
            ? fixtureText('documented/youtube-search.json')
            : fixtureText('youtube-error-invalid-key.json'),
      },
      { match: 'api.windy.com/webcams/api/v3/webcams', body: fixtureText('documented/windy-webcams.json') },
    ]);
    const clock = { now: 1_000_000 };
    const config = ConfigFileSchema.parse({
      airports: [{ icao: 'KLAF' }],
      discovery: { enabled: overrides.enabled ?? true },
      secrets: { youtubeApiKey: overrides.youtube, windyApiKey: overrides.windy },
    });
    const service = new DiscoveryService({
      config: () => config,
      store,
      userAgent: UA,
      fetchImpl,
      now: () => clock.now,
    });
    return { store, fetchImpl, clock, service };
  };

  it('does nothing while discovery is switched off', async () => {
    const { service, fetchImpl } = setup({ enabled: false, youtube: 'k', windy: 'k' });
    await expect(service.run(KLAF)).rejects.toThrow(/switched off/);
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('puts what it finds in the queue as pending, and skips a provider that has no key', async () => {
    const { service, store, fetchImpl } = setup({ windy: 'windy-key' });
    const outcomes = await service.run(KLAF);
    expect(outcomes[0]).toMatchObject({
      provider: 'youtube',
      ran: false,
      message: 'YOUTUBE_API_KEY is not set.',
    });
    expect(outcomes[1]).toMatchObject({ provider: 'windy', ran: true, ok: true, found: 2, added: 2 });
    expect(store.list().every((c) => c.status === 'pending')).toBe(true);
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it('does not ask a provider again inside the interval, and does afterwards', async () => {
    const { service, fetchImpl, clock } = setup({ youtube: 'yt-key', windy: 'windy-key' });
    const first = await service.run(KLAF);
    expect(first.map((o) => [o.provider, o.ran, o.found, o.added])).toEqual([
      ['youtube', true, 2, 2],
      ['windy', true, 2, 2],
    ]);
    expect(fetchImpl.calls).toHaveLength(5);
    expect(first[0]?.nextAt).toBe(1_000_000 + 6 * 3600_000);

    clock.now += 5 * 3600_000;
    const second = await service.run(KLAF);
    expect(second.map((o) => o.ran)).toEqual([false, false]);
    expect(second[0]).toMatchObject({ found: 2, added: 0, nextAt: 1_000_000 + 6 * 3600_000 });
    expect(fetchImpl.calls).toHaveLength(5);

    clock.now += 2 * 3600_000;
    const third = await service.run(KLAF);
    expect(third.map((o) => [o.ran, o.found, o.added])).toEqual([
      [true, 2, 0],
      [true, 2, 0],
    ]);
    expect(fetchImpl.calls).toHaveLength(10);
  });

  it('records a failure, lets the other provider go ahead, and allows another try after ten minutes', async () => {
    const { service, store, clock } = setup({ youtube: 'wrong', windy: 'windy-key', youtubeStatus: 400 });
    const outcomes = await service.run(KLAF);
    expect(outcomes[0]).toMatchObject({
      provider: 'youtube',
      ran: true,
      ok: false,
      message: 'HTTP 400: API key not valid. Please pass a valid API key.',
    });
    expect(outcomes[1]).toMatchObject({ provider: 'windy', ok: true, found: 2 });
    expect(store.lastRun('KLAF', 'youtube')).toMatchObject({ ok: false });

    clock.now += 5 * 60_000;
    expect((await service.run(KLAF))[0]).toMatchObject({ ran: false, ok: false });
    clock.now += 6 * 60_000;
    expect((await service.run(KLAF))[0]).toMatchObject({ ran: true });
  });
});

describe('framing check', () => {
  const headers = (h: Record<string, string>) => new Headers(h);
  const us = new URL('https://towercab.example.test');

  it('reads X-Frame-Options', () => {
    expect(framingBlocked(headers({}))).toBe(false);
    expect(framingBlocked(headers({ 'x-frame-options': 'DENY' }))).toBe(true);
    expect(framingBlocked(headers({ 'x-frame-options': 'SAMEORIGIN' }))).toBe(true);
    expect(framingBlocked(headers({ 'x-frame-options': 'ALLOW-FROM https://towercab.example.test' }))).toBe(
      true,
    );
  });

  it('reads frame-ancestors, which takes over from X-Frame-Options', () => {
    const csp = (value: string) => headers({ 'content-security-policy': value, 'x-frame-options': 'DENY' });
    expect(framingBlocked(csp("default-src 'self'; frame-ancestors *"), us)).toBe(false);
    expect(framingBlocked(csp("frame-ancestors 'none'"), us)).toBe(true);
    expect(framingBlocked(csp("frame-ancestors 'self'"), us)).toBe(true);
    expect(framingBlocked(csp('frame-ancestors https:'), us)).toBe(false);
    expect(framingBlocked(csp('frame-ancestors https://towercab.example.test'), us)).toBe(false);
    expect(framingBlocked(csp('frame-ancestors https://*.example.test'), us)).toBe(false);
    expect(framingBlocked(csp('frame-ancestors https://other.example.test'), us)).toBe(true);
    expect(framingBlocked(csp('frame-ancestors https://towercab.example.test:8443'), us)).toBe(true);
    // Without knowing our own address, a list of named hosts is taken to exclude us.
    expect(framingBlocked(csp('frame-ancestors https://towercab.example.test'))).toBe(true);
    // A policy without frame-ancestors leaves X-Frame-Options in charge.
    expect(framingBlocked(headers({ 'content-security-policy': "default-src 'self'" }), us)).toBe(false);
  });

  it('asks a page once and remembers the answer', async () => {
    const fetchImpl = fakeFetch([
      { match: 'blocked.example.test', body: '<html>', headers: { 'x-frame-options': 'DENY' } },
      { match: 'open.example.test', body: '<html>' },
    ]);
    const frames = new FrameChecker({ userAgent: UA, fetchImpl, publicUrl: us.href });
    expect(frames.cached('https://blocked.example.test/cam')).toBeUndefined();
    expect(await frames.check('https://blocked.example.test/cam')).toBe(true);
    expect(await frames.check('https://blocked.example.test/cam')).toBe(true);
    expect(await frames.check('https://open.example.test/cam')).toBe(false);
    expect(frames.cached('https://blocked.example.test/cam')).toBe(true);
    expect(fetchImpl.calls).toHaveLength(2);
    // A page the server cannot reach is not called blocked; the browser may still reach it.
    expect(await frames.check('https://unreachable.example.test/cam')).toBe(false);
  });
});
