import type { PollState } from '@towercab/shared';
import type { PollingConfig } from '../config/schema';
import type { ManagedProvider } from '../providers/managed';
import type { Observation } from '../providers/types';

/** What a poller feeds. Implemented by the live service; a plain object in tests. */
export interface PollTarget {
  readonly icao: string;
  /** Where to look. Null while the airport's reference data is not available. */
  area(): { lat: number; lon: number; radiusNm: number } | null;
  ingest(observations: Observation[], priority: number, receivedAt: number): void;
  commit(now: number, staleAfterMs: number): void;
  /** Called when polling pauses: forget everything, it will be stale by the time anyone looks again. */
  reset(): void;
}

export interface PollerDeps {
  providers: () => ManagedProvider[];
  polling: () => PollingConfig;
  now?: () => number;
  /** Delay before the first poll after becoming active. Used to spread airports across the interval. */
  offsetMs?: () => number;
  onStateChange?: (state: PollState) => void;
  log?: { debug(obj: object, msg: string): void };
}

/**
 * One polling loop for one airport.
 *
 * - `active` while at least one browser is subscribed: poll every `activeIntervalMs`.
 * - `idle` once the last viewer leaves: poll every `idleIntervalMs`, so a returning viewer sees a warm picture.
 * - `paused` after `pauseWhenNoViewersAfterMs` with no viewers: no timers, no requests.
 *
 * Which sources are asked in a cycle:
 * - the local receiver, every cycle;
 * - the first public source (by priority) that has a token available: this cycle's primary;
 * - every `secondaryEveryN`-th cycle, the remaining public sources too, to fill gaps in coverage;
 * - a fallback-only source (OpenSky) only when none of the others is usable.
 */
export class AirportPoller {
  private currentState: PollState = 'paused';
  private viewerCount = 0;
  private cycle = 0;
  private polling = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  lastPollAt: number | undefined;

  constructor(
    private readonly target: PollTarget,
    private readonly deps: PollerDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  get state(): PollState {
    return this.currentState;
  }

  get viewers(): number {
    return this.viewerCount;
  }

  setViewers(count: number): void {
    const before = this.viewerCount;
    this.viewerCount = Math.max(0, count);
    if (this.viewerCount > 0) {
      this.clearPauseTimer();
      if (this.currentState !== 'active') {
        this.setState('active');
        this.schedule(this.deps.offsetMs?.() ?? 0);
      }
      return;
    }
    if (before === 0) return;
    const { idleIntervalMs, pauseWhenNoViewersAfterMs } = this.deps.polling();
    if (pauseWhenNoViewersAfterMs <= 0) {
      this.pause();
      return;
    }
    this.setState('idle');
    this.schedule(idleIntervalMs);
    this.clearPauseTimer();
    this.pauseTimer = setTimeout(() => this.pause(), pauseWhenNoViewersAfterMs);
  }

  /** Stops everything. The poller can be started again with `setViewers`. */
  stop(): void {
    this.viewerCount = 0;
    this.pause();
  }

  /**
   * One polling cycle. Public so tests and the soak script can drive it directly. Resolves to the moment the
   * requests went out (after any wait for a token), or undefined when there was nothing to poll.
   */
  async pollOnce(): Promise<number | undefined> {
    const area = this.target.area();
    if (!area) return undefined;
    this.cycle += 1;
    const config = this.deps.polling();
    const active = this.currentState === 'active';
    const interval = active ? config.activeIntervalMs : config.idleIntervalMs;
    // Airports share each source's requests. Waiting up to most of a cycle for the next token lets two
    // airports that ask at the same moment take turns; with a shorter wait the second one lost it every time.
    const maxWaitMs = active ? Math.floor(config.activeIntervalMs * 0.75) : 0;

    const providers = this.deps
      .providers()
      .filter((p) => p.enabled)
      .sort((a, b) => a.priority - b.priority);
    const regular = providers.filter((p) => !p.fallbackOnly);
    const secondaryTurn = this.cycle % config.secondaryEveryN === 0;

    const tasks: Promise<void>[] = [];
    const run = (provider: ManagedProvider) => {
      tasks.push(
        provider.fetchArea(area.lat, area.lon, area.radiusNm).then(
          (result) => this.target.ingest(result.observations, provider.priority, result.receivedAt),
          (err: Error) =>
            this.deps.log?.debug(
              { icao: this.target.icao, provider: provider.id, err: err.message },
              'fetch failed',
            ),
        ),
      );
    };

    let havePrimary = false;
    for (const provider of regular) {
      if (provider.id === 'readsb') {
        if (await provider.acquire(0)) run(provider);
      } else if (!havePrimary) {
        if (await provider.acquire(maxWaitMs)) {
          run(provider);
          havePrimary = true;
        }
      } else if (secondaryTurn && (await provider.acquire(0))) {
        run(provider);
      }
    }

    if (!regular.some((p) => p.isUsable())) {
      for (const provider of providers) {
        if (provider.fallbackOnly && (await provider.acquire(0))) {
          run(provider);
          break;
        }
      }
    }

    const sentAt = this.now();
    await Promise.all(tasks);
    const now = this.now();
    this.lastPollAt = now;
    // Aircraft are dropped 30 s after they were last heard; when polling slowly that has to stretch, or
    // every aircraft would vanish between polls.
    this.target.commit(now, Math.max(30_000, Math.round(interval * 1.5) + 5000));
    return sentAt;
  }

  private async tick(): Promise<void> {
    this.tickTimer = null;
    if (this.currentState === 'paused' || this.polling) return;
    const startedAt = this.now();
    let sentAt: number | undefined;
    this.polling = true;
    try {
      sentAt = await this.pollOnce();
    } catch (err) {
      this.deps.log?.debug({ icao: this.target.icao, err: (err as Error).message }, 'poll cycle failed');
    } finally {
      this.polling = false;
    }
    // The state may have changed while the poll was in flight.
    const state = this.state;
    if (state === 'paused') return;
    const config = this.deps.polling();
    const interval = state === 'active' ? config.activeIntervalMs : config.idleIntervalMs;
    // The next cycle counts from when the requests went out. After waiting for a token that moves this airport's
    // turn away from the airport that had it, so the two stop arriving at the same moment.
    if (!this.tickTimer) this.schedule(Math.max(0, interval - (this.now() - (sentAt ?? startedAt))));
  }

  private schedule(delayMs: number): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = setTimeout(() => void this.tick(), delayMs);
  }

  private pause(): void {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
    this.clearPauseTimer();
    this.setState('paused');
    this.target.reset();
  }

  private clearPauseTimer(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  private setState(state: PollState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    this.deps.onStateChange?.(state);
  }
}
