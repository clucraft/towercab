import type {
  Aircraft,
  AirportStatus,
  DeltaMessage,
  ErrorMessage,
  SnapshotMessage,
  TrailPoint,
} from '@towercab/shared';
import { type ConnectionState, LiveClient, type LiveClientHandlers } from '../ws/client';

/** Where live data comes from: the server's WebSocket, a simulator, or a recording being replayed. */
export interface Feed {
  start(icao: string): void;
  stop(): void;
  /** The clock positions are stamped with. */
  serverNow(): number;
}

export type FeedFactory = (handlers: LiveClientHandlers) => Feed;

/** The normal feed: the server's `/ws`. */
export const webSocketFeed: FeedFactory = (handlers) => {
  const client = new LiveClient({ handlers });
  return {
    start: (icao) => client.subscribe(icao),
    stop: () => client.close(),
    serverNow: () => client.serverNow(),
  };
};

export interface StoreListener {
  onSnapshot?(message: SnapshotMessage): void;
  onDelta?(message: DeltaMessage): void;
}

/**
 * The browser's copy of one airport's live traffic.
 *
 * Two kinds of consumer read it. The 3D scene listens to every message so it can move aircraft frame by
 * frame. React panels subscribe to a change counter, which ticks at most twice a second however fast
 * messages arrive, and read the current state when it does.
 */
export class LiveStore {
  readonly aircraft = new Map<string, Aircraft>();
  trails: Record<string, TrailPoint[]> = {};
  status: AirportStatus | null = null;
  connection: ConnectionState = 'connecting';
  error: ErrorMessage | null = null;

  private readonly feed: Feed;
  private readonly messageListeners = new Set<StoreListener>();
  private readonly changeListeners = new Set<() => void>();
  private version = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly icao: string,
    factory: FeedFactory = webSocketFeed,
  ) {
    this.feed = factory({
      onState: (state) => {
        this.connection = state;
        this.changed(true);
      },
      onSnapshot: (message) => {
        this.aircraft.clear();
        for (const a of message.aircraft) this.aircraft.set(a.hex, a);
        this.trails = message.trails;
        this.error = null;
        for (const listener of this.messageListeners) listener.onSnapshot?.(message);
        this.changed(true);
      },
      onDelta: (message) => {
        for (const a of message.upserts) this.aircraft.set(a.hex, a);
        for (const hex of message.removed) this.aircraft.delete(hex);
        for (const listener of this.messageListeners) listener.onDelta?.(message);
        this.changed(false);
      },
      onStatus: (_icao, status) => {
        this.status = status;
        this.changed(false);
      },
      onError: (message) => {
        this.error = message;
        this.changed(true);
      },
    });
  }

  start(): void {
    this.feed.start(this.icao);
  }

  stop(): void {
    this.feed.stop();
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    this.messageListeners.clear();
    this.changeListeners.clear();
  }

  serverNow(): number {
    return this.feed.serverNow();
  }

  /** Every snapshot and delta, as it arrives. For the scene. */
  listen(listener: StoreListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  /** For React's `useSyncExternalStore`. */
  subscribe = (onChange: () => void): (() => void) => {
    this.changeListeners.add(onChange);
    return () => this.changeListeners.delete(onChange);
  };

  getVersion = (): number => this.version;

  private changed(immediately: boolean): void {
    if (immediately) {
      if (this.notifyTimer) clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
      this.version += 1;
      for (const listener of this.changeListeners) listener();
      return;
    }
    this.notifyTimer ??= setTimeout(() => {
      this.notifyTimer = null;
      this.version += 1;
      for (const listener of this.changeListeners) listener();
    }, 500);
  }
}
