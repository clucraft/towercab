import { EARTH_RADIUS_M, MPS_PER_KT } from '@towercab/shared';

/**
 * Smooth motion between position reports.
 *
 * Reports arrive every couple of seconds. The scene is drawn a fixed delay behind real time, so that for any
 * moment being drawn there is normally a report before it and one after it to move between. This module is
 * plain arithmetic with no Cesium in it, so the rules that matter can be unit-tested:
 *
 * - interpolate between the two reports around the render time;
 * - when the next report is late, carry on along the last track at the last ground speed for at most 10 s,
 *   then fade out;
 * - when a late report shows the aircraft was somewhere else than assumed, close the gap gradually. The
 *   correction is spread out so that an aircraft is never drawn moving backwards along its path.
 */

/** One position report, reduced to what motion needs. */
export interface MotionSample {
  /** When the position was valid, epoch ms on the server clock. */
  t: number;
  lat: number;
  lon: number;
  /** Height above the ellipsoid in metres. Null on the ground: the scene supplies the surface height. */
  heightM: number | null;
  onGround: boolean;
  headingDeg: number | null;
  trackDeg: number | null;
  gsKt: number | null;
  vertRateFpm: number | null;
}

export interface MotionState {
  lat: number;
  lon: number;
  /** The reports being moved between, and how far along (0 to 1). They are the same report while holding. */
  from: MotionSample;
  to: MotionSample;
  u: number;
  /** Height gained (or lost) by dead reckoning since the last report, metres. Zero while interpolating. */
  extraHeightM: number;
  /** Direction the nose should point, before any smoothing. Null when nothing is known. */
  headingDeg: number | null;
  /** Speed over the ground right now, metres per second. */
  speedMps: number;
  vertRateFpm: number | null;
  onGround: boolean;
  /** 1 is solid, 0 is invisible. Drops when reports stop arriving. */
  alpha: number;
  /** How far the render time is past the newest report, milliseconds. Zero or less while interpolating. */
  overdueMs: number;
}

/** Keep dead-reckoning for this long after the last report. */
export const EXTRAPOLATE_MAX_MS = 10_000;
/** Then fade out over this long. */
export const FADE_OUT_MS = 3000;
/** A new aircraft fades in over this long rather than popping into view. */
export const FADE_IN_MS = 800;
/** Below this speed an aircraft is standing; it is neither dead-reckoned nor faded. */
const STANDING_KT = 2;
/** Reports older than this (relative to the render time) are no longer needed. */
const KEEP_BEHIND_MS = 20_000;

const RAD = Math.PI / 180;

function lerpAngleDeg(a: number, b: number, u: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return (a + d * u + 360) % 360;
}

function bearing(from: MotionSample, to: MotionSample): number | null {
  const north = (to.lat - from.lat) * RAD * EARTH_RADIUS_M;
  const east = (to.lon - from.lon) * RAD * EARTH_RADIUS_M * Math.cos(from.lat * RAD);
  if (Math.hypot(east, north) < 3) return null;
  return (Math.atan2(east, north) / RAD + 360) % 360;
}

export class MotionBuffer {
  private samples: MotionSample[] = [];
  /** What was last drawn, and how fast it was moving, in degrees and degrees per millisecond. */
  private lastOut: { t: number; lat: number; lon: number; vLat: number; vLon: number } | null = null;
  /** Set when a report arrives; the next `sample` call works out the correction it implies. */
  private blendPending = false;
  private offset: { dLat: number; dLon: number; t0: number; tauMs: number } | null = null;
  private firstSeenAt: number | null = null;

  get length(): number {
    return this.samples.length;
  }

  get newest(): MotionSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /**
   * Adds a report. Reports must arrive in time order: one that is not newer than the newest already held is
   * refused, which is the client half of "never go backwards in time".
   */
  push(sample: MotionSample): boolean {
    const newest = this.newest;
    if (newest && sample.t <= newest.t) return false;
    this.samples.push(sample);
    this.blendPending = true;
    return true;
  }

