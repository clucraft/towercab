import { type Observation, ProviderError, type ProviderId } from './types';

/**
 * Parser for the readsb aircraft format. One parser covers:
 * - readsb / tar1090 `aircraft.json`:      `{ now: <seconds>, aircraft: [...] }`
 * - adsb.lol and airplanes.live v2, and adsb.fi v3: `{ now: <milliseconds>, ac: [...] }`
 * - adsb.fi's deprecated v2 point endpoint: `{ now: <seconds>, aircraft: [...] }`
 * - readsb's JSON position stream: one aircraft object per line, each with its own `now` (seconds)
 *
 * Field meanings: https://github.com/wiedehopf/readsb/blob/dev/README-json.md
 */

export interface ReadsbEnvelope {
  /** The service's own timestamp for the data, epoch ms. Null when it sends none. */
  nowMs: number | null;
  aircraft: unknown[];
}

const HEX = /^~?[0-9a-f]{6}$/;
/** The service clock is trusted only this far behind our own; beyond that our receive time is used. */
const MAX_DATA_AGE_MS = 10_000;

export function parseReadsbEnvelope(json: unknown): ReadsbEnvelope {
  if (!isRecord(json)) throw new ProviderError('parse', 'response is not a JSON object');
  const list = Array.isArray(json.ac) ? json.ac : Array.isArray(json.aircraft) ? json.aircraft : null;
  if (!list) {
    // The v2 APIs answer `{"ac": null}`-style bodies for some empty results; treat only a missing key as an error.
    if (json.ac === null || json.aircraft === null) return { nowMs: epochMs(json.now), aircraft: [] };
    throw new ProviderError('parse', 'response has neither "ac" nor "aircraft"');
  }
  return { nowMs: epochMs(json.now), aircraft: list };
}

/**
 * The moment the data describes, on our clock. The service's `now` is the better reference (responses are
 * cached for a moment and take time to arrive), but only while it agrees with our own clock.
 */
export function resolveDataTime(nowMs: number | null, receivedAt: number): number {
  if (nowMs == null) return receivedAt;
  if (nowMs > receivedAt) return receivedAt;
  if (nowMs < receivedAt - MAX_DATA_AGE_MS) return receivedAt;
  return nowMs;
}

/** Converts one readsb aircraft object. Returns null when it has no usable address or position. */
export function parseReadsbAircraft(raw: unknown, dataTime: number, source: ProviderId): Observation | null {
  if (!isRecord(raw)) return null;
  const hex = typeof raw.hex === 'string' ? raw.hex.trim().toLowerCase() : '';
  if (!HEX.test(hex)) return null;

  const lat = num(raw.lat);
  const lon = num(raw.lon);
  // Without a current position there is nothing to draw. readsb moves positions older than 60 s to `lastPosition`.
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const seen = nonNegative(raw.seen) ?? 0;
  const seenPos = nonNegative(raw.seen_pos) ?? seen;

  const obs: Observation = {
    hex,
    addrType: str(raw.type) ?? 'unknown',
    source,
    lat,
    lon,
    posTime: dataTime - seenPos * 1000,
    // `seen` is rounded to a tenth of a second, so it can come out a hair older than `seen_pos`.
    seenTime: dataTime - Math.min(seen, seenPos) * 1000,
    altBaro: raw.alt_baro === 'ground' ? 'ground' : num(raw.alt_baro),
    altGeomFt: num(raw.alt_geom),
    gsKt: nonNegative(raw.gs),
    trackDeg: heading(raw.track),
    trueHeadingDeg: heading(raw.true_heading),
    baroRateFpm: num(raw.baro_rate),
    geomRateFpm: num(raw.geom_rate),
  };

  const callsign = str(raw.flight);
  if (callsign) obs.callsign = callsign;
  const registration = str(raw.r);
  if (registration) obs.registration = registration;
  const typeCode = str(raw.t);
  if (typeCode) obs.typeCode = typeCode.toUpperCase();
  const typeDesc = str(raw.desc);
  if (typeDesc) obs.typeDesc = typeDesc;
  const operator = str(raw.ownOp);
  if (operator) obs.operator = operator;
  const category = str(raw.category);
  if (category) obs.category = category.toUpperCase();
  const squawk = str(raw.squawk);
  if (squawk) obs.squawk = squawk;
  const emergency = str(raw.emergency);
  if (emergency && emergency !== 'none') obs.emergency = emergency;
  const rssi = num(raw.rssi);
  if (rssi != null) obs.rssi = rssi;
  const nic = num(raw.nic);
  if (nic != null) obs.nic = nic;
  const nacP = num(raw.nac_p);
  if (nacP != null) obs.nacP = nacP;
  const navQnh = num(raw.nav_qnh);
  if (navQnh != null && navQnh > 850 && navQnh < 1100) obs.navQnhHpa = navQnh;
  return obs;
}

/** Parses a whole response body. `receivedAt` is the local clock when the response arrived. */
export function parseReadsbResponse(json: unknown, receivedAt: number, source: ProviderId): Observation[] {
  const envelope = parseReadsbEnvelope(json);
  const dataTime = resolveDataTime(envelope.nowMs, receivedAt);
  const out: Observation[] = [];
  for (const raw of envelope.aircraft) {
    const obs = parseReadsbAircraft(raw, dataTime, source);
    if (obs) out.push(obs);
  }
  return out;
}

/** Parses one line of readsb's JSON position stream (`--net-json-port`). */
export function parseReadsbStreamLine(
  line: string,
  receivedAt: number,
  source: ProviderId,
): Observation | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  return parseReadsbAircraft(raw, resolveDataTime(epochMs(raw.now), receivedAt), source);
}

/** `now` is seconds in readsb's own files and milliseconds in the v2 APIs. */
function epochMs(value: unknown): number | null {
  const n = num(value);
  if (n == null || n <= 0) return null;
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nonNegative(v: unknown): number | null {
  const n = num(v);
  return n != null && n >= 0 ? n : null;
}

function heading(v: unknown): number | null {
  const n = num(v);
  return n != null && n >= 0 && n <= 360 ? n % 360 : null;
}

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}
