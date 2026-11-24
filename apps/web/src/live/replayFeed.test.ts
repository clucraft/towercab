import type { Aircraft, DeltaMessage, ServerMessage, SnapshotMessage } from '@towercab/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRecording, replayFeed, shiftMessage } from './replayFeed';

const T0 = 1_795_000_000_000; // when the session was recorded
const aircraft = (hex: string, posTime: number, lat = 40.41): Aircraft => ({
  hex,
  addrType: 'adsb_icao',
  lat,
  lon: -86.94,
  posTime,
  seenTime: posTime + 100,
  altSource: 'geom',
  onGround: false,
  heightM: 400,
  phase: 'pattern',
  source: 'adsblol',
});
const status = {
  pollState: 'active' as const,
  viewers: 1,
  lastPollAt: T0,
  providers: [
    {
      id: 'adsblol',
      label: 'adsb.lol',
      enabled: true,
      state: 'ok' as const,
      priority: 1,
      requests: 1,
      failures: 0,
      rateLimited: 0,
      lastSuccessAt: T0 - 500,
    },
  ],
};
const snapshot: SnapshotMessage = {
  type: 'snapshot',
  serverTime: T0,
  icao: 'KLAF',
  seq: 41,
  aircraft: [aircraft('a00001', T0 - 400)],
  trails: { a00001: [[T0 - 4400, 40.4, -86.94, 390]] },
  status,
};
const delta = (n: number): DeltaMessage => ({
  type: 'delta',
  serverTime: T0 + n * 2000,
  icao: 'KLAF',
  seq: 41 + n,
  upserts: [aircraft('a00001', T0 + n * 2000 - 400, 40.41 + n * 0.001)],
  removed: n === 3 ? ['a00002'] : [],
});
const meta = {
  type: 'meta',
  version: 1,
  airport: 'KLAF',
  recordedAt: T0,
  sources: ['adsb.lol'],
  license: 'ODbL 1.0',
};
const file = [meta, snapshot, delta(1), delta(2), delta(3)].map((m) => JSON.stringify(m)).join('\n');

describe('parseRecording', () => {
  it('reads the meta line and the messages', () => {
    const recording = parseRecording(`${file}\n\n`);
    expect(recording.meta).toMatchObject({ airport: 'KLAF', license: 'ODbL 1.0' });
    expect(recording.messages.map((m) => m.type)).toEqual(['snapshot', 'delta', 'delta', 'delta']);
  });

  it('skips damaged lines and anything before the first snapshot', () => {
    const text = [
      JSON.stringify(meta),
      JSON.stringify(delta(0)),
      '{broken',
      JSON.stringify({ type: 'ping', serverTime: 1 }),
      JSON.stringify(snapshot),
      JSON.stringify(delta(1)),
    ].join('\n');
    expect(parseRecording(text).messages.map((m) => m.type)).toEqual(['snapshot', 'delta']);
  });

  it('refuses a file that is not a recording', () => {
    expect(() => parseRecording('hello')).toThrow(/not a TowerCab recording/);
    expect(() => parseRecording(JSON.stringify(meta))).toThrow();
    expect(() => parseRecording(JSON.stringify(snapshot))).toThrow();
  });
});

describe('shiftMessage', () => {
  it('moves every timestamp by the same amount and relabels the source', () => {
    const shifted = shiftMessage(snapshot, 1000, 0) as SnapshotMessage;
    expect(shifted.serverTime).toBe(T0 + 1000);
    expect(shifted.seq).toBe(0);
    expect(shifted.aircraft[0]).toMatchObject({
      posTime: T0 + 600,
      seenTime: T0 + 700,
      source: 'replay',
      lat: 40.41,
    });
    expect(shifted.trails.a00001?.[0]).toEqual([T0 - 3400, 40.4, -86.94, 390]);
    expect(shifted.status.lastPollAt).toBe(T0 + 1000);
    expect(shifted.status.providers[0]?.lastSuccessAt).toBe(T0 + 500);
    // The original is untouched, so a recording can be played again.
    expect(snapshot.aircraft[0]?.posTime).toBe(T0 - 400);
  });
});

