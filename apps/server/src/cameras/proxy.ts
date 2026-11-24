import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { type HostRule, isPublicAddress, matchRule } from './allowlist';

/** Why the proxy would not fetch something. `status` is what the browser is told. */
export class ProxyRefused extends Error {
  constructor(
    readonly reason: 'bad_url' | 'not_allowed' | 'private_address' | 'too_many_redirects',
    message: string,
  ) {
    super(message);
    this.name = 'ProxyRefused';
  }
}

export interface ProxyOptions {
  /** The parsed `proxy.allowlist`, read on every request so that config changes apply at once. */
  rules(): readonly HostRule[];
  /** `proxy.allowPrivateAddresses`: let an allowlisted name resolve to an address on a private network. */
  allowPrivateAddresses(): boolean;
  userAgent: string;
  /** DNS lookup, replaceable in tests. */
  lookup?: typeof dnsLookup;
  /** Signs sub-resource URLs. Random per process unless given. */
  secret?: Buffer;
  /** Give up when the camera sends nothing for this long. */
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface Upstream {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: http.IncomingMessage;
  /** Where the response came from, after redirects. Relative addresses in a playlist are relative to this. */
  url: URL;
  close(): void;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const SIGNATURE_LENGTH = 32;

/**
 * Fetches camera media on a browser's behalf, for cameras whose own server does not allow the browser to
 * (no CORS headers, or plain http behind an https page).
 *
 * It is not a general proxy and must never become one:
 * - only `GET`, only http and https, only hosts on the allowlist, redirects re-checked at every hop;
 * - an allowlisted name may not resolve to a private address (checked at the moment of connecting, so the
 *   name cannot be pointed elsewhere between check and use), unless the config says so;
 * - the browser never supplies a URL of its own: it asks for a camera by id, or for an address the server
 *   itself wrote into that camera's playlist and signed.
 */
export class CameraProxy {
  private readonly secret: Buffer;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly guardedLookup: LookupFunction;

  constructor(private readonly options: ProxyOptions) {
    this.secret = options.secret ?? randomBytes(32);
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRedirects = options.maxRedirects ?? 3;
    const lookup = options.lookup ?? dnsLookup;

    this.guardedLookup = (hostname, lookupOptions, callback) => {
      lookup(hostname, lookupOptions, (err, address, family) => {
        if (err) return callback(err, address as string, family);
        const found: string[] = Array.isArray(address)
          ? (address as LookupAddress[]).map((a) => a.address)
          : [address as string];
        const offender = found.find((a) => !isPublicAddress(a));
        if (offender !== undefined && !options.allowPrivateAddresses()) {
          return callback(
            new ProxyRefused(
              'private_address',
              `${hostname} resolves to ${offender}, which is not a public address. ` +
                'List the address itself in proxy.allowlist, or set proxy.allowPrivateAddresses.',
            ),
            address as string,
            family,
          );
        }
        callback(null, address as string, family);
      });
    };
  }

  /** Opens an allowlisted URL. Rejects with `ProxyRefused` when policy forbids it. */
  async open(
    target: string | URL,
    request: { range?: string; signal?: AbortSignal } = {},
  ): Promise<Upstream> {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new ProxyRefused('bad_url', 'The camera address is not a valid URL.');
    }
    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      const rule = matchRule(url, this.options.rules());
      if (!rule) {
        throw new ProxyRefused('not_allowed', `${url.host} is not on proxy.allowlist.`);
      }
      const response = await this.request(url, rule, request);
      const location = response.headers.location;
      if (!REDIRECTS.has(response.statusCode ?? 0) || !location) {
        return {
          status: response.statusCode ?? 502,
          headers: response.headers,
          body: response,
          url,
          close: () => response.destroy(),
        };
      }
      response.destroy();
      try {
        url = new URL(location, url);
      } catch {
        throw new ProxyRefused('bad_url', 'The camera redirected to an invalid address.');
      }
    }
    throw new ProxyRefused('too_many_redirects', 'The camera redirected too many times.');
  }

  private request(
    url: URL,
    rule: HostRule,
    { range, signal }: { range?: string; signal?: AbortSignal },
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { 'user-agent': this.options.userAgent, accept: '*/*' };
      // A byte range is the only thing passed on from the browser's request.
      if (range && /^bytes=[\d,\s-]{1,200}$/.test(range)) headers.range = range;
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'GET',
        headers,
        // One connection per request; nothing is kept open towards the camera after the response ends.
        agent: false,
        signal,
        // A literal address was listed as such; a name is resolved under guard.
        lookup: rule.isAddress ? undefined : this.guardedLookup,
      });
      req.setTimeout(this.timeoutMs, () => req.destroy(new Error(`no answer within ${this.timeoutMs} ms`)));
      req.once('response', resolve);
      req.once('error', reject);
      req.end();
    });
  }

  /** Signs an address the server wrote into a playlist, so only such addresses can be asked for later. */
  sign(cameraId: string, url: string): string {
    return createHmac('sha256', this.secret)
      .update(`${cameraId}\n${url}`)
      .digest('base64url')
      .slice(0, SIGNATURE_LENGTH);
  }

  verify(cameraId: string, url: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(cameraId, url));
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** The path under which the browser can fetch one address from a camera's playlist. */
  resourcePath(cameraId: string, url: URL): string {
    const href = url.href;
    const u = Buffer.from(href).toString('base64url');
    return `/proxy/camera/${encodeURIComponent(cameraId)}/r?u=${u}&s=${this.sign(cameraId, href)}`;
  }

  /**
   * Rewrites an HLS playlist so that everything it refers to (variant playlists, segments, keys, init
   * sections) is fetched through the proxy as well.
   */
  rewritePlaylist(cameraId: string, text: string, base: URL): string {
    const through = (reference: string): string => {
      let url: URL;
      try {
        url = new URL(reference, base);
      } catch {
        return reference;
      }
      // Inline data stays as it is; anything else that is not http(s) cannot be fetched anyway.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return reference;
      return this.resourcePath(cameraId, url);
    };
    return text
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed === '') return line;
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]*)"/g, (_match, uri: string) => `URI="${through(uri)}"`);
        }
        return through(trimmed);
      })
      .join('\n');
  }
}

/** Reads a response body as text, refusing to buffer more than `maxBytes`. */
export async function readText(body: http.IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      body.destroy();
      throw new Error(`the response is larger than ${maxBytes} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
