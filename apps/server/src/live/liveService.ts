import { EventEmitter } from 'node:events';
import type { Aircraft, AirportStatus, PollState, TrailPoint } from '@towercab/shared';
import type { PollingConfig } from '../config/schema';
import type { ManagedProvider } from '../providers/managed';
import type { AirportService } from '../reference/airportService';
import type { MetarService } from '../reference/metar';
import { AirportPoller } from '../scheduler/poller';
import { AirportTracker, type TrackerDelta } from '../tracking/tracker';

export interface LiveServiceDeps {
  airports: AirportService;
  metar: Pick<MetarService, 'peek'>;
  providers: () => ManagedProvider[];
  polling: () => PollingConfig;
  now?: () => number;
  log?: { debug(obj: object, msg: string): void; info(obj: object, msg: string): void };
}

export interface LiveServiceEvents {
  /** Aircraft changed at an airport. */
  delta: [icao: string, delta: TrackerDelta];
  /** Poll state changed at an airport. */
  state: [icao: string, state: PollState];
}

interface Runtime {
  icao: string;
  tracker: AirportTracker;
  poller: AirportPoller;
  qnhHpa: number | null;
}

/** Trails sent with a snapshot cover the last three minutes; ten minutes are kept in memory. */
const SNAPSHOT_TRAIL_MS = 180_000;

/**
 * Live traffic for every configured airport: one tracker and one polling loop each.
 * Polling follows the number of viewers the WebSocket hub reports.
 */
export class LiveService extends EventEmitter<LiveServiceEvents> {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly now: () => number;

  constructor(private readonly deps: LiveServiceDeps) {
    super();
    this.now = deps.now ?? Date.now;
  }

  /** Creates and removes per-airport state to match the configured airports. */
  sync(): void {
    const wanted = new Set(this.deps.airports.list().map((a) => a.icao));
    for (const [icao, runtime] of this.runtimes) {
      if (!wanted.has(icao)) {
        runtime.poller.stop();
        this.runtimes.delete(icao);
      }
    }
    for (const icao of wanted) {
      if (!this.runtimes.has(icao)) this.runtimes.set(icao, this.createRuntime(icao));
    }
  }

  has(icao: string): boolean {
    return this.runtimes.has(icao);
  }

  setViewers(icao: string, count: number): void {
    this.runtimes.get(icao)?.poller.setViewers(count);
  }

  snapshot(icao: string): { aircraft: Aircraft[]; trails: Record<string, TrailPoint[]> } {
    const runtime = this.runtimes.get(icao);
    if (!runtime) return { aircraft: [], trails: {} };
    return runtime.tracker.snapshot(SNAPSHOT_TRAIL_MS, this.now());
  }

  status(icao: string): AirportStatus {
    const runtime = this.runtimes.get(icao);
    const status: AirportStatus = {
      pollState: runtime?.poller.state ?? 'paused',
      viewers: runtime?.poller.viewers ?? 0,
      providers: this.deps.providers().map((p) => p.health()),
    };
    if (runtime?.poller.lastPollAt !== undefined) status.lastPollAt = runtime.poller.lastPollAt;
    if (runtime?.qnhHpa != null) status.qnhHpa = runtime.qnhHpa;
    return status;
  }

  /** Aircraft currently shown per airport, for /metrics. */
  counts(): { icao: string; aircraft: number; state: PollState; viewers: number }[] {
    return [...this.runtimes.values()].map((r) => ({
      icao: r.icao,
      aircraft: r.tracker.size,
      state: r.poller.state,
      viewers: r.poller.viewers,
    }));
  }

  stop(): void {
    for (const runtime of this.runtimes.values()) runtime.poller.stop();
    this.runtimes.clear();
  }

  private createRuntime(icao: string): Runtime {
    const { airports, metar } = this.deps;
    const runtime = { icao, qnhHpa: null } as Runtime;

    runtime.tracker = new AirportTracker(() => {
      const info = airports.get(icao);
      // Altimeter setting: the METAR when there is one, else what the aircraft themselves have dialled in.
      const report = metar.peek(icao);
      const qnh = report?.altimHpa ?? runtime.tracker.aircraftQnhHpa();
      runtime.qnhHpa = qnh;
      return {
        lat: info?.lat ?? 0,
        lon: info?.lon ?? 0,
        elevationFt: info?.elevationFt ?? 0,
        geoidUndulationM: info?.geoidUndulationM ?? 0,
        radiusNm: info?.radiusNm ?? 0,
        ceilingFtAgl: info?.ceilingFtAgl ?? 0,
        runways: info?.runways ?? [],
        qnhHpa: qnh,
        tempC: report?.tempC ?? null,
      };
    });

    runtime.poller = new AirportPoller(
      {
        icao,
        area: () => {
          const info = airports.get(icao);
          return info ? { lat: info.lat, lon: info.lon, radiusNm: info.radiusNm } : null;
        },
        ingest: (observations, priority, receivedAt) =>
          runtime.tracker.ingest(observations, priority, receivedAt),
        commit: (now, staleAfterMs) => {
          const delta = runtime.tracker.commit(now, staleAfterMs);
          if (delta.upserts.length > 0 || delta.removed.length > 0) this.emit('delta', icao, delta);
        },
        reset: () => {
          const removed = runtime.tracker.clear();
          if (removed.length > 0) this.emit('delta', icao, { upserts: [], removed });
        },
      },
      {
        providers: this.deps.providers,
        polling: this.deps.polling,
        now: this.now,
        log: this.deps.log,
        // Spread the airports across the interval so they do not all ask at the same instant.
        offsetMs: () => {
          const icaos = [...this.runtimes.keys()];
          const index = Math.max(0, icaos.indexOf(icao));
          return Math.round((index * this.deps.polling().activeIntervalMs) / Math.max(1, icaos.length));
        },
        onStateChange: (state) => {
          this.deps.log?.info({ icao, state }, 'polling state changed');
          this.emit('state', icao, state);
        },
      },
    );
    return runtime;
  }
}