  /** Where to draw the aircraft at render time `t`. Null when no report has been received. */
  sample(t: number): MotionState | null {
    if (this.samples.length === 0) return null;
    this.prune(t);
    this.firstSeenAt ??= t;

    const raw = this.raw(t);
    let { lat, lon } = raw;

    if (this.blendPending) {
      this.blendPending = false;
      const last = this.lastOut;
      // Only meaningful when frames are flowing; after a pause, just take the new position.
      if (last && t - last.t >= 0 && t - last.t < 500) {
        const expectedLat = last.lat + last.vLat * (t - last.t);
        const expectedLon = last.lon + last.vLon * (t - last.t);
        const dLat = expectedLat - raw.lat;
        const dLon = expectedLon - raw.lon;
        const metres = Math.hypot(
          dLat * RAD * EARTH_RADIUS_M,
          dLon * RAD * EARTH_RADIUS_M * Math.cos(raw.lat * RAD),
        );
        if (metres > 0.05) {
          // Slow enough that the correction never outruns the aircraft: at most half its speed.
          const tauMs = Math.min(6000, Math.max(700, (2000 * metres) / Math.max(raw.speedMps, 3)));
          this.offset = { dLat, dLon, t0: t, tauMs };
        } else {
          this.offset = null;
        }
      } else {
        this.offset = null;
      }
    }

    if (this.offset) {
      const k = Math.exp(-(t - this.offset.t0) / this.offset.tauMs);
      if (k < 0.002) this.offset = null;
      else {
        lat += this.offset.dLat * k;
        lon += this.offset.dLon * k;
      }
    }

    const last = this.lastOut;
    if (last && t > last.t) {
      const dt = t - last.t;
      this.lastOut = { t, lat, lon, vLat: (lat - last.lat) / dt, vLon: (lon - last.lon) / dt };
    } else if (!last) {
      this.lastOut = { t, lat, lon, vLat: 0, vLon: 0 };
    }

    const fadeIn = Math.min(1, (t - this.firstSeenAt) / FADE_IN_MS);
    return { ...raw, lat, lon, alpha: Math.max(0, Math.min(raw.alpha, fadeIn)) };
  }

  /** Skips the fade-in, for aircraft that were already there when the page loaded. */
  settle(): void {
    this.firstSeenAt = Number.NEGATIVE_INFINITY;
  }

