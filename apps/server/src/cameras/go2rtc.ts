import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
import type { FetchLike } from '../providers/http';

export const GO2RTC_WS_PATH = '/go2rtc/api/ws';
/** The two files of go2rtc's own player, which the browser loads through this server. */
export const GO2RTC_PLAYER_FILES = ['video-rtc.js', 'video-stream.js'] as const;

export interface Go2rtcDeps {
  /** `go2rtc.url` from the config, e.g. http://go2rtc:1984. */
  url: () => string | undefined;
  /** Whether a stream name belongs to an enabled camera. */
  allowed: (stream: string) => boolean;
  userAgent: string;
  fetchImpl?: FetchLike;
  log?: { warn(obj: object, msg: string): void; debug(obj: object, msg: string): void };
  maxViewers?: number;
}

/**
 * The way from a browser to a go2rtc sidecar, for people who bring their own RTSP camera.
 *
 * go2rtc's API can change its configuration and start programs, so it is never exposed as such. Exactly
 * two things pass through: the player's two script files, and the stream WebSocket for a stream name that
 * belongs to an enabled camera. Everything stays on this app's own origin, so it works behind a reverse
 * proxy and under https without publishing go2rtc itself.
 */
export class Go2rtcBridge {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private readonly links = new Set<{ client: WebSocket; upstream: WebSocket }>();
  private readonly files = new Map<string, { body: string; at: number }>();

  constructor(private readonly deps: Go2rtcDeps) {}

  get viewers(): number {
    return this.links.size;
  }

  private base(): URL | null {
    const raw = this.deps.url();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url;
    } catch {
      return null;
    }
  }

  /** One of the player's script files, fetched from go2rtc and kept for ten minutes. */
  async playerFile(name: string): Promise<string | null> {
    if (!(GO2RTC_PLAYER_FILES as readonly string[]).includes(name)) return null;
    const base = this.base();
    if (!base) return null;
    const cached = this.files.get(name);
    if (cached && Date.now() - cached.at < 600_000) return cached.body;
    const fetchImpl = this.deps.fetchImpl ?? (globalThis.fetch as FetchLike);
    const res = await fetchImpl(new URL(name, base).href, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': this.deps.userAgent },
    });
    if (!res.ok) throw new Error(`go2rtc answered ${res.status} for ${name}`);
    const body = await res.text();
    if (body.length > 1_000_000) throw new Error(`${name} from go2rtc is unexpectedly large`);
    this.files.set(name, { body, at: Date.now() });
    return body;
  }

  /** Takes over an upgrade request for the stream WebSocket. False: not ours, the caller decides. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== GO2RTC_WS_PATH) return false;
    const refuse = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return true;
    };
    const base = this.base();
    const stream = url.searchParams.get('src') ?? '';
    // Only `src` (watching) is passed on, never `dst` (publishing into go2rtc).
    if (!base || !stream || !this.deps.allowed(stream)) return refuse('404 Not Found');
    if (this.links.size >= (this.deps.maxViewers ?? 16)) return refuse('503 Service Unavailable');

    const target = new URL('api/ws', base);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    target.search = `?src=${encodeURIComponent(stream)}`;
    this.wss.handleUpgrade(request, socket, head, (client) => this.link(client, target.href, stream));
    return true;
  }

  private link(client: WebSocket, target: string, stream: string): void {
    const upstream = new WebSocket(target, { handshakeTimeout: 5000, maxPayload: 32 * 1024 * 1024 });
    const link = { client, upstream };
    this.links.add(link);
    // What the browser says before go2rtc has answered the handshake is held back, in order.
    const early: { data: RawData; binary: boolean }[] = [];

    const end = () => {
      if (!this.links.delete(link)) return;
      for (const side of [client, upstream]) {
        if (side.readyState === WebSocket.OPEN || side.readyState === WebSocket.CONNECTING) side.terminate();
      }
    };
    upstream.on('open', () => {
      for (const message of early.splice(0)) upstream.send(message.data, { binary: message.binary });
    });
    client.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (early.length < 64) early.push({ data, binary });
    });
    upstream.on('message', (data, binary) => {
      if (client.readyState !== WebSocket.OPEN) return;
      // A viewer on a slow connection is dropped rather than buffered for without limit.
      if (client.bufferedAmount > 64 * 1024 * 1024) return end();
      client.send(data, { binary });
    });
    upstream.on('error', (err) => {
      this.deps.log?.warn({ stream, err: err.message }, 'go2rtc stream connection failed');
      end();
    });
    client.on('error', end);
    upstream.on('close', end);
    client.on('close', end);
  }

  close(): void {
    for (const link of [...this.links]) {
      link.client.terminate();
      link.upstream.terminate();
    }
    this.links.clear();
    this.wss.close();
  }
}