describe('replayFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 86_400_000 * 30); // a month later
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const start = async (text = file) => {
    const received: ServerMessage[] = [];
    const states: string[] = [];
    const errors: string[] = [];
    const feed = replayFeed('klaf-pattern', { load: async () => text, loopGapMs: 1000 })({
      onState: (s) => states.push(s),
      onSnapshot: (m) => received.push(m),
      onDelta: (m) => received.push(m),
      onError: (m) => errors.push(m.message),
    });
    feed.start('KLAF');
    await vi.advanceTimersByTimeAsync(0);
    return { feed, received, states, errors };
  };

  it('plays the recording at its original pace, moved to the present', async () => {
    const { feed, received, states } = await start();
    const began = Date.now();
    expect(states).toEqual(['connecting', 'open']);
    expect(received.map((m) => m.type)).toEqual(['snapshot']);
    const first = received[0] as SnapshotMessage;
    expect(first.serverTime).toBe(began);
    // The position is 400 ms old now, as it was when recorded.
    expect(first.aircraft[0]?.posTime).toBe(began - 400);
    expect(first.seq).toBe(0);

    await vi.advanceTimersByTimeAsync(1900);
    expect(received).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(received).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(received.map((m) => m.type)).toEqual(['snapshot', 'delta', 'delta', 'delta']);
    const deltas = received.slice(1) as DeltaMessage[];
    // Renumbered from the snapshot, so the client sees no gap.
    expect(deltas.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(deltas[2]?.upserts[0]?.posTime).toBe(began + 6000 - 400);
    expect(deltas[2]?.removed).toEqual(['a00002']);
    expect(feed.serverNow()).toBe(Date.now());
    feed.stop();
  });

  it('starts over when it reaches the end, with time still moving forwards', async () => {
    const { feed, received } = await start();
    await vi.advanceTimersByTimeAsync(6100);
    expect(received).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1200);
    expect(received.map((m) => m.type)).toEqual(['snapshot', 'delta', 'delta', 'delta', 'snapshot']);
    const again = received[4] as SnapshotMessage;
    expect(again.seq).toBe(0);
    // Positions in the second lap are newer than anything in the first.
    const lastOfFirstLap = (received[3] as DeltaMessage).upserts[0]?.posTime ?? 0;
    expect(again.aircraft[0]?.posTime).toBeGreaterThan(lastOfFirstLap);
    await vi.advanceTimersByTimeAsync(2100);
    expect((received[5] as DeltaMessage).seq).toBe(1);
    feed.stop();
  });

  it('asks the scene to draw further behind when the recorded positions are far apart', async () => {
    const live = await start();
    expect(live.feed.renderDelayMs?.()).toBeUndefined();
    live.feed.stop();
    const sparse = file.replace('"license":"ODbL 1.0"', '"license":"ODbL 1.0","intervalMs":7000');
    const slow = await start(sparse);
    expect(slow.feed.renderDelayMs?.()).toBe(8500);
    slow.feed.stop();
  });

  it('stops cleanly', async () => {
    const { feed, received, states } = await start();
    feed.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(received).toHaveLength(1);
    expect(states[states.length - 1]).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a missing or broken recording instead of playing nothing silently', async () => {
    const broken = await start('not a recording');
    expect(broken.errors[0]).toMatch(/not a TowerCab recording/);
    expect(broken.states).toEqual(['connecting', 'closed']);

    const errors: string[] = [];
    const feed = replayFeed('nope', {
      load: async () => {
        throw new Error('there is no recording called "nope"');
      },
    })({ onError: (m) => errors.push(m.message) });
    feed.start('KLAF');
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(['there is no recording called "nope"']);
  });
});