  private raw(t: number): MotionState {
    const samples = this.samples;
    const first = samples[0] as MotionSample;
    const last = samples[samples.length - 1] as MotionSample;

    if (t <= first.t) return hold(first, first.t - t > 0 ? -(first.t - t) : 0);

    if (t < last.t) {
      let i = samples.length - 2;
      while (i > 0 && (samples[i] as MotionSample).t > t) i -= 1;
      const a = samples[i] as MotionSample;
      const b = samples[i + 1] as MotionSample;
      const span = b.t - a.t;
      const u = span > 0 ? (t - a.t) / span : 1;
      const north = (b.lat - a.lat) * RAD * EARTH_RADIUS_M;
      const east = (b.lon - a.lon) * RAD * EARTH_RADIUS_M * Math.cos(a.lat * RAD);
      const moved = bearing(a, b);
      const headingA = a.headingDeg ?? moved ?? b.headingDeg;
      const headingB = b.headingDeg ?? moved ?? a.headingDeg;
      return {
        lat: a.lat + (b.lat - a.lat) * u,
        lon: a.lon + (b.lon - a.lon) * u,
        from: a,
        to: b,
        u,
        extraHeightM: 0,
        headingDeg:
          headingA != null && headingB != null ? lerpAngleDeg(headingA, headingB, u) : (headingA ?? headingB),
        speedMps: span > 0 ? Math.hypot(east, north) / (span / 1000) : 0,
        vertRateFpm: u < 0.5 ? a.vertRateFpm : b.vertRateFpm,
        onGround: u < 0.5 ? a.onGround : b.onGround,
        alpha: 1,
        overdueMs: t - last.t,
      };
    }

    // Past the newest report: dead reckoning.
    const overdueMs = t - last.t;
    const gsKt = last.gsKt ?? 0;
    const direction = last.trackDeg ?? last.headingDeg;
    const standing = gsKt < STANDING_KT || direction == null;
    if (standing) return hold(last, overdueMs);

    const seconds = Math.min(overdueMs, EXTRAPOLATE_MAX_MS) / 1000;
    const distance = gsKt * MPS_PER_KT * seconds;
    const north = distance * Math.cos(direction * RAD);
    const east = distance * Math.sin(direction * RAD);
    const alpha =
      overdueMs <= EXTRAPOLATE_MAX_MS ? 1 : Math.max(0, 1 - (overdueMs - EXTRAPOLATE_MAX_MS) / FADE_OUT_MS);
    return {
      lat: last.lat + north / EARTH_RADIUS_M / RAD,
      lon: last.lon + east / (EARTH_RADIUS_M * Math.cos(last.lat * RAD)) / RAD,
      from: last,
      to: last,
      u: 1,
      extraHeightM:
        last.onGround || last.vertRateFpm == null ? 0 : (last.vertRateFpm * 0.3048 * seconds) / 60,
      headingDeg: last.headingDeg ?? last.trackDeg,
      // Once the dead-reckoning limit is reached the aircraft is held where it is while it fades.
      speedMps: overdueMs <= EXTRAPOLATE_MAX_MS ? gsKt * MPS_PER_KT : 0,
      vertRateFpm: last.vertRateFpm,
      onGround: last.onGround,
      alpha,
      overdueMs,
    };
  }

  private prune(t: number): void {
    // Always keep the report just before the render time, plus everything after it.
    let drop = 0;
    while (
      drop < this.samples.length - 2 &&
      (this.samples[drop + 1] as MotionSample).t < t - KEEP_BEHIND_MS
    ) {
      drop += 1;
    }
    if (drop > 0) this.samples.splice(0, drop);
  }
}

function hold(sample: MotionSample, overdueMs: number): MotionState {
  return {
    lat: sample.lat,
    lon: sample.lon,
    from: sample,
    to: sample,
    u: 1,
    extraHeightM: 0,
    headingDeg: sample.headingDeg ?? sample.trackDeg,
    speedMps: 0,
    vertRateFpm: sample.vertRateFpm,
    onGround: sample.onGround,
    alpha: 1,
    overdueMs,
  };
}

/** Moves `current` towards `target` by at most `maxStep` degrees along the shorter way round. */
export function turnTowards(current: number, target: number, maxStep: number): number {
  const d = ((((target - current) % 360) + 540) % 360) - 180;
  if (Math.abs(d) <= maxStep) return (target + 360) % 360;
  return (current + Math.sign(d) * maxStep + 360) % 360;
}

/**
 * Nose-up angle for a climb or descent, in degrees. Follows the flight path angle (vertical speed over
 * ground speed), kept slight: an airliner climbing at 2,500 ft/min at 160 kt shows about nine degrees.
 */
export function pitchFromVerticalRate(
  vertRateFpm: number | null,
  speedMps: number,
  onGround: boolean,
): number {
  if (onGround || vertRateFpm == null || speedMps < 15) return 0;
  const climbMps = (vertRateFpm * 0.3048) / 60;
  const angle = Math.atan2(climbMps, speedMps) / RAD;
  return Math.max(-10, Math.min(15, angle));
}

/** Bank angle for a coordinated turn at the given speed and turn rate (degrees per second), in degrees. */
export function bankFromTurnRate(turnRateDegPerS: number, speedMps: number, onGround: boolean): number {
  if (onGround || speedMps < 20) return 0;
  const bank = Math.atan((speedMps * turnRateDegPerS * RAD) / 9.81) / RAD;
  return Math.max(-35, Math.min(35, bank));
}
