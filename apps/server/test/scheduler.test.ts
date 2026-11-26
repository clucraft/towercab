import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollingConfig } from '../src/config/schema';
import { ManagedProvider, type ManagedProviderOptions } from '../src/providers/managed';
import { type Observation, ProviderError } from '../src/providers/types';
import { Backoff } from '../src/scheduler/backoff';
import { AirportPoller, type PollTarget } from '../src/scheduler/poller';
import { TokenBucket } from '../src/scheduler/tokenBucket';
import { FakeSource, maxGap, minGap, obs } from './helpers';

describe('TokenBucket', () => {
  it('starts full, then allows one request per interval', () => {
    const bucket = new TokenBucket(1, 1000, 0);
    expect(bucket.waitMs(0)).toBe(0);
    expect(bucket.take(0)).toBe(0);
    expect(bucket.waitMs(0)).toBe(1000);
    expect(bucket.waitMs(400)).toBe(600);
    expect(bucket.waitMs(1000)).toBe(0);
  });

  it('reserves future tokens so two callers are never given the same one', () => {
    const bucket = new TokenBucket(1, 1000, 0);
    expect(bucket.take(0)).toBe(0);
    expect(bucket.take(0)).toBe(1000);
    expect(bucket.take(0)).toBe(2000);
    expect(bucket.waitMs(2999)).toBe(1);
    expect(bucket.waitMs(3000)).toBe(0);
  });

  it('never holds more than its capacity, however long it sits idle', () => {
    const bucket = new TokenBucket(2, 1000, 0);
    expect(bucket.take(60_000)).toBe(0);
    expect(bucket.take(60_000)).toBe(0);
    expect(bucket.take(60_000)).toBe(1000);
  });

  it('can be slowed down without losing what it has earned', () => {
    const bucket = new TokenBucket(1, 1000, 0);
    bucket.take(0);
    bucket.setRefillInterval(10_000, 500); // half a token earned so far
    expect(bucket.waitMs(500)).toBe(5000);
    expect(() => new TokenBucket(0, 1000, 0)).toThrow(RangeError);
    expect(() => bucket.setRefillInterval(0, 0)).toThrow(RangeError);
  });
});

describe('Backoff', () => {
  const backoff = () => new Backoff({ baseMs: 2000, maxMs: 300_000, jitter: 0 });

  it('doubles after every failure up to the cap, and resets on success', () => {
    const b = backoff();
    expect([1, 2, 3, 4].map(() => b.fail('server'))).toEqual([2000, 4000, 8000, 16_000]);
    for (let i = 0; i < 10; i += 1) b.fail('server');
    expect(b.fail('server')).toBe(300_000);
    b.succeed();
    expect(b.consecutiveFailures).toBe(0);
    expect(b.fail('network')).toBe(2000);
  });

  it('honours Retry-After when it is longer than the computed delay', () => {
    expect(backoff().fail('server', 45_000)).toBe(45_000);
    expect(backoff().fail('server', 500)).toBe(2000);
  });

  it('waits at least 30 s after a 429, an hour after a refusal, ten minutes after a bad request', () => {
    expect(backoff().fail('rate_limited')).toBe(30_000);
    expect(backoff().fail('rate_limited', 120_000)).toBe(120_000);
    expect(backoff().fail('forbidden')).toBe(3_600_000);
    expect(backoff().fail('bad_request')).toBe(600_000);
  });

  it('adds jitter on top of the delay, never below it', () => {
    const b = new Backoff({ baseMs: 2000, jitter: 0.2, random: () => 1 });
    expect(b.fail('server')).toBe(2400);
  });
});

