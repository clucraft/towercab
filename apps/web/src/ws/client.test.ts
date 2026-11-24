import type { Aircraft, AirportStatus, ServerMessage } from '@towercab/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConnectionState, defaultSocketUrl, LiveClient, type SocketLike } from './client';

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // Test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

const status: AirportStatus = { pollState: 'active', viewers: 1, providers: [] };
const aircraft = (hex: string): Aircraft => ({
  hex,
  addrType: 'adsb_icao',
  lat: 40.41,
  lon: -86.94,
  posTime: 0,
  seenTime: 0,
  altSource: 'geom',
  onGround: false,
  phase: 'pattern',
  source: 'adsbfi',
});

describe('LiveClient', () => {
  let states: ConnectionState[];
  let snapshots: number[];
  let deltas: number[];

  const make = () =>
    new LiveClient({
      url: 'ws://tower.test/ws',
      createSocket: (url) => new FakeSocket(url),
      random: () => 0,
      handlers: {
        onState: (s) => states.push(s),
        onSnapshot: (m) => snapshots.push(m.seq),
        onDelta: (m) => deltas.push(m.seq),
      },
    });
  const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;
  const snapshot = (seq: number, icao = 'KLAF'): ServerMessage => ({
    type: 'snapshot',
    serverTime: Date.now(),
    icao,
    seq,
    aircraft: [aircraft('a00001')],
    trails: {},
    status,
  });
  const delta = (seq: number, icao = 'KLAF'): ServerMessage => ({
    type: 'delta',
    serverTime: Date.now(),
    icao,
    seq,
    upserts: [],
    removed: [],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    FakeSocket.instances = [];
    states = [];
    snapshots = [];
    deltas = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a same-origin socket URL, secure when the page is', () => {
    expect(defaultSocketUrl({ protocol: 'https:', host: 'towercab.example.test' })).toBe(
      'wss://towercab.example.test/ws',
    );
    expect(defaultSocketUrl({ protocol: 'http:', host: 'localhost:8790' })).toBe('ws://localhost:8790/ws');
  });

  it('connects, subscribes and passes the snapshot and deltas on', () => {
    const client = make();
    client.subscribe('klaf');
    expect(states).toEqual(['connecting']);
    latest().open();
    expect(latest().sent).toEqual([{ type: 'subscribe', icao: 'KLAF' }]);
    latest().receive(snapshot(4));
    latest().receive(delta(5));
    latest().receive(delta(6));
    expect(states).toEqual(['connecting', 'open']);
    expect(snapshots).toEqual([4]);
    expect(deltas).toEqual([5, 6]);
    client.close();
  });

  it('ignores deltas before the snapshot, duplicates, and messages for another airport', () => {
    const client = make();
    client.subscribe('KLAF');
    latest().open();
    latest().receive(delta(9));
    latest().receive(snapshot(10));
    latest().receive(delta(10)); // already part of the snapshot
    latest().receive(delta(11, 'KIND'));
    latest().receive(delta(11));
    expect(deltas).toEqual([11]);
    client.close();
  });

  it('asks for a fresh snapshot when a delta goes missing', () => {
    const client = make();
    client.subscribe('KLAF');
    latest().open();
    latest().receive(snapshot(1));
    latest().receive(delta(2));
    latest().receive(delta(4)); // 3 was lost
    expect(deltas).toEqual([2]);
    expect(latest().sent.filter((m) => m.type === 'subscribe')).toHaveLength(2);
    // Nothing is applied until the new snapshot arrives.
    latest().receive(delta(5));
    expect(deltas).toEqual([2]);
    latest().receive(snapshot(5));
    latest().receive(delta(6));
    expect(deltas).toEqual([2, 6]);
    client.close();
  });

  it('answers the server ping', () => {
    const client = make();
    client.subscribe('KLAF');
    latest().open();
    latest().receive({ type: 'ping', serverTime: 42 });
    expect(latest().sent).toContainEqual({ type: 'pong', t: 42 });
    client.close();
  });

  it('reconnects with growing delays and resubscribes', () => {
    const client = make();
    client.subscribe('KLAF');
    latest().open();
    latest().drop();
    expect(states).toEqual(['connecting', 'open', 'reconnecting']);

    const waits = [1000, 2000, 4000, 8000, 15_000, 15_000];
    for (const wait of waits) {
      const before = FakeSocket.instances.length;
      vi.advanceTimersByTime(wait - 1);
      expect(FakeSocket.instances.length, `before ${wait}`).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances.length, `after ${wait}`).toBe(before + 1);
      latest().drop();
    }

    // Once a connection succeeds the delay starts over.
    vi.advanceTimersByTime(15_000);
    latest().open();
    expect(latest().sent).toEqual([{ type: 'subscribe', icao: 'KLAF' }]);
    expect(client.state).toBe('open');
    latest().drop();
    vi.advanceTimersByTime(1000);
    expect(latest().readyState).toBe(0);
    client.close();
  });

  it('treats 45 s of silence as a dead connection', () => {
    const client = make();
    client.subscribe('KLAF');
    const first = latest();
    first.open();
    first.receive(snapshot(1));
    vi.advanceTimersByTime(44_000);
    first.receive({ type: 'ping', serverTime: Date.now() });
    vi.advanceTimersByTime(44_000);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(first.closed).toBe(true);
    expect(client.state).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(latest()).not.toBe(first);
    client.close();
  });

  it('switches airport on the same connection', () => {
    const client = make();
    client.subscribe('KLAF');
    latest().open();
    latest().receive(snapshot(7));
    client.subscribe('KIND');
    expect(latest().sent[latest().sent.length - 1]).toEqual({ type: 'subscribe', icao: 'KIND' });
    latest().receive(delta(8)); // still KLAF: ignored
    latest().receive(snapshot(3, 'KIND'));
    latest().receive(delta(4, 'KIND'));
    expect(snapshots).toEqual([7, 3]);
    expect(deltas).toEqual([4]);
    expect(FakeSocket.instances).toHaveLength(1);
    client.close();
  });

  it('stops for good on close', () => {
    const client = make();
    client.subscribe('KLAF');
    latest().open();
    client.close();
    expect(latest().closed).toBe(true);
    expect(client.state).toBe('closed');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('estimates the server clock from the fastest recent message', () => {
    const client = make();
    client.subscribe('KLAF');
    latest().open();
    expect(client.clockOffset()).toBe(0);
    // The server clock is 5 s ahead; messages take 80, 20 and 300 ms to arrive.
    for (const latency of [80, 20, 300]) {
      latest().receive({ type: 'ping', serverTime: Date.now() + 5000 - latency });
    }
    expect(client.clockOffset()).toBe(4980);
    expect(client.serverNow()).toBe(Date.now() + 4980);
    client.close();
  });
});
