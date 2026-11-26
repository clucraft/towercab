import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AirportDetail, isLiveAtcUrl, publicAudioStations, streamUrlNow } from '@towercab/shared';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { readEnv } from '../src/config/env';
import { ConfigError, ConfigStore, parseConfig } from '../src/config/loader';
import { createServices, type Services } from '../src/services';
import { fakeFetch, upstreamRoutes } from './helpers';

/** A stand-in receiver: a real HTTP server on the loopback address. */
interface Stub {
  server: http.Server;
  port: number;
  origin: string;
}

const MP3_FRAME = Buffer.from([0xff, 0xfb, 0x90, 0x64, ...new Array(60).fill(0)]);

describe('radio', () => {
  describe('stations in the config', () => {
    const config = (audio: string, extra = '') =>
      parseConfig(`airports:\n  - icao: KLAF\n    audio:\n${audio}\n${extra}`);

    it('takes a station with a name and an address, and fills in the rest', () => {
      const parsed = config(
        '      - { name: Purdue Tower, frequency: "118.300", url: "https://radio.example.test/klaf" }',
      );
      expect(parsed.airports[0]?.audio).toEqual([
        { name: 'Purdue Tower', frequency: '118.300', url: 'https://radio.example.test/klaf', proxy: false },
      ]);
    });

    it('has no stations unless some are configured', () => {
      expect(parseConfig('airports:\n  - icao: KLAF\n').airports[0]?.audio).toEqual([]);
    });

    it('refuses an address that is not http or https', () => {
      expect(() => config('      - { name: Tower, url: "rtsp://radio.example.test/klaf" }')).toThrow(
        ConfigError,
      );
    });

    it('fetches a proxied station only from a host on the allowlist', () => {
      expect(() =>
        config('      - { name: Tower, url: "http://192.168.1.20:8000/klaf", proxy: true }'),
      ).toThrow(/not on proxy.allowlist/);
      const allowed = config(
        '      - { name: Tower, url: "http://192.168.1.20:8000/klaf", proxy: true }',
        'proxy:\n  allowlist: ["192.168.1.20:8000"]',
      );
      expect(allowed.airports[0]?.audio[0]?.proxy).toBe(true);
    });

    it('never passes a LiveATC stream on through the server', () => {
      expect(() =>
        config(
          '      - { name: Tower, url: "https://s1-bos.liveatc.net/klaf", proxy: true }',
          'proxy:\n  allowlist: ["*.liveatc.net"]',
        ),
      ).toThrow(/LiveATC's terms of use/);
    });

    it('keeps a user name and password off the browser', () => {
      expect(() =>
        config('      - { name: Tower, url: "http://me:secret@radio.example.test/klaf" }'),
      ).toThrow(/user name or password/);
    });

    it('allows at most eight stations per airport', () => {
      const nine = Array.from(
        { length: 9 },
        (_, i) => `      - { name: S${i}, url: "https://r.example.test/${i}" }`,
      );
      expect(() => config(nine.join('\n'))).toThrow(ConfigError);
    });
  });

  describe('what the browser is given', () => {
    it('gives a proxied station a path on this server and a direct one its own address', () => {
      const stations = publicAudioStations('KLAF', [
        { name: 'Own receiver', url: 'http://192.168.1.20:8000/klaf', proxy: true, frequency: '118.300' },
        { name: 'Elsewhere', url: 'https://radio.example.test/klaf', proxy: false, attribution: 'A friend' },
      ]);
      expect(stations).toEqual([
        { name: 'Own receiver', frequency: '118.300', src: '/proxy/audio/KLAF/0', proxied: true },
        {
          name: 'Elsewhere',
          src: 'https://radio.example.test/klaf',
          proxied: false,
          attribution: 'A friend',
        },
      ]);
    });

    it('credits LiveATC with a link to its site, as its terms ask', () => {
      const [station] = publicAudioStations('KORD', [
        { name: 'O’Hare Tower', url: 'https://s1-fmt2.liveatc.net/kord_twr', proxy: false },
      ]);
      expect(station?.attribution).toBe('Audio from LiveATC.net');
      expect(station?.link).toBe('https://www.liveatc.net');
    });

    it('asks LiveATC for a new address every time, as their own player does, and leaves others alone', () => {
      const liveatc = { src: 'https://s1-bos.liveatc.net/klaf', proxied: false };
      expect(streamUrlNow(liveatc, 1795658000000)).toBe(
        'https://s1-bos.liveatc.net/klaf?nocache=1795658000000',
      );
      expect(streamUrlNow({ ...liveatc, src: `${liveatc.src}?a=1` }, 5)).toBe(
        'https://s1-bos.liveatc.net/klaf?a=1&nocache=5',
      );
      expect(streamUrlNow({ src: 'https://radio.example.test/klaf', proxied: false }, 5)).toBe(
        'https://radio.example.test/klaf',
      );
      expect(streamUrlNow({ src: '/proxy/audio/KLAF/0', proxied: true }, 5)).toBe('/proxy/audio/KLAF/0');
    });

    it('knows LiveATC by its host name only', () => {
      expect(isLiveAtcUrl('https://s1-bos.liveatc.net/kbos_twr')).toBe(true);
      expect(isLiveAtcUrl('http://LIVEATC.NET./x')).toBe(true);
      expect(isLiveAtcUrl('https://user@www.liveatc.net:443/x')).toBe(true);
      expect(isLiveAtcUrl('https://notliveatc.net/x')).toBe(false);
      expect(isLiveAtcUrl('https://example.test/?u=liveatc.net')).toBe(false);
      expect(isLiveAtcUrl('not a url')).toBe(false);
    });
  });

  describe('proxy', () => {
    let dir: string;
    let app: FastifyInstance | undefined;
    let services: Services;
    const stubs: Stub[] = [];

    const stub = async (handler: http.RequestListener): Promise<Stub> => {
      const server = http.createServer(handler);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const made = { server, port, origin: `http://127.0.0.1:${port}` };
      stubs.push(made);
      return made;
    };

    const start = async (audio: string, allowlist: string) => {
      const webDist = join(dir, 'web');
      await mkdir(webDist, { recursive: true });
      await writeFile(join(webDist, 'index.html'), '<!doctype html><title>TowerCab</title>');
      await mkdir(join(dir, 'config'), { recursive: true });
      await writeFile(
        join(dir, 'config', 'config.yaml'),
        `airports:\n  - icao: KLAF\n    audio:\n${audio}\nproviders:\n  adsblol: { enabled: false }\nproxy:\n  allowlist: [${allowlist}]\n`,
      );
      const env = readEnv({
        CONFIG_DIR: join(dir, 'config'),
        DATA_DIR: join(dir, 'data'),
        WEB_DIST: webDist,
        TOWERCAB_VERSION: 'test',
      });
      const config = await ConfigStore.open({ configDir: env.configDir, exampleFile: null });
      services = await createServices({
        env,
        logger: pino({ level: 'silent' }),
        config,
        fetchImpl: fakeFetch(upstreamRoutes()),
      });
      app = await buildApp(services);
      return app;
    };
    const get = (url: string) => (app as FastifyInstance).inject({ method: 'GET', url });

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'towercab-audio-'));
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

    it('lists the stations with the airport', async () => {
      await start(
        '      - { name: Own, url: "http://127.0.0.1:9/klaf", proxy: true }\n      - { name: Direct, url: "https://radio.example.test/klaf" }',
        '"127.0.0.1:9"',
      );
      const detail = (await get('/api/airports/KLAF')).json() as AirportDetail;
      expect(detail.audio.map((s) => s.src)).toEqual([
        '/proxy/audio/KLAF/0',
        'https://radio.example.test/klaf',
      ]);
    });

    it('passes on the stream of an allowlisted receiver, and stops when the listener goes away', async () => {
      let hungUp: (() => void) | undefined;
      const gone = new Promise<void>((resolve) => {
        hungUp = resolve;
      });
      const receiver = await stub((_req, res) => {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-name': 'KLAF Tower' });
        // An endless stream, like Icecast: it ends only when the other side hangs up.
        const timer = setInterval(() => res.write(MP3_FRAME), 20);
        res.once('close', () => {
          clearInterval(timer);
          hungUp?.();
        });
      });
      await start(
        `      - { name: Tower, url: "${receiver.origin}/klaf.mp3", proxy: true }`,
        `"127.0.0.1:${receiver.port}"`,
      );
      const base = await (app as FastifyInstance).listen({ port: 0, host: '127.0.0.1' });
      const listener = new AbortController();
      const res = await fetch(`${base}/proxy/audio/KLAF/0`, { signal: listener.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/mpeg');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const reader = res.body?.getReader();
      expect((await reader?.read())?.value?.length).toBeGreaterThan(0);
      listener.abort();
      await expect(
        Promise.race([gone, new Promise((_r, reject) => setTimeout(reject, 3000))]),
      ).resolves.toBeUndefined();
    });

    it('passes on only stations marked proxy, by their place in the list', async () => {
      await start('      - { name: Direct, url: "https://radio.example.test/klaf" }', '');
      expect((await get('/proxy/audio/KLAF/0')).statusCode).toBe(404);
      expect((await get('/proxy/audio/KLAF/1')).statusCode).toBe(404);
      expect((await get('/proxy/audio/KIND/0')).statusCode).toBe(404);
      expect((await get('/proxy/audio/KLAF/x')).statusCode).toBe(404);
    });

    it('passes on nothing that is not audio', async () => {
      const receiver = await stub((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p>an admin page</p>');
      });
      await start(
        `      - { name: Tower, url: "${receiver.origin}/", proxy: true }`,
        `"127.0.0.1:${receiver.port}"`,
      );
      const res = await get('/proxy/audio/KLAF/0');
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain('admin page');
    });

    it('says the station did not answer, without saying where it lives', async () => {
      const receiver = await stub((_req, res) => res.end());
      const port = receiver.port;
      await new Promise((resolve) => receiver.server.close(resolve));
      await start(
        `      - { name: Tower, url: "http://127.0.0.1:${port}/klaf", proxy: true }`,
        `"127.0.0.1:${port}"`,
      );
      const res = await get('/proxy/audio/KLAF/0');
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain(String(port));
    });
  });
});
