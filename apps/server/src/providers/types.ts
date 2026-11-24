import type { ProviderHealth } from '@towercab/shared';
import type { ProviderId } from '../config/schema';

export type { ProviderId };

/** One aircraft as reported by one source at one moment, already converted to common units. */
export interface Observation {
  /** Lower-case hex; a leading `~` marks a non-ICAO address (TIS-B track file and the like). */
  hex: string;
  addrType: string;
  source: ProviderId;
  lat: number;
  lon: number;
  /** When the position was valid, epoch ms. */
  posTime: number;
  /** When the last message of any kind was received, epoch ms. */
  seenTime: number;
  /** Pressure altitude in feet, the literal string `ground`, or null when not reported. */
  altBaro: number | 'ground' | null;
  /** Feet above the WGS84 ellipsoid. */
  altGeomFt: number | null;
  gsKt: number | null;
  trackDeg: number | null;
  trueHeadingDeg: number | null;
  baroRateFpm: number | null;
  geomRateFpm: number | null;
  callsign?: string;
  registration?: string;
  typeCode?: string;
  typeDesc?: string;
  operator?: string;
  category?: string;
  squawk?: string;
  emergency?: string;
  rssi?: number;
  nic?: number;
  nacP?: number;
  /** Altimeter setting selected in the aircraft (`nav_qnh`), hPa. */
  navQnhHpa?: number;
}

/** Quota information a service reports in its response headers. */
export interface RateInfo {
  limit?: number;
  remaining?: number;
  /** Epoch ms when the quota window resets. */
  resetAt?: number;
}

export interface FetchResult {
  observations: Observation[];
  /** Local clock when the response arrived. */
  receivedAt: number;
  rate?: RateInfo;
}

/** A raw data source: knows one API and nothing about rate limits or health. */
export interface AdsbSource {
  readonly id: ProviderId;
  readonly label: string;
  fetchArea(lat: number, lon: number, radiusNm: number, signal?: AbortSignal): Promise<FetchResult>;
  /** Releases sockets and timers. */
  close?(): void;
}

/** The interface the scheduler works with. Implemented by `ManagedProvider`, which wraps an `AdsbSource`. */
export interface AdsbProvider {
  readonly id: ProviderId;
  fetchArea(lat: number, lon: number, radiusNm: number, signal?: AbortSignal): Promise<FetchResult>;
  health(): ProviderHealth;
}

export type ProviderErrorKind =
  | 'rate_limited' // 429
  | 'forbidden' // 401 / 403: the service refuses us
  | 'bad_request' // other 4xx: our request is wrong, retrying will not help
  | 'server' // 5xx
  | 'network'
  | 'timeout'
  | 'parse';

export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly details: { status?: number; retryAfterMs?: number; rate?: RateInfo } = {},
  ) {
    super(message);
  }
  get status(): number | undefined {
    return this.details.status;
  }
  get retryAfterMs(): number | undefined {
    return this.details.retryAfterMs;
  }
}
