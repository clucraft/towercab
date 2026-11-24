import type { AirportInfo, AirportStatus } from '@towercab/shared';
import type { Feed, FeedFactory } from '../live/store';
import { createTraffic, simulate } from './traffic';

/** Updates arrive every two seconds, like the real feed. */
const INTERVAL_MS = 2000;

/**
 * A feed that plays simulated traffic instead of talking to the server. Messages have the same shape and
 * timing as the real ones (a snapshot, then deltas every two seconds with positions a fraction of a second
 * old), so the scene is exercised exactly as it is by live data.
 */
export function simFeed(airport: AirportInfo, count: number): FeedFactory {
  return (handlers): Feed => {
    const traffic = createTraffic(airport, count);
    let timer: ReturnType<typeof setInterval> | null = null;
    let seq = 0;
    const status = (): AirportStatus => ({
      pollState: 'active',
      viewers: 1,
      lastPollAt: Date.now(),
      providers: [
        {
          id: 'simulator',
          label: 'Simulator',
          enabled: true,
          state: 'ok',
          priority: 0,
          requests: seq,
          failures: 0,
          rateLimited: 0,
          lastSuccessAt: Date.now(),
          lastCount: traffic.length,
        },
      ],
    });
    // Each aircraft's position is a little out of date, by a different amount, as real reports are.
    const lag = traffic.map((_, i) => 250 + ((i * 97) % 700));
    const positions = (now: number) => traffic.map((a, i) => simulate(a, airport, now - (lag[i] as number)));

    return {
      start(icao) {
        handlers.onState?.('open');
        const now = Date.now();
        handlers.onSnapshot?.({
          type: 'snapshot',
          serverTime: now,
          icao,
          seq,
          aircraft: positions(now),
          trails: {},
          status: status(),
        });
        handlers.onStatus?.(icao, status());
        timer = setInterval(() => {
          seq += 1;
          const t = Date.now();
          handlers.onDelta?.({ type: 'delta', serverTime: t, icao, seq, upserts: positions(t), removed: [] });
          if (seq % 3 === 0) handlers.onStatus?.(icao, status());
        }, INTERVAL_MS);
      },
      stop() {
        if (timer) clearInterval(timer);
        timer = null;
        handlers.onState?.('closed');
      },
      serverNow: () => Date.now(),
    };
  };
}