describe('ManagedProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = (id: 'adsbfi' | 'adsblol' | 'opensky', options: Partial<ManagedProviderOptions> = {}) => {
    const source = new FakeSource(id);
    const provider = new ManagedProvider(source, {
      enabled: true,
      priority: 1,
      limits: { minIntervalMs: 1100 },
      random: () => 0,
      ...options,
    });
    return { source, provider };
  };

  it('allows one request per minimum interval', async () => {
    const { provider } = make('adsbfi');
    expect(await provider.acquire()).toBe(true);
    expect(await provider.acquire()).toBe(false);
    expect(provider.waitMs()).toBe(1100);
    vi.advanceTimersByTime(1100);
    expect(await provider.acquire()).toBe(true);
  });

  it('lets a slightly early caller wait for its token instead of skipping', async () => {
    const { provider } = make('adsbfi');
    await provider.acquire();
    vi.advanceTimersByTime(800);
    const pending = provider.acquire(500);
    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(true);
  });

  it('reports health as it goes: idle, ok, backoff after a failure, ok again', async () => {
    const { source, provider } = make('adsbfi');
    expect(provider.health()).toMatchObject({ id: 'adsbfi', state: 'idle', requests: 0, enabled: true });

    source.observations = [obs({ hex: 'a00001' })];
    await provider.acquire();
    await provider.fetchArea(40, -86, 6);
    expect(provider.health()).toMatchObject({
      state: 'ok',
      requests: 1,
      failures: 0,
      lastStatus: 200,
      lastCount: 1,
    });

    source.failWith = new ProviderError('server', 'HTTP 502', { status: 502 });
    vi.advanceTimersByTime(2000);
    await provider.acquire();
    await expect(provider.fetchArea(40, -86, 6)).rejects.toThrow('HTTP 502');
    expect(provider.health()).toMatchObject({
      state: 'backoff',
      failures: 1,
      lastStatus: 502,
      lastError: 'HTTP 502',
    });
    expect(provider.isUsable()).toBe(false);
    expect(await provider.acquire(10_000)).toBe(false);

    source.failWith = null;
    vi.advanceTimersByTime(2000);
    expect(provider.isUsable()).toBe(true);
    await provider.acquire();
    await provider.fetchArea(40, -86, 6);
    expect(provider.health().state).toBe('ok');
    expect(provider.health().lastError).toBeUndefined();
    expect([...provider.outcomes]).toEqual([
      ['200', 2],
      ['502', 1],
    ]);
  });

  it('honours Retry-After on a 429 and counts it', async () => {
    const { source, provider } = make('adsbfi');
    source.failWith = new ProviderError('rate_limited', 'HTTP 429', { status: 429, retryAfterMs: 90_000 });
    await provider.acquire();
    await expect(provider.fetchArea(40, -86, 6)).rejects.toThrow();
    expect(provider.health()).toMatchObject({
      state: 'backoff',
      rateLimited: 1,
      backoffUntil: 1_000_000 + 90_000,
    });
    vi.advanceTimersByTime(89_000);
    expect(provider.isUsable()).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(provider.isUsable()).toBe(true);
  });

  it('marks a refusing service as blocked and leaves it alone for an hour', async () => {
    const { source, provider } = make('adsbfi');
    source.failWith = new ProviderError('forbidden', 'HTTP 403: Please contact us', { status: 403 });
    await provider.acquire();
    await expect(provider.fetchArea(40, -86, 6)).rejects.toThrow();
    expect(provider.health()).toMatchObject({ state: 'blocked', lastStatus: 403 });
    vi.advanceTimersByTime(59 * 60_000);
    expect(provider.isUsable()).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(provider.isUsable()).toBe(true);
  });

  it('does nothing when disabled', async () => {
    const { provider } = make('adsbfi', { enabled: false });
    expect(await provider.acquire(60_000)).toBe(false);
    expect(provider.waitMs()).toBe(Number.POSITIVE_INFINITY);
    expect(provider.health().state).toBe('disabled');
  });

  describe('daily quota', () => {
    it('stretches a 500-a-day quota: 14 s between requests at first, longer as it runs down', async () => {
      const { source, provider } = make('adsblol', { limits: { minIntervalMs: 2000, dailyQuota: 500 } });
      await provider.acquire();
      // (2 h horizon) / (500 - 5 held back) = 14.5 s
      expect(provider.waitMs()).toBeGreaterThan(14_000);
      expect(provider.waitMs()).toBeLessThan(15_000);

      // The service reports its own numbers; they replace the assumption.
      source.rate = { limit: 500, remaining: 105, resetAt: Date.now() + 20_000_000 };
      await provider.fetchArea(40, -86, 6);
      expect(provider.health().quota).toEqual({
        limit: 500,
        remaining: 105,
        resetAt: Date.now() + 20_000_000,
      });
      // 7,200 s / 100 spendable = 72 s between requests from here on.
      vi.advanceTimersByTime(60_000);
      expect(await provider.acquire()).toBe(false);
      vi.advanceTimersByTime(12_000);
      expect(await provider.acquire()).toBe(true);
      expect(provider.waitMs()).toBeGreaterThan(71_000);
      expect(provider.waitMs()).toBeLessThan(73_000);
    });

    it('never spends the last few requests, and recovers when the window resets', async () => {
      const { source, provider } = make('adsblol', { limits: { minIntervalMs: 2000, dailyQuota: 500 } });
      source.rate = { limit: 500, remaining: 5, resetAt: Date.now() + 3_600_000 };
      await provider.acquire();
      await provider.fetchArea(40, -86, 6);
      expect(provider.isUsable()).toBe(false);
      expect(provider.health().state).toBe('blocked');
      expect(await provider.acquire(60_000)).toBe(false);
      vi.advanceTimersByTime(3_600_000);
      expect(provider.isUsable()).toBe(true);
    });

    it('with a generous quota the rate limit is what counts', async () => {
      const { source, provider } = make('adsblol', { limits: { minIntervalMs: 2000 } });
      source.rate = { limit: 360_000, remaining: 359_000, resetAt: Date.now() + 80_000_000 };
      await provider.acquire();
      await provider.fetchArea(40, -86, 6);
      expect(provider.waitMs()).toBe(2000);
    });

    it('counts requests itself when the service reports no balance', async () => {
      const { provider } = make('opensky', { limits: { minIntervalMs: 10_000, dailyQuota: 8 } });
      for (let i = 0; i < 3; i += 1) {
        expect(await provider.acquire()).toBe(true);
        await provider.fetchArea(40, -86, 6);
        // The fewer requests are left, the longer the gap: wait out the longest it can be.
        vi.advanceTimersByTime(3 * 3_600_000);
      }
      // 8 assumed, 5 held back, 3 spent.
      expect(provider.isUsable()).toBe(false);
    });
  });
});

