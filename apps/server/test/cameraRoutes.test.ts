import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdminState, CamerasResponse, ClientConfig, PublicCamera } from '@towercab/shared';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { buildApp } from '../src/app';
import { readEnv } from '../src/config/env';
import { ConfigStore } from '../src/config/loader';
import { createServices, type Services } from '../src/services';
import { type FakeFetch, type FakeRoute, fakeFetch, fixtureText, upstreamRoutes } from './helpers';

/** A stand-in camera (or go2rtc): a real HTTP server on the loopback address. */
interface Stub {
  server: http.Server;
  port: number;
  origin: string;
  hits: { url: string; headers: http.IncomingHttpHeaders }[];
}

const POSE = { lat: 40.4148, lon: -86.9333, heightM: 12, headingDeg: 230, pitchDeg: -4, hfovDeg: 55 };

describe('cameras', () => {
  let dir: string;
  let app: FastifyInstance | undefined;
  let services: Services;
  let fetchImpl: FakeFetch;
  const stubs: Stub[] = [];

  const stub = async (handler: http.RequestListener): Promise<Stub> => {
    const hits: Stub['hits'] = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url ?? '', headers: req.headers });
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const made = { server, port, origin: `http://127.0.0.1:${port}`, hits };
    stubs.push(made);
    return made;
  };

  const start = async (yaml: string, envExtra: Record<string, string> = {}, routes: FakeRoute[] = []) => {
    const webDist = join(dir, 'web');
    await mkdir(webDist, { recursive: true });
    await writeFile(join(webDist, 'index.html'), '<!doctype html><title>TowerCab</title>');
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(
      join(dir, 'config', 'config.yaml'),
      `airports:\n  - { icao: KLAF }\n  - { icao: KIND }\nproviders:\n  adsblol: { enabled: false }\n${yaml}`,
    );
    const env = readEnv({
      CONFIG_DIR: join(dir, 'config'),
      DATA_DIR: join(dir, 'data'),
      WEB_DIST: webDist,
      TOWERCAB_VERSION: 'test',
      PUBLIC_URL: 'https://towercab.example.test',
      ...envExtra,
    });
    const config = await ConfigStore.open({
      configDir: env.configDir,
      exampleFile: null,
      envSecrets: env.secrets,
    });
    fetchImpl = fakeFetch([...routes, ...upstreamRoutes()]);
    services = await createServices({ env, logger: pino({ level: 'silent' }), config, fetchImpl });
    app = await buildApp(services);
    return app;
  };

  const get = (url: string, headers: Record<string, string> = {}) =>
    (app as FastifyInstance).inject({ method: 'GET', url, headers });
  const cameras = async (icao = 'KLAF') =>
    ((await get(`/api/cameras/${icao}`)).json() as CamerasResponse).cameras;
  const byId = (list: PublicCamera[], id: string) => list.find((c) => c.id === id) as PublicCamera;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'towercab-cam-'));
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
    await Promise.all(
      stubs.splice(0).map(
        (s) =>
          new Promise((resolve) => {
            s.server.closeAllConnections();
            s.server.close(resolve);
          }),
      ),
    );
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  describe('what viewers are told', () => {
    it('lists enabled cameras for the airport, each in the form its player needs', async () => {
      await start(`
proxy:
  allowlist: ["cams.example.test"]
cameras:
  - { id: yt, airport: KLAF, name: Spotters, kind: youtube, source: "https://youtu.be/AAAAAAAAAAA", link: "https://spotters.example.test" }
  - id: ramp
    airport: KLAF
    name: Ramp
    kind: hls
    source: "https://open.example.test/ramp.m3u8"
    attribution: Example FBO
    pose: { lat: 40.4148, lon: -86.9333, heightM: 12, headingDeg: 230, pitchDeg: -4, hfovDeg: 55 }
  - { id: gate, airport: KLAF, name: Gate, kind: mjpeg, source: "https://viewer:hunter2@cams.example.test/gate.mjpg", proxy: true }
  - { id: apron, airport: KLAF, name: Apron, kind: snapshot, source: "https://cams.example.test/apron.jpg", proxy: true, refreshSeconds: 10 }
  - { id: lan, airport: KLAF, name: Hangar, kind: webrtc, source: hangar }
  - { id: windy, airport: KLAF, name: Road, kind: snapshot, source: "windy:1234567890" }
  - { id: off, airport: KLAF, name: Off, kind: hls, source: "https://open.example.test/off.m3u8", enabled: false }
  - { id: other, airport: KIND, name: Elsewhere, kind: hls, source: "https://open.example.test/kind.m3u8" }
`);
      const res = await get('/api/cameras/KLAF');
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json() as CamerasResponse;
      expect(body.go2rtc).toBe(false);
      const list = body.cameras;
      expect(list.map((c) => c.id)).toEqual(['yt', 'ramp', 'gate', 'apron', 'lan', 'windy']);

      // Whatever form of address the config used, the player gets the bare video id.
      expect(byId(list, 'yt')).toMatchObject({ kind: 'youtube', src: 'AAAAAAAAAAA', provider: 'youtube' });
      expect(byId(list, 'ramp')).toMatchObject({
        src: 'https://open.example.test/ramp.m3u8',
        attribution: 'Example FBO',
        pose: POSE,
      });
      // Proxied cameras are known to the browser only by a path on this server.
      expect(byId(list, 'gate').src).toBe('/proxy/camera/gate');
      expect(byId(list, 'apron')).toMatchObject({ src: '/proxy/camera/apron', refreshSeconds: 10 });
      expect(res.body).not.toContain('hunter2');
      expect(res.body).not.toContain('cams.example.test');
      // Cameras that cannot play say why instead of offering an address.
      expect(byId(list, 'lan')).toMatchObject({ src: '', problem: expect.stringContaining('go2rtc') });
      expect(byId(list, 'windy')).toMatchObject({
        src: '',
        problem: expect.stringContaining('WINDY_API_KEY'),
      });

      expect((await cameras('KIND')).map((c) => c.id)).toEqual(['other']);
      expect((await get('/api/cameras/KORD')).statusCode).toBe(404);
    });

    it('switches the feature on, and credits YouTube and Windy, only when there is something to show', async () => {
      await start('cameras: []\n');
      let config = (await get('/api/client-config')).json() as ClientConfig;
      expect(config.features.cameras).toBe(false);
      expect(config.attributions.map((a) => a.name)).not.toContain('YouTube');
      await app?.close();

      await start(
        `cameras:
  - { id: yt, airport: KLAF, name: Spotters, kind: youtube, source: AAAAAAAAAAA }
  - { id: windy, airport: KIND, name: Road, kind: snapshot, source: "windy:1234567890" }
`,
        { WINDY_API_KEY: 'windy-key' },
      );
      config = (await get('/api/client-config')).json() as ClientConfig;
      expect(config.features.cameras).toBe(true);
      expect(config.attributions.map((a) => a.name)).toEqual(
        expect.arrayContaining(['YouTube', 'Windy.com']),
      );
    });

    it('marks an iframe camera whose page refuses to be framed', async () => {
      await start(
        `cameras:
  - { id: blocked, airport: KLAF, name: Blocked, kind: iframe, source: "https://blocked.example.test/cam" }
  - { id: fine, airport: KLAF, name: Fine, kind: iframe, source: "https://fine.example.test/cam" }
  - { id: ours, airport: KLAF, name: Ours, kind: iframe, source: "https://partner.example.test/cam" }
`,
        {},
        [
          { match: 'blocked.example.test', body: '<html>', headers: { 'x-frame-options': 'SAMEORIGIN' } },
          { match: 'fine.example.test', body: '<html>' },
          {
            match: 'partner.example.test',
            body: '<html>',
            headers: { 'content-security-policy': 'frame-ancestors https://towercab.example.test' },
          },
        ],
      );
      const list = await cameras();
      expect(byId(list, 'blocked')).toMatchObject({
        frameBlocked: true,
        link: 'https://blocked.example.test/cam',
      });
      expect(byId(list, 'fine').frameBlocked).toBeUndefined();
      // The page allows this app's own public address by name.
      expect(byId(list, 'ours').frameBlocked).toBeUndefined();
    });

    it('sends the browser to a Windy webcam image address that the server keeps fresh', async () => {
      const single = JSON.stringify(
        (JSON.parse(fixtureText('documented/windy-webcams.json')) as { webcams: object[] }).webcams[0],
      );
      await start(
        `cameras:
  - { id: road, airport: KLAF, name: Road, kind: snapshot, source: "windy:1234567890", link: "https://windy.example.test/webcams/1234567890" }
  - { id: ramp, airport: KLAF, name: Ramp, kind: hls, source: "https://open.example.test/ramp.m3u8" }
`,
        { WINDY_API_KEY: 'windy-key' },
        [{ match: 'api.windy.com/webcams/api/v3/webcams/1234567890', body: single }],
      );
      expect(byId(await cameras(), 'road')).toMatchObject({
        src: '/api/cameras/road/image',
        provider: 'windy',
        attribution: 'Webcams provided by Windy.com',
        link: 'https://windy.example.test/webcams/1234567890',
        refreshSeconds: 60,
      });
      const first = await get('/api/cameras/road/image');
      expect(first.statusCode).toBe(302);
      expect(first.headers.location).toBe('https://images.example.test/1234567890/preview.jpg?token=first');
      expect(first.headers['cache-control']).toBe('no-store');
      await get('/api/cameras/road/image');
      expect(fetchImpl.calls.filter((c) => c.url.includes('api.windy.com'))).toHaveLength(1);
      // Only for Windy cameras; nothing else has an image address to hand out.
      expect((await get('/api/cameras/ramp/image')).statusCode).toBe(404);
      expect((await get('/api/cameras/nope/image')).statusCode).toBe(404);
    });
  });

  describe('proxy', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

    it('serves a snapshot from an allowlisted camera, and only an image', async () => {
      const cam = await stub((req, res) => {
        if (req.url === '/snap.jpg') {
          res.writeHead(200, {
            'content-type': 'image/jpeg',
            'set-cookie': 'session=abc',
            server: 'cam/1.0',
          });
          res.end(JPEG);
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>login page</html>');
        }
      });
      await start(`
proxy:
  allowlist: ["127.0.0.1:${cam.port}"]
cameras:
  - { id: snap, airport: KLAF, name: Snap, kind: snapshot, source: "${cam.origin}/snap.jpg", proxy: true }
  - { id: page, airport: KLAF, name: Page, kind: snapshot, source: "${cam.origin}/login", proxy: true }
  - { id: direct, airport: KLAF, name: Direct, kind: snapshot, source: "https://open.example.test/x.jpg" }
`);
      const res = await get('/proxy/camera/snap', {
        cookie: 'mine=1',
        authorization: 'Bearer x',
        range: 'bytes=0-3',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.rawPayload.equals(JPEG)).toBe(true);
      // Nothing of the camera's own headers comes back, and nothing of the viewer's goes out.
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers.server).toBeUndefined();
      expect(cam.hits[0]?.headers.cookie).toBeUndefined();
      expect(cam.hits[0]?.headers.authorization).toBeUndefined();
      expect(cam.hits[0]?.headers['user-agent']).toContain('TowerCab/test');

      const page = await get('/proxy/camera/page');
      expect(page.statusCode).toBe(502);
      expect(page.body).not.toContain('login page');

      // A camera that is not marked for proxying is not reachable this way, whatever its address.
      expect((await get('/proxy/camera/direct')).statusCode).toBe(404);
      expect((await get('/proxy/camera/nope')).statusCode).toBe(404);
    });

    it('cannot be used to fetch an address of the caller’s choosing', async () => {
      const cam = await stub((_req, res) => {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(JPEG);
      });
      const secret = await stub((_req, res) => res.end('internal'));
      await start(`
proxy:
  allowlist: ["127.0.0.1:${cam.port}"]
cameras:
  - { id: snap, airport: KLAF, name: Snap, kind: snapshot, source: "${cam.origin}/snap.jpg", proxy: true }
  - { id: live, airport: KLAF, name: Live, kind: hls, source: "${cam.origin}/live.m3u8", proxy: true }
`);
      const target = Buffer.from(`${secret.origin}/admin`).toString('base64url');
      for (const url of [
        `/proxy/camera/snap?url=${encodeURIComponent(`${secret.origin}/admin`)}`,
        `/proxy/camera/snap/r?u=${target}&s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        `/proxy/camera/live/r?u=${target}&s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        `/proxy/camera/live/r?u=${target}`,
        '/proxy/camera/live/r',
        `/proxy/${encodeURIComponent(`${secret.origin}/admin`)}`,
        `/proxy?url=${encodeURIComponent(`${secret.origin}/admin`)}`,
      ]) {
        const res = await get(url);
        expect(res.body, url).not.toContain('internal');
        expect([200, 403, 404], url).toContain(res.statusCode);
      }
      expect(secret.hits).toEqual([]);
      // Even a correctly signed address is refused when its host is not on the allowlist.
      const signed = services.cameras.proxy.resourcePath('live', new URL(`${secret.origin}/admin`));
      const refused = await get(signed);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ error: 'proxy_refused', reason: 'not_allowed' });
      // The refusal does not tell the viewer where the server would not go.
      expect(refused.body).not.toContain(String(secret.port));
      expect(secret.hits).toEqual([]);
    });

    it('rewrites an HLS playlist and serves what it refers to, with byte ranges', async () => {
      const segment = Buffer.from('0123456789abcdef');
      const cam = await stub((req, res) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === '/live/index.m3u8') {
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
          res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/media.m3u8?token=t1\n');
        } else if (path === '/live/low/media.m3u8') {
          // Some cameras label playlists as plain text; the address ending is enough.
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6.0,\nseg1.ts\n');
        } else if (path === '/live/low/seg1.ts') {
          const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
          if (range) {
            const [from, to] = [Number(range[1]), Number(range[2])];
            res.writeHead(206, {
              'content-type': 'video/mp2t',
              'content-range': `bytes ${from}-${to}/${segment.length}`,
              'accept-ranges': 'bytes',
            });
            res.end(segment.subarray(from, to + 1));
          } else {
            res.writeHead(200, { 'content-type': 'video/mp2t' });
            res.end(segment);
          }
        } else if (path === '/live/low/init.mp4') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>a web page</html>');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await start(`
proxy:
  allowlist: ["127.0.0.1:${cam.port}"]
cameras:
  - { id: live, airport: KLAF, name: Live, kind: hls, source: "${cam.origin}/live/index.m3u8", proxy: true }
`);
      const master = await get('/proxy/camera/live');
      expect(master.statusCode).toBe(200);
      expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
      expect(master.body).not.toContain('127.0.0.1');
      const variantPath = master.body
        .split('\n')
        .find((line) => line.startsWith('/proxy/camera/live/r?')) as string;
      expect(variantPath).toBeDefined();

      const variant = await get(variantPath);
      expect(variant.statusCode).toBe(200);
      expect(variant.headers['content-type']).toBe('application/vnd.apple.mpegurl');
      // The query of the original address survived the trip.
      expect(cam.hits.at(-1)?.url).toBe('/live/low/media.m3u8?token=t1');
      const lines = variant.body.split('\n');
      const segmentPath = lines.find((line) => line.startsWith('/proxy/camera/live/r?')) as string;
      const initPath = /URI="([^"]+)"/.exec(
        lines.find((line) => line.startsWith('#EXT-X-MAP')) as string,
      )?.[1] as string;

      const whole = await get(segmentPath);
      expect(whole.statusCode).toBe(200);
      expect(whole.headers['content-type']).toBe('video/mp2t');
      expect(whole.rawPayload.equals(segment)).toBe(true);

      const part = await get(segmentPath, { range: 'bytes=4-7' });
      expect(part.statusCode).toBe(206);
      expect(part.headers['content-range']).toBe('bytes 4-7/16');
      expect(part.body).toBe('4567');

      // Something that is not media is not passed on, even from an allowed host.
      const init = await get(initPath);
      expect(init.statusCode).toBe(502);
      expect(init.body).not.toContain('a web page');

      // A signed address is good for the camera it was issued for, unaltered, and for nothing else.
      expect((await get(segmentPath.replace(/s=.{4}/, 's=AAAA'))).statusCode).toBe(403);
      expect((await get(segmentPath.replace('/live/r', '/other/r'))).statusCode).toBe(404);
      const [, u, s] = /u=([^&]+)&s=(.+)$/.exec(segmentPath) as RegExpExecArray;
      const elsewhere = Buffer.from(`${cam.origin}/live/low/seg2.ts`).toString('base64url');
      expect(u).not.toBe(elsewhere);
      expect((await get(`/proxy/camera/live/r?u=${elsewhere}&s=${s}`)).statusCode).toBe(403);
    });

    it('passes an MJPEG stream on with its boundary', async () => {
      const cam = await stub((_req, res) => {
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' });
        res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n');
        res.write(JPEG);
        res.end('\r\n--frame--\r\n');
      });
      await start(`
proxy:
  allowlist: ["127.0.0.1:${cam.port}"]
cameras:
  - { id: gate, airport: KLAF, name: Gate, kind: mjpeg, source: "${cam.origin}/video", proxy: true }
`);
      const res = await get('/proxy/camera/gate');
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('multipart/x-mixed-replace; boundary=frame');
      expect(res.rawPayload.includes(JPEG)).toBe(true);
    });

    it('says the camera did not answer, without saying where it lives', async () => {
      const cam = await stub((_req, res) => res.end());
      const port = cam.port;
      await new Promise((resolve) => cam.server.close(resolve));
      await start(`
proxy:
  allowlist: ["127.0.0.1:${port}"]
cameras:
  - { id: gone, airport: KLAF, name: Gone, kind: snapshot, source: "http://127.0.0.1:${port}/snap.jpg", proxy: true }
`);
      const res = await get('/proxy/camera/gone');
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ error: 'camera_unreachable', message: 'The camera did not answer.' });
      expect(res.body).not.toContain(String(port));
    });

    it('delivers a large, slowly arriving response whole over a real connection', async () => {
      // Half a megabyte in pieces with pauses between them, like a segment from a busy camera.
      const piece = Buffer.alloc(64 * 1024, 0x47);
      const pieces = 8;
      const cam = await stub((_req, res) => {
        res.writeHead(200, { 'content-type': 'video/mp2t' });
        let sent = 0;
        const timer = setInterval(() => {
          res.write(piece);
          sent += 1;
          if (sent === pieces) {
            clearInterval(timer);
            res.end();
          }
        }, 25);
      });
      await start(`
proxy:
  allowlist: ["127.0.0.1:${cam.port}"]
cameras:
  - { id: live, airport: KLAF, name: Live, kind: hls, source: "${cam.origin}/live.m3u8", proxy: true }
`);
      const base = await (app as FastifyInstance).listen({ port: 0, host: '127.0.0.1' });
      const path = services.cameras.proxy.resourcePath('live', new URL(`${cam.origin}/seg1.ts`));
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBe(piece.length * pieces);
    });

    it('stops fetching from the camera when the viewer goes away', async () => {
      let closedEarly: (() => void) | undefined;
      const gone = new Promise<void>((resolve) => {
        closedEarly = resolve;
      });
      const cam = await stub((_req, res) => {
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' });
        // An endless stream: it ends only when the other side hangs up.
        const timer = setInterval(() => res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\nxxxx\r\n'), 20);
        res.once('close', () => {
          clearInterval(timer);
          closedEarly?.();
        });
      });
      await start(`
proxy:
  allowlist: ["127.0.0.1:${cam.port}"]
cameras:
  - { id: gate, airport: KLAF, name: Gate, kind: mjpeg, source: "${cam.origin}/video", proxy: true }
`);
      const base = await (app as FastifyInstance).listen({ port: 0, host: '127.0.0.1' });
      const viewer = new AbortController();
      const res = await fetch(`${base}/proxy/camera/gate`, { signal: viewer.signal });
      const reader = res.body?.getReader();
      expect((await reader?.read())?.value?.length).toBeGreaterThan(0);
      viewer.abort();
      // The camera sees its connection closed shortly after; nothing keeps streaming into the void.
      await expect(
        Promise.race([gone, new Promise((_r, reject) => setTimeout(reject, 3000))]),
      ).resolves.toBeUndefined();
    });
  });

  describe('admin', () => {
    const auth = { authorization: 'Bearer correct-horse' };
    const patch = (id: string, body: object, headers: Record<string, string> = auth) =>
      (app as FastifyInstance).inject({
        method: 'PATCH',
        url: `/admin/api/cameras/${id}`,
        headers,
        payload: body,
      });
    const post = (url: string, headers: Record<string, string> = auth) =>
      (app as FastifyInstance).inject({ method: 'POST', url, headers });

    it('does not exist without an admin token', async () => {
      await start('cameras: []\n');
      const unknown = await get('/api/nope');
      for (const [method, url] of [
        ['GET', '/admin/api/state'],
        ['POST', '/admin/api/discovery/KLAF'],
        ['PATCH', '/admin/api/cameras/x'],
        ['GET', '/admin/api/anything'],
      ] as const) {
        const res = await (app as FastifyInstance).inject({ method, url, headers: auth, payload: {} });
        expect(res.statusCode, url).toBe(404);
        // Indistinguishable from a path that was never there.
        expect(Object.keys(res.json()).sort(), url).toEqual(Object.keys(unknown.json()).sort());
        expect(res.json().error, url).toBe('not_found');
      }
      expect(((await get('/api/client-config')).json() as ClientConfig).features.admin).toBe(false);
      // The page itself is part of the web app and explains that admin is off.
      expect((await get('/admin')).headers['content-type']).toContain('text/html');
    });

    it('wants the token on every request, and slows down guessing', async () => {
      await start('cameras: []\n', { ADMIN_TOKEN: 'correct-horse' });
      expect(((await get('/api/client-config')).json() as ClientConfig).features.admin).toBe(true);
      expect((await get('/admin/api/state')).statusCode).toBe(401);
      expect((await get('/admin/api/state', { authorization: 'Bearer wrong' })).statusCode).toBe(401);
      expect((await get('/admin/api/state', { authorization: 'Basic correct-horse' })).statusCode).toBe(401);
      // The token is not accepted in the address.
      expect((await get('/admin/api/state?token=correct-horse')).statusCode).toBe(401);

      const ok = await get('/admin/api/state', auth);
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      const state = ok.json() as AdminState;
      expect(state).toMatchObject({
        version: 'test',
        discovery: { enabled: false, youtube: false, windy: false },
        cameras: [],
        go2rtc: false,
      });
      expect(state.airports.map((a) => a.icao)).toEqual(['KLAF', 'KIND']);
      // The token itself is never sent back.
      expect(ok.body).not.toContain('correct-horse');

      for (let i = 0; i < 8; i += 1) await get('/admin/api/state', { authorization: `Bearer guess-${i}` });
      const locked = await get('/admin/api/state', auth);
      expect(locked.statusCode).toBe(429);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('sets a pose on a config camera, and nothing else about it', async () => {
      await start(
        `cameras:
  - { id: ramp, airport: KLAF, name: Ramp, kind: hls, source: "https://open.example.test/ramp.m3u8" }
`,
        { ADMIN_TOKEN: 'correct-horse' },
      );
      expect(byId(await cameras(), 'ramp').pose).toBeUndefined();

      const set = await patch('ramp', { pose: POSE });
      expect(set.statusCode).toBe(200);
      expect((set.json() as AdminState).cameras[0]).toMatchObject({
        id: 'ramp',
        origin: 'config',
        pose: POSE,
        poseFrom: 'admin',
      });
      expect(byId(await cameras(), 'ramp').pose).toEqual(POSE);

      expect((await patch('ramp', { enabled: false })).statusCode).toBe(409);
      expect((await patch('ramp', { pose: { ...POSE, hfovDeg: 500 } })).statusCode).toBe(400);
      expect((await patch('ramp', { source: 'https://evil.test/x.m3u8' })).statusCode).toBe(400);
      expect((await patch('nope', { pose: POSE })).statusCode).toBe(404);
      expect((await patch('ramp', { pose: POSE }, {})).statusCode).toBe(401);

      await patch('ramp', { pose: null });
      expect(byId(await cameras(), 'ramp').pose).toBeUndefined();
    });

    it('runs discovery into a queue that viewers do not see until an entry is approved', async () => {
      const single = JSON.stringify(
        (JSON.parse(fixtureText('documented/windy-webcams.json')) as { webcams: object[] }).webcams[0],
      );
      await start(
        'discovery: { enabled: true }\ncameras: []\n',
        { ADMIN_TOKEN: 'correct-horse', YOUTUBE_API_KEY: 'yt-key', WINDY_API_KEY: 'windy-key' },
        [
          { match: 'googleapis.com/youtube/v3/search', body: fixtureText('documented/youtube-search.json') },
          { match: 'api.windy.com/webcams/api/v3/webcams/1234567890', body: single },
          {
            match: 'api.windy.com/webcams/api/v3/webcams?',
            body: fixtureText('documented/windy-webcams.json'),
          },
        ],
      );
      expect((await post('/admin/api/discovery/KORD')).statusCode).toBe(404);
      expect((await post('/admin/api/discovery/KLAF', {})).statusCode).toBe(401);

      const run = await post('/admin/api/discovery/KLAF');
      expect(run.statusCode).toBe(200);
      const { outcomes, state } = run.json() as {
        outcomes: { provider: string; found: number }[];
        state: AdminState;
      };
      expect(outcomes.map((o) => [o.provider, o.found])).toEqual([
        ['youtube', 2],
        ['windy', 2],
      ]);
      expect(state.cameras.map((c) => [c.id, c.status]).sort()).toEqual([
        ['windy-1234567890', 'pending'],
        ['windy-1234567893', 'pending'],
        ['yt-AAAAAAAAAAA', 'pending'],
        ['yt-BBBBBBBBBBB', 'pending'],
      ]);
      expect(state.runs).toHaveLength(2);
      // The keys reached the providers in headers; they are in no address and in no answer.
      expect(fetchImpl.calls.every((c) => !c.url.includes('yt-key') && !c.url.includes('windy-key'))).toBe(
        true,
      );
      expect(run.body).not.toContain('yt-key');

      // Found, but not shown.
      expect(await cameras()).toEqual([]);
      expect(((await get('/api/client-config')).json() as ClientConfig).features.cameras).toBe(false);
      expect((await get('/api/cameras/windy-1234567890/image')).statusCode).toBe(404);

      await patch('yt-AAAAAAAAAAA', { status: 'approved', name: 'Ramp from the north', pose: POSE });
      await patch('windy-1234567890', { status: 'approved' });
      await patch('yt-BBBBBBBBBBB', { status: 'rejected' });
      const shown = await cameras();
      expect(shown.map((c) => c.id).sort()).toEqual(['windy-1234567890', 'yt-AAAAAAAAAAA']);
      expect(byId(shown, 'yt-AAAAAAAAAAA')).toMatchObject({
        name: 'Ramp from the north',
        kind: 'youtube',
        src: 'AAAAAAAAAAA',
        provider: 'youtube',
        link: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
        pose: POSE,
      });
      expect(byId(shown, 'windy-1234567890')).toMatchObject({
        kind: 'snapshot',
        src: '/api/cameras/windy-1234567890/image',
        link: 'https://windy.example.test/webcams/1234567890',
      });
      expect((await get('/api/cameras/windy-1234567890/image')).statusCode).toBe(302);

      // Switching an approved camera off hides it again.
      await patch('yt-AAAAAAAAAAA', { enabled: false });
      expect((await cameras()).map((c) => c.id)).toEqual(['windy-1234567890']);

      // A queue entry's picture is fetched fresh for the admin page.
      const preview = await get('/admin/api/cameras/windy-1234567893/preview', auth);
      expect(preview.statusCode).toBe(200);
      expect((await get('/admin/api/cameras/windy-1234567893/preview')).statusCode).toBe(401);

      // Asking again straight away costs no further searches.
      const before = fetchImpl.calls.length;
      const again = (await post('/admin/api/discovery/KLAF')).json() as { outcomes: { ran: boolean }[] };
      expect(again.outcomes.map((o) => o.ran)).toEqual([false, false]);
      expect(fetchImpl.calls.length).toBe(before);
    });

    it('refuses to search while discovery is switched off', async () => {
      await start('cameras: []\n', { ADMIN_TOKEN: 'correct-horse', YOUTUBE_API_KEY: 'yt-key' });
      const res = await post('/admin/api/discovery/KLAF');
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/switched off/);
      expect(fetchImpl.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
    });
  });

  describe('go2rtc', () => {
    /** A stand-in go2rtc: the two player files over HTTP, and a WebSocket that echoes with a prefix. */
    const fakeGo2rtc = async () => {
      const sockets: { url: string }[] = [];
      const made = await stub((req, res) => {
        if (req.url === '/video-rtc.js') {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end('export class VideoRTC extends HTMLElement {}');
        } else if (req.url === '/video-stream.js') {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          res.end("import {VideoRTC} from './video-rtc.js';");
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"secret":"go2rtc config"}');
        }
      });
      const wss = new WebSocketServer({ server: made.server });
      wss.on('connection', (socket, request) => {
        sockets.push({ url: request.url ?? '' });
        socket.on('message', (data, binary) => {
          if (binary) socket.send(data, { binary: true });
          else socket.send(`go2rtc heard: ${String(data)}`);
        });
      });
      return { ...made, sockets };
    };

    const listen = async () => {
      const address = await (app as FastifyInstance).listen({ port: 0, host: '127.0.0.1' });
      return address.replace(/^http/, 'ws');
    };
    const outcome = (socket: WebSocket) =>
      new Promise<string>((resolve) => {
        socket.once('open', () => resolve('open'));
        socket.once('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
        socket.once('error', (err) => resolve(`error ${err.message}`));
      });

    it('lets the browser load the two player files and nothing else', async () => {
      const go2rtc = await fakeGo2rtc();
      // The app's own `fetch` is replaced in these tests, so the player files are answered from this table.
      await start(
        `
go2rtc: { url: "${go2rtc.origin}" }
cameras:
  - { id: hangar, airport: KLAF, name: Hangar, kind: webrtc, source: hangar_cam }
`,
        {},
        [
          { match: '/video-stream.js', body: "import {VideoRTC} from './video-rtc.js';" },
          { match: '/video-rtc.js', body: 'export class VideoRTC extends HTMLElement {}' },
        ],
      );
      const list = (await get('/api/cameras/KLAF')).json() as CamerasResponse;
      expect(list.go2rtc).toBe(true);
      expect(list.cameras[0]).toMatchObject({ id: 'hangar', kind: 'webrtc', src: 'hangar_cam' });

      const file = await get('/go2rtc/video-stream.js');
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toContain('text/javascript');
      expect(file.body).toContain("from './video-rtc.js'");
      expect(fetchImpl.calls.at(-1)?.url).toBe(`${go2rtc.origin}/video-stream.js`);
      expect((await get('/go2rtc/video-rtc.js')).statusCode).toBe(200);
      for (const url of [
        '/go2rtc/api/config',
        '/go2rtc/api/streams',
        '/go2rtc/index.html',
        '/go2rtc/api/exit',
      ]) {
        const res = await get(url);
        expect(res.statusCode, url).toBe(404);
        expect(res.body, url).not.toContain('go2rtc config');
      }
    });

    it('bridges the stream WebSocket for a camera’s stream, and for nothing else', async () => {
      const go2rtc = await fakeGo2rtc();
      await start(`
go2rtc: { url: "${go2rtc.origin}" }
cameras:
  - { id: hangar, airport: KLAF, name: Hangar, kind: webrtc, source: hangar_cam }
  - { id: off, airport: KLAF, name: Off, kind: webrtc, source: other_cam, enabled: false }
`);
      const base = await listen();

      const socket = new WebSocket(`${base}/go2rtc/api/ws?src=hangar_cam&dst=evil`);
      expect(await outcome(socket)).toBe('open');
      const text = new Promise<string>((resolve) => socket.once('message', (data) => resolve(String(data))));
      socket.send(JSON.stringify({ type: 'mse', value: 'avc1.640029' }));
      expect(await text).toBe('go2rtc heard: {"type":"mse","value":"avc1.640029"}');
      const binary = new Promise<[Buffer, boolean]>((resolve) =>
        socket.once('message', (data, isBinary) => resolve([data as Buffer, isBinary])),
      );
      socket.send(Buffer.from([1, 2, 3]), { binary: true });
      expect(await binary).toEqual([Buffer.from([1, 2, 3]), true]);
      // Only the stream name went upstream; "dst" (publishing into go2rtc) did not.
      expect(go2rtc.sockets).toEqual([{ url: '/api/ws?src=hangar_cam' }]);
      expect(services.cameras.go2rtc.viewers).toBe(1);
      socket.close();

      // A stream that is not an enabled camera's, or no stream at all, is refused before go2rtc hears of it.
      for (const query of ['src=other_cam', 'src=some_private_stream', 'dst=hangar_cam', '']) {
        expect(await outcome(new WebSocket(`${base}/go2rtc/api/ws?${query}`)), query).toBe('refused 404');
      }
      expect(await outcome(new WebSocket(`${base}/go2rtc/api/config`))).toMatch(/^error/);
      expect(go2rtc.sockets).toHaveLength(1);
    });

    it('is refused entirely when no go2rtc address is configured', async () => {
      await start(`cameras:
  - { id: hangar, airport: KLAF, name: Hangar, kind: webrtc, source: hangar_cam }
`);
      const base = await listen();
      expect(await outcome(new WebSocket(`${base}/go2rtc/api/ws?src=hangar_cam`))).toBe('refused 404');
      expect((await get('/go2rtc/video-rtc.js')).statusCode).toBe(404);
    });
  });
});
