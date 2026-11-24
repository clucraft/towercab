import { distanceNm, FT_PER_M } from '@towercab/shared';
import { type FetchLike, fetchJson } from './http';
import { type AdsbSource, type FetchResult, type Observation, ProviderError } from './types';

/**
 * OpenSky Network REST API (https://openskynetwork.github.io/opensky-api/rest.html), checked 2026-11-24.
 * - `GET /api/states/all` with a bounding box. A box of 25 square degrees or less costs 1 credit.
 * - Auth is OAuth2 client credentials only; tokens last 30 minutes.
 * - Credits per day: 400 anonymous, 4,000 with an account. `X-Rate-Limit-Remaining` reports the balance.
 * - Anonymous data has 10 s resolution, authenticated 5 s, so this is a fallback and never a primary source.
 */

export const OPENSKY_API = 'https://opensky-network.org/api';
export const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

const MPS_TO_KT = 1.943844;
const MPS_TO_FPM = 196.850394;
/** Refresh the token this long before it expires. */
const TOKEN_MARGIN_MS = 60_000;

export interface OpenSkyOptions {
  userAgent: string;
  clientId?: string;
  clientSecret?: string;
  apiUrl?: string;
  tokenUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** OpenSky `category` (with `extended=1`) to the ADS-B emitter category strings readsb uses. */
const CATEGORY: Record<number, string> = {
  2: 'A1',
  3: 'A2',
  4: 'A3',
  5: 'A4',
  6: 'A5',
  7: 'A6',
  8: 'A7',
  9: 'B1',
  10: 'B2',
  11: 'B3',
  12: 'B4',
  14: 'B6',
  15: 'B7',
  16: 'C1',
  17: 'C2',
  18: 'C3',
};

const POSITION_SOURCE: Record<number, string> = { 0: 'adsb_icao', 1: 'asterix', 2: 'mlat', 3: 'flarm' };

export function createOpenSkySource(options: OpenSkyOptions): AdsbSource {
  const now = options.now ?? Date.now;
  const apiUrl = (options.apiUrl ?? OPENSKY_API).replace(/\/+$/, '');
  const tokenUrl = options.tokenUrl ?? OPENSKY_TOKEN_URL;
  const hasCredentials = Boolean(options.clientId && options.clientSecret);
  let token: { value: string; expiresAt: number } | null = null;

  async function getToken(signal?: AbortSignal): Promise<string | null> {
    if (!hasCredentials) return null;
    if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
    const res = await fetchJson({
      url: tokenUrl,
      method: 'POST',
      userAgent: options.userAgent,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: options.clientId as string,
        client_secret: options.clientSecret as string,
      }).toString(),
      signal,
      fetchImpl: options.fetchImpl,
      now,
    });
    const body = res.json as { access_token?: unknown; expires_in?: unknown } | null;
    if (!body || typeof body.access_token !== 'string') {
      throw new ProviderError('parse', 'OpenSky token response has no access_token');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 1800;
    token = { value: body.access_token, expiresAt: res.receivedAt + expiresIn * 1000 };
    return token.value;
  }

  async function request(url: string, signal?: AbortSignal) {
    const bearer = await getToken(signal);
    return fetchJson({
      url,
      userAgent: options.userAgent,
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
      signal,
      fetchImpl: options.fetchImpl,
      now,
      timeoutMs: 12_000,
    });
  }

  return {
    id: 'opensky',
    label: 'OpenSky Network',
    async fetchArea(lat, lon, radiusNm, signal): Promise<FetchResult> {
      const dLat = radiusNm / 60;
      const dLon = radiusNm / (60 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
      const query = new URLSearchParams({
        lamin: (lat - dLat).toFixed(4),
        lomin: (lon - dLon).toFixed(4),
        lamax: (lat + dLat).toFixed(4),
        lomax: (lon + dLon).toFixed(4),
        extended: '1',
      });
      const url = `${apiUrl}/states/all?${query}`;
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(url, signal);
      } catch (err) {
        // "A 401 Unauthorized response means the token has expired - request a new one and retry."
        if (!(err instanceof ProviderError) || err.status !== 401 || !token) throw err;
        token = null;
        res = await request(url, signal);
      }
      const observations = parseOpenSkyStates(res.json).filter(
        (o) => distanceNm(lat, lon, o.lat, o.lon) <= radiusNm,
      );
      return { observations, receivedAt: res.receivedAt, rate: res.rate };
    },
  };
}

/** Converts a `/states/all` body. State vectors are positional arrays; see the REST docs for the indices. */
export function parseOpenSkyStates(json: unknown): Observation[] {
  if (typeof json !== 'object' || json === null)
    throw new ProviderError('parse', 'response is not a JSON object');
  const states = (json as { states?: unknown }).states;
  // `states` is null when the box is empty.
  if (states == null) return [];
  if (!Array.isArray(states)) throw new ProviderError('parse', '"states" is not an array');

  const out: Observation[] = [];
  for (const s of states) {
    if (!Array.isArray(s)) continue;
    const hex = typeof s[0] === 'string' ? s[0].trim().toLowerCase() : '';
    const timePosition = num(s[3]);
    const lastContact = num(s[4]);
    const lon = num(s[5]);
    const lat = num(s[6]);
    if (!/^[0-9a-f]{6}$/.test(hex) || lat == null || lon == null || timePosition == null) continue;

    const baroM = num(s[7]);
    const geoM = num(s[13]);
    const velocity = num(s[9]);
    const verticalRate = num(s[11]);
    const obs: Observation = {
      hex,
      addrType: POSITION_SOURCE[num(s[16]) ?? 0] ?? 'unknown',
      source: 'opensky',
      lat,
      lon,
      posTime: timePosition * 1000,
      seenTime: (lastContact ?? timePosition) * 1000,
      altBaro: s[8] === true ? 'ground' : baroM == null ? null : baroM * FT_PER_M,
      altGeomFt: geoM == null ? null : geoM * FT_PER_M,
      gsKt: velocity == null ? null : velocity * MPS_TO_KT,
      trackDeg: num(s[10]),
      trueHeadingDeg: null,
      baroRateFpm: verticalRate == null ? null : verticalRate * MPS_TO_FPM,
      geomRateFpm: null,
    };
    const callsign = typeof s[1] === 'string' ? s[1].trim() : '';
    if (callsign) obs.callsign = callsign;
    if (typeof s[14] === 'string' && s[14]) obs.squawk = s[14];
    const category = CATEGORY[num(s[17]) ?? -1];
    if (category) obs.category = category;
    out.push(obs);
  }
  return out;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
