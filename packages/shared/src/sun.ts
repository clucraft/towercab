/**
 * Where the sun is, and when it rises and sets, for a place and a time.
 *
 * The position follows NOAA's solar equations, which are good to about a hundredth of a degree for the years this
 * app will see. It depends on coordinates and on the moment only; a time zone comes in when a day has to begin and
 * end somewhere, and when a time is shown to somebody.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;

export interface SunPosition {
  /** Of the middle of the sun above the horizon, without refraction. Negative below it. */
  elevationDeg: number;
  /** Degrees clockwise from true north. */
  azimuthDeg: number;
}

export function sunPosition(lat: number, lon: number, timeMs: number): SunPosition {
  const julianDay = timeMs / DAY_MS + 2_440_587.5;
  const t = (julianDay - 2_451_545) / 36_525;

  const meanLongitude = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = (357.52911 + t * (35_999.05029 - 0.0001537 * t)) * RAD;
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre =
    Math.sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly) * 0.000289;
  const node = (125.04 - 1934.136 * t) * RAD;
  const longitude = (meanLongitude + centre - 0.00569 - 0.00478 * Math.sin(node)) * RAD;
  const obliquity =
    (23 +
      (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 +
      0.00256 * Math.cos(node)) *
    RAD;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(longitude));

  // How far a sundial is ahead of a clock, minutes.
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLongitude * RAD;
  const equationOfTime =
    (4 / RAD) *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(meanAnomaly) +
      4 * eccentricity * y * Math.sin(meanAnomaly) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly));

  const minutesUtc = (timeMs / 60_000) % 1440;
  const hourAngle = ((minutesUtc + equationOfTime + 4 * lon) / 4 - 180) * RAD;
  const phi = lat * RAD;
  const sinElevation =
    Math.sin(phi) * Math.sin(declination) + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
  const azimuth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi),
  );
  return {
    elevationDeg: Math.asin(Math.max(-1, Math.min(1, sinElevation))) / RAD,
    azimuthDeg: (azimuth / RAD + 180 + 360) % 360,
  };
}

/**
 * How much higher something in the sky appears than it is, because the air bends its light: half a degree at the
 * horizon, next to nothing further up. Saemundsson's formula for average weather.
 */
export function refractionDeg(elevationDeg: number): number {
  const h = Math.max(elevationDeg, -1);
  const seen = 1.02 / 60 / Math.tan((h + 10.3 / (h + 5.11)) * RAD);
  // Further down there is nothing to see, only a value to fade out.
  return elevationDeg >= -1 ? seen : seen * Math.max(0, 1 + (elevationDeg + 1) / 2);
}

/**
 * Elevation of the middle of the sun when its upper edge is seen on the horizon: half its width, and what the air
 * bends its light by. The usual value, and the one almanacs use.
 */
export const SUNRISE_ELEVATION_DEG = -0.833;

/** From day to night, as almanacs and air traffic rules divide it. */
export type DayPhase = 'day' | 'civil' | 'nautical' | 'astronomical' | 'night';

export function dayPhase(elevationDeg: number): DayPhase {
  if (elevationDeg >= SUNRISE_ELEVATION_DEG) return 'day';
  if (elevationDeg >= -6) return 'civil';
  if (elevationDeg >= -12) return 'nautical';
  if (elevationDeg >= -18) return 'astronomical';
  return 'night';
}

export interface SunTimes {
  /** Epoch ms. Null when the sun does not rise or set within the span. */
  sunrise: number | null;
  sunset: number | null;
  /** Set when it does neither: whether it is up throughout. */
  always: 'up' | 'down' | null;
}

const STEP_MS = 10 * 60_000;

/** The first sunrise and the last sunset between two moments, normally the beginning and end of a local day. */
export function sunTimes(lat: number, lon: number, fromMs: number, toMs: number): SunTimes {
  const above = (time: number) => sunPosition(lat, lon, time).elevationDeg - SUNRISE_ELEVATION_DEG;
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let before = above(fromMs);
  for (let start = fromMs; start < toMs; start += STEP_MS) {
    const end = Math.min(start + STEP_MS, toMs);
    const after = above(end);
    if (before < 0 && after >= 0) sunrise ??= crossing(above, start, end);
    else if (before >= 0 && after < 0) sunset = crossing(above, start, end);
    before = after;
  }
  const always = sunrise === null && sunset === null ? (before >= 0 ? 'up' : 'down') : null;
  return { sunrise, sunset, always };
}

/** The moment at which `f` changes sign between `from` and `to`, to the second. */
function crossing(f: (time: number) => number, from: number, to: number): number {
  const rising = f(to) >= 0;
  let low = from;
  let high = to;
  while (high - low > 1000) {
    const middle = (low + high) / 2;
    if (f(middle) >= 0 === rising) high = middle;
    else low = middle;
  }
  return Math.round(high);
}

/** Whether a name is a time zone this runtime knows, such as `America/Indiana/Indianapolis`. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** How far local time is ahead of UTC at a moment, milliseconds. */
function offsetMs(timeMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(timeMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return local - Math.floor(timeMs / 1000) * 1000;
}

/** The beginning and end of the calendar day that a moment falls on in a time zone. 23 to 25 hours long. */
export function localDay(timeMs: number, timeZone: string): { start: number; end: number } {
  const local = new Date(timeMs + offsetMs(timeMs, timeZone));
  const midnight = (days: number) => {
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days);
    // The offset at midnight is not known before midnight is; the second try settles it across a clock change.
    const guess = wall - offsetMs(wall, timeZone);
    return wall - offsetMs(guess, timeZone);
  };
  return { start: midnight(0), end: midnight(1) };
}

/** A time of day such as `17:24`, in a time zone. */
export function localTime(timeMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timeMs);
}

/** What the clocks are on at a moment, such as `EST`. */
export function zoneAbbreviation(timeMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' }).formatToParts(timeMs);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}
