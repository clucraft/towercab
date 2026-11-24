import {
  type AirportStatus,
  type DeltaMessage,
  type ErrorMessage,
  type ServerMessage,
  type SnapshotMessage,
  WS_PATH,
  WS_SILENCE_TIMEOUT_MS,
} from '@towercab/shared';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveClientHandlers {
  onSnapshot?(message: SnapshotMessage): void;
  onDelta?(message: DeltaMessage): void;
  onStatus?(icao: string, status: AirportStatus): void;
  onState?(state: ConnectionState): void;
  onError?(message: ErrorMessage): void;
}

/** The parts of the browser WebSocket this client uses. Tests pass in a fake. */
export interface SocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LiveClientOptions {
  url?: string;
  handlers?: LiveClientHandlers;
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  /** Reconnect delays grow from `minMs` to `maxMs`. */
  reconnect?: { minMs: number; maxMs: number };
  random?: () => number;
}

const OPEN = 1;
/** How many recent clock samples the server-time estimate looks at. */
const CLOCK_SAMPLES = 20;
/**
 * The clock estimate changes as samples come and go. Applied at once, a change of 20 ms would move an
 * aircraft on final by more than a metre between two frames, so the clock is slewed instead: it runs at
 * most this much fast or slow until it has caught up.
 */
const CLOCK_SLEW = 0.02;
/** A difference this large is not drift; it is a new connection or a changed clock. Jump to it. */
const CLOCK_STEP_MS = 1500;

/** `ws://` or `wss://` on the page's own host: the socket is always same-origin, so it survives a reverse proxy. */
export function defaultSocketUrl(location: { protocol: string; host: string }): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${WS_PATH}`;
}

/**
 * Connection to the server's `/ws`. Subscribes to one airport, reconnects with backoff when the connection
 * drops or goes silent, asks for a fresh snapshot when a delta is missed, and keeps an estimate of the
 * server's clock so positions can be drawn a fixed delay behind real time.
 */
export class LiveClient {
  private socket: SocketLike | null = null;
  private icao: string | null = null;
  private currentState: ConnectionState = 'closed';
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSeq: number | null = null;
  private clockOffsets: number[] = [];
  /** The offset actually in use, which follows the estimate smoothly, and when it was last advanced. */
  private appliedOffset: number | null = null;
  private appliedAt = 0;
  private stopped = true;

  private readonly url: string;
  private readonly handlers: LiveClientHandlers;
  private readonly now: () => number;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly reconnect: { minMs: number; maxMs: number };
  private readonly random: () => number;

  constructor(options: LiveClientOptions = {}) {
    this.url = options.url ?? defaultSocketUrl(globalThis.location);
    this.handlers = options.handlers ?? {};
    this.now = options.now ?? Date.now;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.reconnect = options.reconnect ?? { minMs: 1000, maxMs: 15_000 };
    this.random = options.random ?? Math.random;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  /** Starts (or switches) the subscription. Connects if not connected yet. */
  subscribe(icao: string): void {
    this.icao = icao.toUpperCase();
    this.lastSeq = null;
    this.stopped = false;
    if (this.socket && this.socket.readyState === OPEN) this.sendSubscribe();
    else if (!this.socket) this.connect();
  }

  /** Closes the connection for good. */
  close(): void {
    this.stopped = true;
    this.icao = null;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.close();
    }
    this.setState('closed');
  }

  /**
   * The server's clock, estimated from message timestamps. Every message is stamped when it is sent, so
   * `stamp - arrival time` is the clock difference minus the network delay; the largest recent value is
   * the one that travelled fastest and is the best estimate.
   */
  serverNow(): number {
    const now = this.now();
    const target = this.clockOffset();
    if (this.appliedOffset === null || Math.abs(target - this.appliedOffset) > CLOCK_STEP_MS) {
      this.appliedOffset = target;
    } else {
      const allowance = Math.max(0, now - this.appliedAt) * CLOCK_SLEW;
      const difference = target - this.appliedOffset;
      this.appliedOffset += Math.max(-allowance, Math.min(allowance, difference));
    }
    this.appliedAt = now;
    return now + this.appliedOffset;
  }

  /** The current best estimate of server clock minus local clock, milliseconds. */
  clockOffset(): number {
    if (this.clockOffsets.length === 0) return 0;
    return Math.max(...this.clockOffsets);
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempts = 0;
      this.setState('open');
      this.armSilenceTimer();
      this.sendSubscribe();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.armSilenceTimer();
      if (typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.handle(message);
    };
    socket.onerror = () => {
      // A close event always follows; reconnection is handled there.
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private handle(message: ServerMessage): void {
    if (typeof message.serverTime === 'number') {
      this.clockOffsets.push(message.serverTime - this.now());
      if (this.clockOffsets.length > CLOCK_SAMPLES) this.clockOffsets.shift();
    }
    switch (message.type) {
      case 'snapshot':
        if (message.icao !== this.icao) return;
        this.lastSeq = message.seq;
        this.handlers.onSnapshot?.(message);
        this.handlers.onStatus?.(message.icao, message.status);
        break;
      case 'delta':
        if (message.icao !== this.icao || this.lastSeq === null) return;
        // An older delta can arrive just after a snapshot that already includes it.
        if (message.seq <= this.lastSeq) return;
        if (message.seq !== this.lastSeq + 1) {
          // Something was missed. Ask for the full picture again rather than guessing.
          this.lastSeq = null;
          this.sendSubscribe();
          return;
        }
        this.lastSeq = message.seq;
        this.handlers.onDelta?.(message);
        break;
      case 'status':
        if (message.icao === this.icao) this.handlers.onStatus?.(message.icao, message.status);
        break;
      case 'ping':
        this.send({ type: 'pong', t: message.serverTime });
        break;
      case 'error':
        this.handlers.onError?.(message);
        break;
      case 'hello':
        break;
    }
  }

  private sendSubscribe(): void {
    if (this.icao) this.send({ type: 'subscribe', icao: this.icao });
  }

  private send(message: object): void {
    if (this.socket && this.socket.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    if (this.stopped) return;
    this.setState('reconnecting');
    const exponential = Math.min(this.reconnect.maxMs, this.reconnect.minMs * 2 ** this.attempts);
    // Up to 30% extra, so many tabs do not all come back in the same instant after a server restart.
    const delay = Math.round(exponential * (1 + 0.3 * this.random()));
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** The server pings every 20 s. Nothing at all for 45 s means the connection is dead, whatever it claims. */
  private armSilenceTimer(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      const socket = this.socket;
      if (!socket) return;
      this.socket = null;
      socket.onclose = null;
      socket.close();
      this.scheduleReconnect();
    }, WS_SILENCE_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.reconnectTimer = null;
    this.silenceTimer = null;
  }

  private setState(state: ConnectionState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.handlers.onState?.(state);
  }
}
