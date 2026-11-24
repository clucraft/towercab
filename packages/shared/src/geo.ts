/** Unit conversions and small-area geodesy. Everything here is plain maths with no dependencies. */

export const FT_PER_M = 3.280839895;
export const M_PER_FT = 0.3048;
export const M_PER_NM = 1852;
export const MPS_PER_KT = 0.514444;
export const EARTH_RADIUS_M = 6_371_008.8;

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const feetToMetres = (ft: number): number => ft * M_PER_FT;
export const metresToFeet = (m: number): number => m * FT_PER_M;
export const nmToMetres = (nm: number): number => nm * M_PER_NM;
export const metresToNm = (m: number): number => m / M_PER_NM;
export const knotsToMps = (kt: number): number => kt * MPS_PER_KT;

/** Normalises an angle to [0, 360). */
export function normalizeDeg(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Signed smallest rotation from `from` to `to`, in (-180, 180]. Positive is clockwise. */
export function angleDiffDeg(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Great-circle distance in metres (haversine, spherical Earth). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return distanceM(lat1, lon1, lat2, lon2) / M_PER_NM;
}

/** Initial great-circle bearing from point 1 to point 2, degrees true in [0, 360). */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dl = (lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeDeg(Math.atan2(y, x) * DEG);
}

/** Point reached by travelling `distM` metres from a start point on a constant initial bearing. */
export function destinationPoint(
  lat: number,
  lon: number,
  bearing: number,
  distM: number,
): { lat: number; lon: number } {
  const d = distM / EARTH_RADIUS_M;
  const b = bearing * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 =
    l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * DEG, lon: ((l2 * DEG + 540) % 360) - 180 };
}

/**
 * Local east/north offsets in metres from an origin (equirectangular approximation).
 * Accurate to well under a metre across an airport and a few metres at 20 km, which is all this app needs.
 */
export function toLocalEnu(
  originLat: number,
  originLon: number,
  lat: number,
  lon: number,
): { east: number; north: number } {
  const north = (lat - originLat) * RAD * EARTH_RADIUS_M;
  const east = (lon - originLon) * RAD * EARTH_RADIUS_M * Math.cos(originLat * RAD);
  return { east, north };
}

export interface SegmentPosition {
  /** Distance along the segment from its start, metres. Negative before the start, above `lengthM` past the end. */
  alongM: number;
  /** Signed perpendicular offset, metres. Positive is to the right of the direction of travel. */
  crossM: number;
  lengthM: number;
}

/** Where a point sits relative to the straight segment from A to B (for example, a runway centreline). */
export function positionOnSegment(
  lat: number,
  lon: number,
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): SegmentPosition {
  const b = toLocalEnu(aLat, aLon, bLat, bLon);
  const p = toLocalEnu(aLat, aLon, lat, lon);
  const lengthM = Math.hypot(b.east, b.north);
  if (lengthM === 0) return { alongM: 0, crossM: Math.hypot(p.east, p.north), lengthM: 0 };
  const ux = b.east / lengthM;
  const uy = b.north / lengthM;
  return {
    alongM: p.east * ux + p.north * uy,
    // Right-hand side of the travel direction is positive: rotate the unit vector clockwise.
    crossM: p.east * uy - p.north * ux,
    lengthM,
  };
}
