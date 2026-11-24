import type { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseAllowlist } from '../src/cameras/allowlist';
import { CameraProxy, ProxyRefused, readText } from '../src/cameras/proxy';

/** A stand-in camera: a real HTTP server on the loopback address. */
async function camera(
  handler: http.RequestListener,
): Promise<{ origin: string; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port, hits };
}
const servers: http.Server[] = [];

/** A resolver that knows the given names and nothing else. */
function fakeDns(names: Record<string, string>): typeof dnsLookup {
  return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const address = names[hostname];
    if (!address) return callback(Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    const family = address.includes(':') ? 6 : 4;
    if ((options as { all?: boolean }).all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as unknown as typeof dnsLookup;
}

function proxy(allowlist: string[], extra: { allowPrivate?: boolean; dns?: Record<string, string> } = {}) {
  return new CameraProxy({
    rules: () => parseAllowlist(allowlist),
    allowPrivateAddresses: () => extra.allowPrivate ?? false,
    userAgent: 'TowerCab-test/0 (+https://example.test)',
    lookup: fakeDns(extra.dns ?? {}),
    secret: Buffer.alloc(32, 7),
    timeoutMs: 500,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('camera proxy', () => {
  it('fetches from an allowlisted address and passes nothing of the browser on but a byte range', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const cam = await camera((req, res) => {
      seen = req.headers;
      res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-3/10' });
      res.end('abcd');
    });
    const p = proxy([`127.0.0.1:${cam.port}`]);
    const up = await p.open(`${cam.origin}/seg1.ts`, { range: 'bytes=0-3' });
    expect(up.status).toBe(206);
    expect(up.headers['content-type']).toBe('video/mp2t');
    expect(await readText(up.body, 1000)).toBe('abcd');
    expect(seen.range).toBe('bytes=0-3');
    expect(seen['user-agent']).toContain('TowerCab-test');
    expect(seen.cookie).toBeUndefined();
    expect(seen.authorization).toBeUndefined();
  });

  it('drops a malformed range instead of passing it on', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const cam = await camera((req, res) => {
      seen = req.headers;
      res.end('ok');
    });
    const up = await proxy([`127.0.0.1:${cam.port}`]).open(`${cam.origin}/x`, {
      range: 'bytes=0-1\r\nx-evil: 1',
    });
    up.close();
    expect(seen.range).toBeUndefined();
  });

  it('refuses a host that is not on the allowlist without connecting to it', async () => {
    const cam = await camera((_req, res) => res.end('secret'));
    const p = proxy(['cams.example.test']);
    await expect(p.open(`${cam.origin}/snap.jpg`)).rejects.toMatchObject({
      name: 'ProxyRefused',
      reason: 'not_allowed',
    });
    // The right address on another port is another host as far as the list goes.
    await expect(proxy([`127.0.0.1:${cam.port + 1}`]).open(`${cam.origin}/x`)).rejects.toBeInstanceOf(
      ProxyRefused,
    );
    expect(cam.hits).toEqual([]);
  });

  it('refuses everything when the allowlist is empty, and anything that is not http(s)', async () => {
    await expect(proxy([]).open('https://cams.example.test/x')).rejects.toMatchObject({
      reason: 'not_allowed',
    });
    await expect(proxy(['cams.example.test']).open('file:///etc/passwd')).rejects.toMatchObject({
      reason: 'not_allowed',
    });
    await expect(proxy(['cams.example.test']).open('not a url')).rejects.toMatchObject({ reason: 'bad_url' });
  });

  it('refuses an allowlisted name that resolves to a private address', async () => {
    const cam = await camera((_req, res) => res.end('router admin page'));
    const p = proxy([`cams.example.test:${cam.port}`], { dns: { 'cams.example.test': '127.0.0.1' } });
    await expect(p.open(`http://cams.example.test:${cam.port}/`)).rejects.toMatchObject({
      name: 'ProxyRefused',
      reason: 'private_address',
    });
    expect(cam.hits).toEqual([]);
  });

  it('allows that when the config says private addresses are fine', async () => {
    const cam = await camera((_req, res) => res.end('frame'));
    const p = proxy([`camera.lan:${cam.port}`], { allowPrivate: true, dns: { 'camera.lan': '127.0.0.1' } });
    const up = await p.open(`http://camera.lan:${cam.port}/snap.jpg`);
    expect(await readText(up.body, 100)).toBe('frame');
  });

  it('follows a redirect only to another allowlisted host', async () => {
    const target = await camera((_req, res) => res.end('moved here'));
    const elsewhere = await camera((_req, res) => res.end('internal'));
    const cam = await camera((req, res) => {
      const to = req.url === '/ok' ? `${target.origin}/final` : `${elsewhere.origin}/admin`;
      res.writeHead(302, { location: to });
      res.end();
    });
    const p = proxy([`127.0.0.1:${cam.port}`, `127.0.0.1:${target.port}`]);

    const up = await p.open(`${cam.origin}/ok`);
    expect(up.url.href).toBe(`${target.origin}/final`);
    expect(await readText(up.body, 100)).toBe('moved here');

    await expect(p.open(`${cam.origin}/elsewhere`)).rejects.toMatchObject({ reason: 'not_allowed' });
    expect(elsewhere.hits).toEqual([]);
  });

  it('gives up on a redirect loop', async () => {
    const cam = await camera((_req, res) => {
      res.writeHead(302, { location: '/again' });
      res.end();
    });
    await expect(proxy([`127.0.0.1:${cam.port}`]).open(`${cam.origin}/`)).rejects.toMatchObject({
      reason: 'too_many_redirects',
    });
    expect(cam.hits.length).toBe(4);
  });

  it('gives up on a camera that accepts the connection and then says nothing', async () => {
    const cam = await camera(() => {
      // never answers
    });
    await expect(proxy([`127.0.0.1:${cam.port}`]).open(`${cam.origin}/`)).rejects.toThrow(/no answer/);
  });

  it('signs playlist addresses per camera and rejects anything altered', () => {
    const p = proxy([]);
    const url = 'https://cams.example.test/live/seg1.ts';
    const signature = p.sign('ramp', url);
    expect(p.verify('ramp', url, signature)).toBe(true);
    expect(p.verify('ramp', 'https://cams.example.test/live/seg2.ts', signature)).toBe(false);
    expect(p.verify('other', url, signature)).toBe(false);
    expect(p.verify('ramp', url, `${signature.slice(0, -1)}x`)).toBe(false);
    expect(p.verify('ramp', url, '')).toBe(false);
    // Another process (another secret) does not accept it either.
    const other = new CameraProxy({
      rules: () => [],
      allowPrivateAddresses: () => false,
      userAgent: 'x',
    });
    expect(other.verify('ramp', url, signature)).toBe(false);
  });

  it('rewrites every address in a playlist to go through the proxy', () => {
    const p = proxy([]);
    const base = new URL('https://cams.example.test/live/ramp/index.m3u8?token=abc');
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.test/k1",IV=0x1234',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio/en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      'low/index.m3u8',
      '#EXTINF:6.0,',
      '/abs/seg1.ts',
      '#EXTINF:6.0,',
      'https://cdn.example.test/seg2.ts?sig=x&y=1',
      '#EXT-X-SESSION-DATA:DATA-ID="x",URI="data:text/plain,hi"',
      '',
    ].join('\n');
    const out = p.rewritePlaylist('ramp', playlist, base).split('\n');

    const target = (line: string) => {
      const match = /\/proxy\/camera\/ramp\/r\?u=([A-Za-z0-9_-]+)&s=([A-Za-z0-9_-]{32})/.exec(line);
      if (!match) return null;
      const url = Buffer.from(match[1] as string, 'base64url').toString();
      return p.verify('ramp', url, match[2] as string) ? url : 'BAD SIGNATURE';
    };
    expect(out[0]).toBe('#EXTM3U');
    expect(out[1]).toBe('#EXT-X-VERSION:6');
    expect(target(out[2] as string)).toBe('https://cams.example.test/live/ramp/init.mp4');
    expect(out[2]).toMatch(/^#EXT-X-MAP:URI="\/proxy\/camera\/ramp\/r\?[^"]+"$/);
    expect(target(out[3] as string)).toBe('https://keys.example.test/k1');
    expect(out[3]).toMatch(/,IV=0x1234$/);
    expect(target(out[4] as string)).toBe('https://cams.example.test/live/ramp/audio/en.m3u8');
    expect(out[4]).toContain('GROUP-ID="a",NAME="English"');
    expect(out[5]).toBe('#EXT-X-STREAM-INF:BANDWIDTH=1280000');
    expect(target(out[6] as string)).toBe('https://cams.example.test/live/ramp/low/index.m3u8');
    expect(target(out[8] as string)).toBe('https://cams.example.test/abs/seg1.ts');
    expect(target(out[10] as string)).toBe('https://cdn.example.test/seg2.ts?sig=x&y=1');
    // Inline data is left alone.
    expect(out[11]).toBe('#EXT-X-SESSION-DATA:DATA-ID="x",URI="data:text/plain,hi"');
    // Nothing of the original addresses is left for the browser to fetch directly.
    expect(out.filter((line) => !line.startsWith('#')).join('\n')).not.toContain('example.test');
  });

  it('refuses to buffer an oversized body', async () => {
    const cam = await camera((_req, res) => res.end('x'.repeat(5000)));
    const up = await proxy([`127.0.0.1:${cam.port}`]).open(`${cam.origin}/big`);
    await expect(readText(up.body, 1000)).rejects.toThrow(/larger than/);
  });
});
