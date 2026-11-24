import { connect, type Socket } from 'node:net';
import { distanceNm } from '@towercab/shared';
import { type FetchLike, fetchJson } from './http';
import { parseReadsbResponse, parseReadsbStreamLine } from './readsb';
import { type AdsbSource, type FetchResult, type Observation, ProviderError } from './types';

export interface ReadsbLocalOptions {
  /** `aircraft.json` URL of a tar1090 / ultrafeeder instance. */
  url: string;
  /** Optional JSON position stream (`--net-json-port`). Used instead of polling when set. */
  stream?: { host: string; port: number };
  userAgent: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** A position this old is no longer worth showing. Matches readsb's own 60 s cut-off. */
const STREAM_MAX_AGE_MS = 60_000;
/** Close the stream when nothing has asked for data for this long, so an idle server holds no sockets. */
const STREAM_IDLE_CLOSE_MS = 120_000;
const STREAM_RECONNECT_MIN_MS = 1000;
const STREAM_RECONNECT_MAX_MS = 30_000;

/**
 * Your own receiver. A receiver reports everything it hears, so results are cut down to the requested
 * radius here.
 */
export function createReadsbLocalSource(options: ReadsbLocalOptions): AdsbSource {
  const now = options.now ?? Date.now;
  const stream = options.stream ? new ReadsbStream(options.stream, now, options.log) : null;

  return {
    id: 'readsb',
    label: 'Local receiver',
    async fetchArea(lat, lon, radiusNm, signal): Promise<FetchResult> {
      let observations: Observation[];
      let receivedAt: number;
      if (stream) {
        observations = stream.read();
        receivedAt = now();
      } else {
        const res = await fetchJson({
          url: options.url,
          userAgent: options.userAgent,
          signal,
          fetchImpl: options.fetchImpl,
          now,
          timeoutMs: 4000,
        });
        observations = parseReadsbResponse(res.json, res.receivedAt, 'readsb');
        receivedAt = res.receivedAt;
      }
      return {
        observations: observations.filter((o) => distanceNm(lat, lon, o.lat, o.lon) <= radiusNm),
        receivedAt,
      };
    },
    close() {
      stream?.close();
    },
  };
}

/**
 * Client for readsb's JSON position stream: newline-delimited aircraft objects, one per received position.
 * Connects on first use, reconnects with backoff, and disconnects again when nobody is reading.
 */
class ReadsbStream {
  private socket: Socket | null = null;
  private buffer = '';
  private latest = new Map<string, Observation>();
  private reconnectDelay = STREAM_RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private everConnected = false;
  private closed = false;

  constructor(
    private readonly target: { host: string; port: number },
    private readonly now: () => number,
    private readonly log?: ReadsbLocalOptions['log'],
  ) {}

  /** Latest position per aircraft. Throws while the stream has never delivered anything. */
  read(): Observation[] {
    this.touch();
    if (!this.socket && !this.reconnectTimer) this.open();
    if (!this.everConnected) {
      throw new ProviderError(
        'network',
        this.lastError ?? `connecting to ${this.target.host}:${this.target.port}`,
      );
    }
    const cutoff = this.now() - STREAM_MAX_AGE_MS;
    const out: Observation[] = [];
    for (const [hex, obs] of this.latest) {
      if (obs.posTime < cutoff) this.latest.delete(hex);
      else out.push(obs);
    }
    return out;
  }

  close(): void {
    this.closed = true;
    this.teardown();
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.teardown(), STREAM_IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private teardown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.idleTimer = null;
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
    this.latest.clear();
    this.everConnected = false;
  }

  private open(): void {
    if (this.closed) return;
    const socket = connect({ host: this.target.host, port: this.target.port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);
    socket.on('connect', () => {
      this.everConnected = true;
      this.lastError = null;
      this.reconnectDelay = STREAM_RECONNECT_MIN_MS;
      this.log?.info(this.target, 'readsb JSON stream connected');
    });
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('error', (err) => {
      this.lastError = err.message;
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.buffer = '';
      if (this.closed || !this.idleTimer) return;
      this.log?.warn(
        { ...this.target, err: this.lastError, retryInMs: this.reconnectDelay },
        'readsb JSON stream closed',
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.open();
      }, this.reconnectDelay);
      this.reconnectTimer.unref();
      this.reconnectDelay = Math.min(STREAM_RECONNECT_MAX_MS, this.reconnectDelay * 2);
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // A line longer than this is not a readsb aircraft object; drop it rather than grow without bound.
    if (this.buffer.length > 1_000_000) this.buffer = '';
    let newline = this.buffer.indexOf('\n');
    const receivedAt = this.now();
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const obs = parseReadsbStreamLine(line, receivedAt, 'readsb');
      if (obs) {
        const previous = this.latest.get(obs.hex);
        if (!previous || obs.posTime >= previous.posTime) this.latest.set(obs.hex, obs);
      }
      newline = this.buffer.indexOf('\n');
    }
  }
}
