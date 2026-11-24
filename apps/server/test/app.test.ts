import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AirportDetail, ClientConfig, ServerMessage } from '@towercab/shared';
import { ServerMessageSchema } from '@towercab/shared';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { readEnv } from '../src/config/env';
import { ConfigStore } from '../src/config/loader';
import { createServices, type Services } from '../src/services';
import { type FakeFetch, fakeFetch, upstreamRoutes } from './helpers';

const CONFIG = `
airports:
  - { icao: KLAF, radiusNm: 6, ceilingFtAgl: 5000, defaultView: tower }
  - { icao: KIND, radiusNm: 8, ceilingFtAgl: 6000 }
providers:
  adsbfi: { enabled: true, priority: 1 }
  adsblol: { enabled: false }
polling:
  activeIntervalMs: 1000
  idleIntervalMs: 5000
  pauseWhenNoViewersAfterMs: 0
cameras:
  - { id: ramp, airport: KLAF, name: Ramp, kind: hls, source: "https://cams.example.test/ramp.m3u8" }
  - { id: off, airport: KLAF, name: Off, kind: hls, source: "https://cams.example.test/off.m3u8", enabled: false }
`;

describe('server', () => {
  let dir: string;
  let app: FastifyInstance;
  let services: Services;
  let fetchImpl: FakeFetch;

  const start = async (envExtra: Record<string, string> = {}) => {
    const webDist = join(dir, 'web');
    await mkdir(join(webDist, 'assets'), { recursive: true });
    await writeFile(join(webDist, 'index.html'), '<!doctype html><title>TowerCab</title>');
    await writeFile(join(webDist, 'assets', 'app.js'), 'console.log(1)');
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'config.yaml'), CONFIG);

    const env = readEnv({
      CONFIG_DIR: join(dir, 'config'),
      DATA_DIR: join(dir, 'data'),
      WEB_DIST: webDist,
      TOWERCAB_VERSION: 'test',
      ...envExtra,
    });
    const logger = pino({ level: 'silent' });
    const config = await ConfigStore.open({
      configDir: env.configDir,
      exampleFile: null,
      envSecrets: env.secrets,
    });
    fetchImpl = fakeFetch(upstreamRoutes());
    services = await createServices({ env, logger, config, fetchImpl });
    app = await buildApp(services);
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'towercab-app-'));
  });
  afterEach(async () => {
    await app?.close();
    // A background layout fetch can still be writing its cache file when a test ends.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  describe('HTTP', () => {
    it('answers /healthz', async () => {
      await start();
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'ok', version: 'test', airports: ['KLAF', 'KIND'] });
    });

    it('serves the web app and falls back to index.html for app routes', async () => {
      await start();
      for (const url of ['/', '/KLAF', '/KIND?view=tower&mode=schematic', '/debug/KLAF']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-type'], url).toContain('text/html');
      }
      const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toContain('immutable');
    });

    it('returns JSON 404 for unknown API routes instead of the app shell', async () => {
      await start();
      const res = await app.inject({ method: 'GET', url: '/api/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'not_found' });
      expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    });

    it('lists the configured airports with data from OurAirports', async () => {
      await start();
      const res = await app.inject({ method: 'GET', url: '/api/airports' });
      expect(res.json()).toEqual([
        {
          icao: 'KLAF',
          name: 'Purdue University Airport',
          city: 'West Lafayette',
          lat: 40.412875,
          lon: -86.939363,
          elevationFt: 606,
          defaultView: 'tower',
          available: true,
        },
        {
          icao: 'KIND',
          name: 'Indianapolis International Airport',
          city: 'Indianapolis',
          lat: 39.7173,
          lon: -86.294403,
          elevationFt: 797,
          defaultView: 'overhead',
          available: true,
        },
      ]);
    });

    it('returns the merged airport: config, runways, geoid offset and links', async () => {
      await start();
      const res = await app.inject({ method: 'GET', url: '/api/airports/klaf' });
      expect(res.statusCode).toBe(200);
      const detail = res.json() as AirportDetail;
      expect(detail).toMatchObject({ icao: 'KLAF', radiusNm: 6, ceilingFtAgl: 5000, tower: null });
      expect(detail.runways.map((r) => r.id)).toEqual(['05/23', '10/28']);
      expect(detail.geoidUndulationM).toBeCloseTo(-34.3, 0);
      expect(detail.links.flightaware).toBe('https://www.flightaware.com/live/airport/KLAF');
      expect((await app.inject({ method: 'GET', url: '/api/airports/KORD' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/airports/not-a-code' })).statusCode).toBe(404);
    });

    it('includes the OSM layout once it has been fetched', async () => {
      await start();
      // The first request starts the background fetch; wait for the airport service to pick it up.
      await new Promise<void>((resolve) => {
        const check = async () => {
          const detail = await services.airports.detail('KLAF');
          if (detail?.layout) resolve();
          else setTimeout(check, 10);
        };
        void check();
      });
      const detail = (await app.inject({ method: 'GET', url: '/api/airports/KLAF' })).json() as AirportDetail;
      expect(detail.layout?.features.length).toBeGreaterThan(70);
      expect(detail.layout?.attribution).toContain('OpenStreetMap');
      expect(detail.sources.layout).toBe('osm');
    });

    it('gives the browser its config: tokens it may see, feature flags and credits', async () => {
      await start({ CESIUM_ION_TOKEN: 'ion-test-token', ADMIN_TOKEN: 'secret-admin' });
      const res = await app.inject({ method: 'GET', url: '/api/client-config' });
      const body = res.json() as ClientConfig;
      expect(body).toMatchObject({
        version: 'test',
        cesiumIonToken: 'ion-test-token',
        googleMapsApiKey: null,
        features: { photoreal: true, terrain: true, cameras: true, admin: true, photos: true },
        renderDelayMs: 2500,
      });
      expect(body.attributions.map((a) => a.name)).toEqual([
        'adsb.fi',
        'OpenStreetMap contributors',
        'OurAirports',
        'aviationweather.gov',
        'planespotters.net',
      ]);
      // Server-side secrets never appear, under any name.
      expect(res.body).not.toContain('secret-admin');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('works with no tokens at all', async () => {
      await start();
      const body = (await app.inject({ method: 'GET', url: '/api/client-config' })).json() as ClientConfig;
      expect(body).toMatchObject({
        cesiumIonToken: null,
        features: { photoreal: false, terrain: false, admin: false },
      });
    });

    it('lists only enabled cameras for the airport', async () => {
      await start();
      const cams = (await app.inject({ method: 'GET', url: '/api/cameras/KLAF' })).json() as { id: string }[];
      expect(cams.map((c) => c.id)).toEqual(['ramp']);
      expect((await app.inject({ method: 'GET', url: '/api/cameras/KIND' })).json()).toEqual([]);
    });

    it('serves the cached METAR', async () => {
      await start();
      const res = await app.inject({ method: 'GET', url: '/api/metar/KIND' });
      expect(res.json()).toMatchObject({
        metar: { icao: 'KIND', altimHpa: 1032.9, windDirDeg: 50, windSpeedKt: 11 },
      });
      await app.inject({ method: 'GET', url: '/api/metar/KIND' });
      expect(fetchImpl.calls.filter((c) => c.url.includes('aviationweather')).length).toBe(1);
    });

    it('looks up an aircraft photo, and not for TIS-B track files', async () => {
      await start();
      const res = await app.inject({ method: 'GET', url: '/api/photos/a0d5d6' });
      expect(res.json()).toMatchObject({ photo: { photographer: 'Ruoyang Yan' } });
      expect((await app.inject({ method: 'GET', url: '/api/photos/~2a1b3c' })).json()).toEqual({
        photo: null,
      });
      expect((await app.inject({ method: 'GET', url: '/api/photos/xyz' })).json()).toEqual({ photo: null });
    });

    it('exposes Prometheus metrics', async () => {
      await start();
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.body).toContain('towercab_info{version="test"} 1');
      expect(res.body).toContain('towercab_poll_state{airport="KLAF",state="paused"} 1');
      expect(res.body).toContain('towercab_provider_enabled{provider="adsbfi"} 1');
      expect(res.body).toContain('towercab_provider_enabled{provider="adsblol"} 0');
      expect(res.body).toContain('towercab_ws_clients 0');
    });
  });

  describe('WebSocket', () => {
    /** A test client that collects messages and lets a test wait for the one it needs. */
    const connect = async () => {
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const messages: ServerMessage[] = [];
      const waiters: { test: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
      socket.addEventListener('message', (event) => {
        const message = ServerMessageSchema.parse(JSON.parse(String(event.data)));
        messages.push(message);
        for (const w of [...waiters]) {
          if (w.test(message)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(message);
          }
        }
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve());
        socket.addEventListener('error', () => reject(new Error('websocket failed to open')));
      });
      const next = <T extends ServerMessage['type']>(type: T, timeoutMs = 4000) =>
        new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
          const found = messages.find((m) => m.type === type);
          if (found) {
            messages.splice(messages.indexOf(found), 1);
            return resolve(found as Extract<ServerMessage, { type: T }>);
          }
          const timer = setTimeout(
            () => reject(new Error(`no "${type}" message within ${timeoutMs} ms`)),
            timeoutMs,
          );
          waiters.push({
            test: (m) => m.type === type,
            resolve: (m) => {
              clearTimeout(timer);
              messages.splice(messages.indexOf(m), 1);
              resolve(m as Extract<ServerMessage, { type: T }>);
            },
          });
        });
      return { socket, port, next, send: (m: object) => socket.send(JSON.stringify(m)) };
    };

    it('greets, sends a snapshot on subscribe, then live deltas with real aircraft', async () => {
      await start();
      const client = await connect();
      expect(await client.next('hello')).toMatchObject({ version: 'test', pingIntervalMs: 20_000 });

      client.send({ type: 'subscribe', icao: 'klaf' });
      const snapshot = await client.next('snapshot');
      expect(snapshot).toMatchObject({ icao: 'KLAF', seq: 0, aircraft: [] });
      expect(snapshot.status).toMatchObject({ pollState: 'active', viewers: 1 });
      expect(Math.abs(snapshot.serverTime - Date.now())).toBeLessThan(2000);

      // The first poll answers from the adsb.fi fixture captured at KLAF.
      const delta = await client.next('delta');
      expect(delta).toMatchObject({ icao: 'KLAF', seq: 1, removed: [] });
      const byHex = new Map(delta.upserts.map((a) => [a.hex, a]));
      // N885MM was at 7,900 ft, above the 5,000 ft ceiling: filtered out.
      expect([...byHex.keys()].sort()).toEqual(['a64c6f', 'a8cd91', 'abe679', 'abea30']);
      expect(byHex.get('abea30')).toMatchObject({
        callsign: 'PDU67',
        registration: 'N867PU',
        typeCode: 'P28A',
        onGround: true,
        phase: 'taxiing',
        headingDeg: 11.3,
        source: 'adsbfi',
      });
      const cessna = byHex.get('a8cd91');
      expect(cessna).toMatchObject({ onGround: false, altSource: 'geom', altGeomFt: 1525 });
      expect(cessna?.heightM).toBeCloseTo(464.8, 0);

      // The server asked adsb.fi, and only for the airport being watched.
      const adsb = fetchImpl.calls.filter((c) => c.url.includes('adsb.fi'));
      expect(adsb.length).toBeGreaterThan(0);
      expect(adsb.every((c) => c.url.includes('/lat/40.4129/lon/-86.9394/dist/6'))).toBe(true);
      client.socket.close();
    });

    it('polling follows viewers: it stops when the last one leaves', async () => {
      await start();
      const client = await connect();
      client.send({ type: 'subscribe', icao: 'KIND' });
      await client.next('snapshot');
      await client.next('delta');
      expect(services.live.status('KIND')).toMatchObject({ pollState: 'active', viewers: 1 });
      expect(services.live.status('KLAF')).toMatchObject({ pollState: 'paused', viewers: 0 });

      client.send({ type: 'unsubscribe' });
      await expect.poll(() => services.live.status('KIND').pollState).toBe('paused');
      const calls = fetchImpl.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(fetchImpl.calls.length).toBe(calls);
      client.socket.close();
    });

    it('a second viewer gets the current picture straight away, and closing a socket counts as leaving', async () => {
      await start();
      const first = await connect();
      first.send({ type: 'subscribe', icao: 'KLAF' });
      await first.next('delta');

      const { port } = app.server.address() as AddressInfo;
      const second = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const snapshot = await new Promise<ServerMessage>((resolve) => {
        second.addEventListener('open', () =>
          second.send(JSON.stringify({ type: 'subscribe', icao: 'KLAF' })),
        );
        second.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.type === 'snapshot') resolve(message);
        });
      });
      if (snapshot.type !== 'snapshot') throw new Error('expected a snapshot');
      expect(snapshot.aircraft.map((a) => a.hex).sort()).toEqual(['a64c6f', 'a8cd91', 'abe679', 'abea30']);
      expect(snapshot.status.viewers).toBe(2);

      second.close();
      first.socket.close();
      await expect.poll(() => services.live.status('KLAF').viewers).toBe(0);
      await expect.poll(() => services.hub.clientCount).toBe(0);
    });

    it('rejects unknown airports and malformed messages without dropping the connection', async () => {
      await start();
      const client = await connect();
      client.send({ type: 'subscribe', icao: 'KORD' });
      expect(await client.next('error')).toMatchObject({ code: 'unknown_airport' });
      client.socket.send('not json');
      expect(await client.next('error')).toMatchObject({ code: 'bad_message' });
      client.send({ type: 'launch' });
      expect(await client.next('error')).toMatchObject({ code: 'bad_message' });
      client.send({ type: 'subscribe', icao: 'KLAF' });
      expect((await client.next('snapshot')).icao).toBe('KLAF');
      client.socket.close();
    });

    it('refuses upgrades on any path but /ws', async () => {
      await start();
      await app.listen({ host: '127.0.0.1', port: 0 });
      const { port } = app.server.address() as AddressInfo;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/elsewhere`);
      const outcome = await new Promise<string>((resolve) => {
        socket.addEventListener('open', () => resolve('open'));
        socket.addEventListener('error', () => resolve('error'));
        socket.addEventListener('close', () => resolve('close'));
      });
      expect(outcome).not.toBe('open');
    });
  });
});
