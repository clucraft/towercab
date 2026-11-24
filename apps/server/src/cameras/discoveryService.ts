import type { CameraProvider } from '@towercab/shared';
import type { AppConfig } from '../config/schema';
import type { FetchLike } from '../providers/http';
import { type DiscoveryAirport, searchWindy, searchYouTube } from './discovery';
import type { CameraStore, DiscoveryResult } from './store';

/** What happened for one provider when a search was asked for. */
export interface DiscoveryOutcome {
  provider: CameraProvider;
  /** False: the provider was not asked this time, and `message` says why. */
  ran: boolean;
  ok: boolean;
  found: number;
  /** Cameras that were not in the queue before. */
  added: number;
  message?: string;
  /** When this provider may be asked again for this airport. */
  nextAt?: number;
}

export interface DiscoveryDeps {
  config: () => AppConfig;
  store: CameraStore;
  userAgent: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** After a failed search the same search may be tried again this soon; the usual interval follows a success. */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;

/**
 * Runs camera searches when an admin asks for one, and no more often than `discovery.intervalHours` per
 * airport and provider: a YouTube search is paid for from a small daily allowance. What was found is kept,
 * so asking again inside the interval costs nothing and changes nothing. There is no background searching.
 */
export class DiscoveryService {
  private readonly running = new Set<string>();

  constructor(private readonly deps: DiscoveryDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** When a provider may next be asked for an airport; undefined means now. */
  nextAllowedAt(icao: string, provider: CameraProvider): number | undefined {
    const last = this.deps.store.lastRun(icao, provider);
    if (!last) return undefined;
    const wait = last.ok ? this.deps.config().discovery.intervalHours * 3600_000 : RETRY_AFTER_FAILURE_MS;
    const next = last.ranAt + wait;
    return next > this.now() ? next : undefined;
  }

  async run(airport: DiscoveryAirport): Promise<DiscoveryOutcome[]> {
    const config = this.deps.config();
    if (!config.discovery.enabled) {
      throw new Error('Discovery is switched off. Set discovery.enabled in the config file.');
    }
    if (this.running.has(airport.icao)) {
      throw new Error(`A search for ${airport.icao} is already running.`);
    }
    this.running.add(airport.icao);
    try {
      const { youtubeApiKey, windyApiKey } = config.secrets;
      const common = { userAgent: this.deps.userAgent, fetchImpl: this.deps.fetchImpl };
      return [
        await this.one(airport, 'youtube', youtubeApiKey, 'YOUTUBE_API_KEY', (apiKey) =>
          searchYouTube(airport, { ...common, apiKey, radiusKm: config.discovery.youtubeRadiusKm }),
        ),
        await this.one(airport, 'windy', windyApiKey, 'WINDY_API_KEY', (apiKey) =>
          searchWindy(airport, { ...common, apiKey, radiusKm: config.discovery.windyRadiusKm }),
        ),
      ];
    } finally {
      this.running.delete(airport.icao);
    }
  }

  private async one(
    airport: DiscoveryAirport,
    provider: CameraProvider,
    apiKey: string | undefined,
    keyName: string,
    search: (apiKey: string) => Promise<DiscoveryResult[]>,
  ): Promise<DiscoveryOutcome> {
    if (!apiKey) {
      return { provider, ran: false, ok: true, found: 0, added: 0, message: `${keyName} is not set.` };
    }
    const nextAt = this.nextAllowedAt(airport.icao, provider);
    if (nextAt !== undefined) {
      const last = this.deps.store.lastRun(airport.icao, provider);
      return {
        provider,
        ran: false,
        ok: last?.ok ?? true,
        found: last?.found ?? 0,
        added: 0,
        nextAt,
        message: last?.ok ? 'Searched recently; the results are in the queue.' : last?.message,
      };
    }
    const ranAt = this.now();
    try {
      const results = await search(apiKey);
      const { added } = this.deps.store.recordResults(results, ranAt);
      this.deps.store.recordRun({ airport: airport.icao, provider, ranAt, ok: true, found: results.length });
      this.deps.log?.info(
        { airport: airport.icao, provider, found: results.length, added },
        'camera search done',
      );
      return {
        provider,
        ran: true,
        ok: true,
        found: results.length,
        added,
        nextAt: this.nextAllowedAt(airport.icao, provider),
      };
    } catch (err) {
      const message = (err as Error).message;
      this.deps.store.recordRun({ airport: airport.icao, provider, ranAt, ok: false, found: 0, message });
      this.deps.log?.warn({ airport: airport.icao, provider, err: message }, 'camera search failed');
      return {
        provider,
        ran: true,
        ok: false,
        found: 0,
        added: 0,
        message,
        nextAt: this.nextAllowedAt(airport.icao, provider),
      };
    }
  }
}
