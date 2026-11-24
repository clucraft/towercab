import type { Metar } from '@towercab/shared';
import { type FetchLike, fetchJson } from '../providers/http';

/**
 * METARs from the aviationweather.gov Data API (https://aviationweather.gov/data/api/), checked 2026-11-24:
 * `GET /api/data/metar?ids=KLAF&format=json` answers a JSON array with one object per station, or 204 with
 * no body when there is no report. `altim` is in hPa, `obsTime` in epoch seconds, `wdir` a number or "VRB".
 */
export const METAR_URL = 'https://aviationweather.gov/api/data/metar';

export function parseMetar(json: unknown, icao: string, fetchedAt: number): Metar | null {
  if (!Array.isArray(json)) return null;
  const row = json.find(
    (r): r is Record<string, unknown> =>
      typeof r === 'object' && r !== null && (r as { icaoId?: unknown }).icaoId === icao,
  );
  if (!row || typeof row.rawOb !== 'string') return null;

  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const obsSeconds = num(row.obsTime);
  const clouds = Array.isArray(row.clouds)
    ? row.clouds
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .map((c) => ({ cover: String(c.cover ?? ''), baseFt: num(c.base) }))
    : [];
  return {
    icao,
    raw: row.rawOb,
    obsTime: obsSeconds != null ? obsSeconds * 1000 : fetchedAt,
    fetchedAt,
    tempC: num(row.temp),
    dewpointC: num(row.dewp),
    windDirDeg: num(row.wdir),
    windVariable: row.wdir === 'VRB',
    windSpeedKt: num(row.wspd),
    windGustKt: num(row.wgst),
    visibility: row.visib == null ? null : String(row.visib),
    altimHpa: num(row.altim),
    flightCategory: typeof row.fltCat === 'string' ? row.fltCat : null,
    clouds,
  };
}

export interface MetarServiceOptions {
  userAgent: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** How long a report is served before it is fetched again. */
  ttlMs?: number;
  /** Wait this long after a failed fetch before trying again. */
  retryMs?: number;
  url?: string;
  log?: { warn(obj: object, msg: string): void };
}

/**
 * Caches one METAR per airport for five minutes. Nothing runs on a timer: a report is refreshed only when
 * somebody asks for it, so an idle server makes no requests.
 */
export class MetarService {
  private readonly cache = new Map<string, Metar>();
  private readonly attemptedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<Metar | null>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly retryMs: number;

  constructor(private readonly options: MetarServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.retryMs = options.retryMs ?? 60_000;
  }

  /** The cached report, however old. Starts a background refresh when it is due. */
  peek(icao: string): Metar | null {
    if (this.isDue(icao)) void this.refresh(icao);
    return this.cache.get(icao) ?? null;
  }

  /** The current report, fetching it first when the cached one has expired. */
  async get(icao: string): Promise<Metar | null> {
    if (this.isDue(icao)) await this.refresh(icao);
    return this.cache.get(icao) ?? null;
  }

  private isDue(icao: string): boolean {
    const now = this.now();
    const cached = this.cache.get(icao);
    if (cached && now - cached.fetchedAt < this.ttlMs) return false;
    const attempted = this.attemptedAt.get(icao);
    return attempted === undefined || now - attempted >= this.retryMs;
  }

  private refresh(icao: string): Promise<Metar | null> {
    const running = this.inFlight.get(icao);
    if (running) return running;
    this.attemptedAt.set(icao, this.now());
    const request = fetchJson({
      url: `${this.options.url ?? METAR_URL}?ids=${encodeURIComponent(icao)}&format=json`,
      userAgent: this.options.userAgent,
      fetchImpl: this.options.fetchImpl,
      now: this.now,
      timeoutMs: 10_000,
    })
      .then((res) => {
        const metar = parseMetar(res.json, icao, res.receivedAt);
        if (metar) this.cache.set(icao, metar);
        return metar;
      })
      .catch((err: Error) => {
        this.options.log?.warn({ icao, err: err.message }, 'METAR fetch failed');
        return null;
      })
      .finally(() => {
        this.inFlight.delete(icao);
      });
    this.inFlight.set(icao, request);
    return request;
  }
}
