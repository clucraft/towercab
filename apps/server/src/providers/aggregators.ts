import { type FetchLike, fetchJson } from './http';
import { parseReadsbResponse } from './readsb';
import type { AdsbSource, FetchResult, ProviderId } from './types';

/**
 * The public aggregators. All three serve the readsb aircraft format, so they share one adapter and differ
 * only in URL shape and limits. Endpoints and limits were checked against the live services on 2026-11-24;
 * see docs/DECISIONS.md.
 */
export interface AggregatorDefinition {
  id: ProviderId;
  label: string;
  baseUrl: string;
  /** Path for "aircraft within `nm` nautical miles of a point". */
  path(lat: string, lon: string, nm: number): string;
  /** Shortest allowed gap between requests, from the service's published limit plus a margin. */
  minIntervalMs: number;
  /** Requests per day without a key, when the service has a daily quota. */
  dailyQuota?: number;
  /** Header that carries an API key, when the service has keys. */
  apiKeyHeader?: string;
}

export const AGGREGATORS = {
  adsblol: {
    id: 'adsblol',
    label: 'adsb.lol',
    baseUrl: 'https://api.adsb.lol',
    path: (lat, lon, nm) => `/v2/lat/${lat}/lon/${lon}/dist/${nm}`,
    minIntervalMs: 2000,
    // "No key: 500 requests/day per IP" (API docs and x-ratelimit-limit header).
    dailyQuota: 500,
    apiKeyHeader: 'x-api-key',
  },
  adsbfi: {
    id: 'adsbfi',
    label: 'adsb.fi',
    baseUrl: 'https://opendata.adsb.fi/api',
    // v3: the v2 point endpoint is deprecated and returns a different envelope.
    path: (lat, lon, nm) => `/v3/lat/${lat}/lon/${lon}/dist/${nm}`,
    // "Public endpoints are rate limited to 1 request per second."
    minIntervalMs: 1100,
  },
  airplaneslive: {
    id: 'airplaneslive',
    label: 'airplanes.live',
    baseUrl: 'https://api.airplanes.live',
    path: (lat, lon, nm) => `/v2/point/${lat}/${lon}/${nm}`,
    minIntervalMs: 1100,
  },
} as const satisfies Record<string, AggregatorDefinition>;

export type AggregatorId = keyof typeof AGGREGATORS;

export interface AggregatorOptions {
  userAgent: string;
  baseUrl?: string;
  apiKey?: string;
  /** Extra request headers, for services that grant access in their own way. */
  headers?: Record<string, string>;
  fetchImpl?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
}

/** The APIs cap the radius at 250 NM. */
const MAX_RADIUS_NM = 250;

export function createAggregatorSource(def: AggregatorDefinition, options: AggregatorOptions): AdsbSource {
  const baseUrl = (options.baseUrl ?? def.baseUrl).replace(/\/+$/, '');
  const headers: Record<string, string> = { ...options.headers };
  if (options.apiKey && def.apiKeyHeader) headers[def.apiKeyHeader] = options.apiKey;

  return {
    id: def.id,
    label: def.label,
    async fetchArea(lat, lon, radiusNm, signal): Promise<FetchResult> {
      const nm = Math.min(MAX_RADIUS_NM, Math.max(1, Math.ceil(radiusNm)));
      const url = baseUrl + def.path(lat.toFixed(4), lon.toFixed(4), nm);
      const res = await fetchJson({
        url,
        userAgent: options.userAgent,
        headers,
        signal,
        fetchImpl: options.fetchImpl,
        now: options.now,
        timeoutMs: options.timeoutMs,
      });
      return {
        observations: parseReadsbResponse(res.json, res.receivedAt, def.id),
        receivedAt: res.receivedAt,
        rate: res.rate,
      };
    },
  };
}