describe('AirportPoller', () => {
  const polling: PollingConfig = {
    activeIntervalMs: 2000,
    idleIntervalMs: 60_000,
    pauseWhenNoViewersAfterMs: 300_000,
    secondaryEveryN: 3,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const provider = (
    id: 'readsb' | 'adsbfi' | 'adsblol' | 'airplaneslive' | 'opensky',
    priority: number,
    extra: Partial<ManagedProviderOptions> = {},
  ) => {
    const source = new FakeSource(id);
    const managed = new ManagedProvider(source, {
      enabled: true,
      priority,
      limits: { minIntervalMs: 1100 },
      random: () => 0,
      ...extra,
    });
    return { source, managed };
  };

  const target = (icao = 'KLAF') => {
    const t = {
      icao,
      ingested: [] as { hexes: string[]; priority: number }[],
      commits: [] as { now: number; staleAfterMs: number }[],
      resets: 0,
      area: () => ({ lat: 40.4129, lon: -86.9394, radiusNm: 6 }),
      ingest(observations: Observation[], priority: number) {
        t.ingested.push({ hexes: observations.map((o) => o.hex), priority });
      },
      commit(now: number, staleAfterMs: number) {
        t.commits.push({ now, staleAfterMs });
      },
      reset() {
        t.resets += 1;
      },
    };
    return t satisfies PollTarget;
  };

  it('polls every 2 s while someone is watching and feeds the tracker', async () => {
    const fi = provider('adsbfi', 1);
    fi.source.observations = [obs({ hex: 'a00001' })];
    const t = target();
    const poller = new AirportPoller(t, { providers: () => [fi.managed], polling: () => polling });

    expect(poller.state).toBe('paused');
    poller.setViewers(1);
    expect(poller.state).toBe('active');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fi.source.calls.length).toBeGreaterThanOrEqual(5);
    expect(fi.source.calls.length).toBeLessThanOrEqual(6);
    expect(minGap(fi.source.calls.map((c) => c.at))).toBeGreaterThanOrEqual(2000);
    expect(t.ingested[0]).toEqual({ hexes: ['a00001'], priority: 1 });
    expect(t.commits.length).toBe(fi.source.calls.length);
    expect(t.commits[0]?.staleAfterMs).toBe(30_000);
    poller.stop();
  });

  it('slows to 60 s when the last viewer leaves, then pauses, then makes no requests at all', async () => {
    const fi = provider('adsbfi', 1);
    const t = target();
    const states: string[] = [];
    const poller = new AirportPoller(t, {
      providers: () => [fi.managed],
      polling: () => polling,
      onStateChange: (s) => states.push(s),
    });

    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(4500);
    const whileActive = fi.source.calls.length;
    expect(whileActive).toBe(3);

    poller.setViewers(0);
    expect(poller.state).toBe('idle');
    await vi.advanceTimersByTimeAsync(180_000);
    const whileIdle = fi.source.calls.length - whileActive;
    expect(whileIdle).toBe(3);
    // Polling slowly, aircraft must be allowed to stay longer than the usual 30 s.
    expect(t.commits[t.commits.length - 1]?.staleAfterMs).toBeGreaterThan(60_000);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(poller.state).toBe('paused');
    expect(t.resets).toBe(1);
    const atPause = fi.source.calls.length;

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fi.source.calls.length).toBe(atPause);
    // Nothing is scheduled: an idle container does no work.
    expect(vi.getTimerCount()).toBe(0);
    expect(states).toEqual(['active', 'idle', 'paused']);
  });

  it('wakes up at once when a viewer returns, and a returning viewer cancels the pause', async () => {
    const fi = provider('adsbfi', 1);
    const poller = new AirportPoller(target(), { providers: () => [fi.managed], polling: () => polling });
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(100);
    poller.setViewers(0);
    await vi.advanceTimersByTimeAsync(299_000);
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poller.state).toBe('active');

    poller.setViewers(0);
    await vi.advanceTimersByTimeAsync(400_000);
    expect(poller.state).toBe('paused');
    const before = fi.source.calls.length;
    poller.setViewers(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(fi.source.calls.length).toBe(before + 1);
    poller.stop();
  });

  it('asks the preferred public source every cycle and the others every third cycle', async () => {
    const fi = provider('adsbfi', 1);
    const lol = provider('adsblol', 2);
    const poller = new AirportPoller(target(), {
      providers: () => [lol.managed, fi.managed],
      polling: () => polling,
    });
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(23_900);
    poller.stop();
    expect(fi.source.calls.length).toBe(12);
    expect(lol.source.calls.length).toBe(4);
  });

  it('asks the local receiver every cycle, alongside a public source', async () => {
    const local = provider('readsb', 0, { limits: { minIntervalMs: 500 } });
    const fi = provider('adsbfi', 1);
    const t = target();
    const poller = new AirportPoller(t, {
      providers: () => [fi.managed, local.managed],
      polling: () => polling,
    });
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(9900);
    poller.stop();
    expect(local.source.calls.length).toBe(5);
    expect(fi.source.calls.length).toBe(5);
    expect(t.ingested.filter((i) => i.priority === 0)).toHaveLength(5);
  });

  it('fails over to the next source while the preferred one backs off, then returns to it', async () => {
    const fi = provider('adsbfi', 1);
    const lol = provider('adsblol', 2);
    fi.source.failWith = new ProviderError('server', 'HTTP 502', { status: 502 });
    const poller = new AirportPoller(target(), {
      providers: () => [fi.managed, lol.managed],
      polling: () => ({ ...polling, secondaryEveryN: 60 }),
    });
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fi.source.calls.length).toBe(1);
    expect(lol.source.calls.length).toBe(0);

    // The first backoff is 2 s, so adsb.fi is tried once more on the next cycle and fails again.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fi.source.calls.length).toBe(2);
    expect(lol.source.calls.length).toBe(0);

    // Now it is backing off for 4 s: the following cycle goes to adsb.lol instead.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fi.source.calls.length).toBe(2);
    expect(lol.source.calls.length).toBe(1);

    fi.source.failWith = null;
    await vi.advanceTimersByTimeAsync(20_000);
    const lolBefore = lol.source.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fi.managed.health().state).toBe('ok');
    expect(lol.source.calls.length).toBe(lolBefore);
    poller.stop();
  });

  it('uses a fallback-only source only when every other source is failing', async () => {
    const fi = provider('adsbfi', 1);
    const sky = provider('opensky', 9, { fallbackOnly: true, limits: { minIntervalMs: 10_000 } });
    const poller = new AirportPoller(target(), {
      providers: () => [fi.managed, sky.managed],
      polling: () => polling,
    });
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sky.source.calls.length).toBe(0);

    fi.source.failWith = new ProviderError('forbidden', 'HTTP 403', { status: 403 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fi.managed.health().state).toBe('blocked');
    expect(sky.source.calls.length).toBeGreaterThanOrEqual(2);
    expect(minGap(sky.source.calls.map((c) => c.at))).toBeGreaterThanOrEqual(10_000);
    poller.stop();
  });

  it('keeps one provider within its rate limit across two airports polling at once', async () => {
    const fi = provider('adsbfi', 1);
    const providers = () => [fi.managed];
    const klaf = new AirportPoller(target('KLAF'), { providers, polling: () => polling, offsetMs: () => 0 });
    const kind = new AirportPoller(target('KIND'), {
      providers,
      polling: () => polling,
      offsetMs: () => 1000,
    });
    klaf.setViewers(1);
    kind.setViewers(1);
    await vi.advanceTimersByTimeAsync(120_000);
    klaf.stop();
    kind.stop();

    const times = fi.source.calls.map((c) => c.at).sort((a, b) => a - b);
    // adsb.fi allows one request per second; the bucket is set to 1.1 s.
    expect(minGap(times)).toBeGreaterThanOrEqual(1100);
    // Two airports share the budget: each still gets a poll about every 2.2 s.
    expect(times.length).toBeGreaterThan(95);
    expect(times.length).toBeLessThanOrEqual(110);
  });

  // Airports that poll within a few hundred milliseconds of each other used to collide on every cycle: the
  // first took adsb.fi's token and the second gave up on it, every time, and lived on adsb.lol's few requests.
  describe.each([
    ['at the same moment', [0, 0]],
    ['150 ms apart', [0, 150]],
    ['250 ms apart', [250, 0]],
    ['1 s apart', [0, 1000]],
  ])('two airports asking %s', (_name, offsets) => {
    it('take turns at adsb.fi, each getting it about every 2.2 s', async () => {
      const fi = provider('adsbfi', 1);
      const providers = () => [fi.managed];
      const pollers = offsets.map(
        (offset, i) =>
          new AirportPoller(
            { ...target(), area: () => ({ lat: 40 + i, lon: -86, radiusNm: 6 }) },
            { providers, polling: () => polling, offsetMs: () => offset },
          ),
      );
      for (const p of pollers) p.setViewers(1);
      await vi.advanceTimersByTimeAsync(120_000);
      for (const p of pollers) p.stop();

      expect(minGap(fi.source.calls.map((c) => c.at).sort((a, b) => a - b))).toBeGreaterThanOrEqual(1100);
      for (const lat of [40, 41]) {
        const times = fi.source.calls.filter((c) => c.lat === lat).map((c) => c.at);
        expect(times.length).toBeGreaterThanOrEqual(50);
        expect(maxGap(times)).toBeLessThanOrEqual(2300);
      }
    });
  });

  it('shares adsb.fi evenly between three airports, about every 3.3 s each', async () => {
    const fi = provider('adsbfi', 1);
    const providers = () => [fi.managed];
    const pollers = [0, 0, 100].map(
      (offset, i) =>
        new AirportPoller(
          { ...target(), area: () => ({ lat: 40 + i, lon: -86, radiusNm: 6 }) },
          { providers, polling: () => polling, offsetMs: () => offset },
        ),
    );
    for (const p of pollers) p.setViewers(1);
    await vi.advanceTimersByTimeAsync(120_000);
    for (const p of pollers) p.stop();

    for (const lat of [40, 41, 42]) {
      const times = fi.source.calls.filter((c) => c.lat === lat).map((c) => c.at);
      expect(times.length).toBeGreaterThanOrEqual(33);
      expect(maxGap(times)).toBeLessThanOrEqual(4500);
    }
  });

  it('skips a cycle rather than queueing when no source has a token', async () => {
    const lol = provider('adsblol', 1, { limits: { minIntervalMs: 2000, dailyQuota: 500 } });
    const t = target();
    const poller = new AirportPoller(t, { providers: () => [lol.managed], polling: () => polling });
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(60_000);
    poller.stop();
    // Paced at ~14.5 s by the daily quota, whatever the poll interval is.
    expect(lol.source.calls.length).toBeLessThanOrEqual(5);
    expect(minGap(lol.source.calls.map((c) => c.at))).toBeGreaterThanOrEqual(14_000);
    // The tracker is still committed every cycle so stale aircraft expire on time.
    expect(t.commits.length).toBeGreaterThanOrEqual(29);
  });

  it('does not poll an airport whose reference data is missing', async () => {
    const fi = provider('adsbfi', 1);
    const t = { ...target(), area: () => null };
    const poller = new AirportPoller(t, { providers: () => [fi.managed], polling: () => polling });
    poller.setViewers(1);
    await vi.advanceTimersByTimeAsync(10_000);
    poller.stop();
    expect(fi.source.calls.length).toBe(0);
  });
});
