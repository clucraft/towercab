import {
  angleDiffDeg,
  M_PER_FT,
  M_PER_NM,
  type Phase,
  positionOnSegment,
  type Runway,
} from '@towercab/shared';

/**
 * Ground detection and flight phase. All thresholds live here so they can be tuned in one place.
 *
 * Why these numbers:
 * - Airliners send `alt_baro: "ground"` from their weight-on-wheels switch. Most light aircraft never do:
 *   on the ramp they report an ordinary altitude close to field elevation. So anything slow and within a
 *   small window of field elevation is treated as on the ground.
 * - 40 kt is below the stall speed of nearly everything that flies, so a slower aircraft at field elevation
 *   is taxiing. 150 ft covers altitude quantisation (25 or 100 ft), altimeter error and GNSS vertical error.
 * - Over a runway the window is tighter (50 ft) but has no speed limit, which is what puts a light aircraft's
 *   wheels on the runway during the take-off and landing roll.
 */
export const GROUND_MAX_GS_KT = 40;
export const GROUND_ALT_WINDOW_FT = 150;
export const RUNWAY_SURFACE_WINDOW_FT = 50;
/** Below this speed an aircraft is standing still; its track is noise. */
export const STATIONARY_GS_KT = 2;
/** At or above this speed on a runway an aircraft is rolling for take-off or after landing, not taxiing. */
export const ROLL_MIN_GS_KT = 30;
/** Standing still this long away from a runway means parked rather than holding. */
export const PARKED_AFTER_MS = 45_000;

const RUNWAY_END_MARGIN_M = 60;
const RUNWAY_SIDE_MARGIN_M = 15;
const FINAL_MAX_DISTANCE_M = 8 * M_PER_NM;
const FINAL_MAX_AGL_FT = 3500;
const FINAL_TRACK_TOLERANCE_DEG = 25;
/** Half-width of the final approach cone, as a fraction of the distance to the threshold (about 7 degrees). */
const FINAL_CONE = 0.12;
const FINAL_MIN_HALF_WIDTH_M = 150;
const PATTERN_MAX_AGL_FT = 2200;
const PATTERN_MIN_AGL_FT = 300;
const PATTERN_MAX_DISTANCE_NM = 4.5;
const CLIMB_FPM = 300;
const DESCENT_FPM = -300;

export interface GroundInput {
  /** `alt_baro` as sent: a number, the string `ground`, or null. */
  altBaro: number | 'ground' | null;
  /** Best altitude estimate above mean sea level, feet. */
  altMslFt: number | null;
  gsKt: number | null;
  fieldElevationFt: number;
  /** True when the position is over a runway surface. */
  overRunway: boolean;
}

export function isOnGround(input: GroundInput): boolean {
  if (input.altBaro === 'ground') return true;
  const gs = input.gsKt ?? 0;
  if (input.altMslFt == null) {
    // No altitude at all (some MLAT and Mode S targets). Only speed is left to go on.
    return input.gsKt != null && gs < GROUND_MAX_GS_KT;
  }
  const aglFt = input.altMslFt - input.fieldElevationFt;
  if (gs < GROUND_MAX_GS_KT && Math.abs(aglFt) <= GROUND_ALT_WINDOW_FT) return true;
  return input.overRunway && aglFt <= RUNWAY_SURFACE_WINDOW_FT;
}

/** The runway whose surface (plus a small margin) contains the point, or null. */
export function runwayAt(lat: number, lon: number, runways: readonly Runway[]): Runway | null {
  for (const runway of runways) {
    if (runway.closed) continue;
    const [a, b] = runway.ends;
    const pos = positionOnSegment(lat, lon, a.lat, a.lon, b.lat, b.lon);
    if (pos.lengthM === 0) continue;
    const halfWidth = (runway.widthFt * M_PER_FT) / 2 + RUNWAY_SIDE_MARGIN_M;
    if (
      pos.alongM >= -RUNWAY_END_MARGIN_M &&
      pos.alongM <= pos.lengthM + RUNWAY_END_MARGIN_M &&
      Math.abs(pos.crossM) <= halfWidth
    ) {
      return runway;
    }
  }
  return null;
}

/** The runway end an aircraft is lined up to land on, or null. */
export function finalApproachTo(
  lat: number,
  lon: number,
  trackDeg: number | null,
  runways: readonly Runway[],
): string | null {
  if (trackDeg == null) return null;
  for (const runway of runways) {
    if (runway.closed) continue;
    for (let i = 0; i < 2; i += 1) {
      const end = runway.ends[i as 0 | 1];
      const far = runway.ends[(1 - i) as 0 | 1];
      if (Math.abs(angleDiffDeg(trackDeg, end.headingTrue)) > FINAL_TRACK_TOLERANCE_DEG) continue;
      const pos = positionOnSegment(lat, lon, end.lat, end.lon, far.lat, far.lon);
      // Negative `alongM` is before the threshold, on the approach side.
      if (pos.alongM > 0 || pos.alongM < -FINAL_MAX_DISTANCE_M) continue;
      const halfWidth = Math.max(FINAL_MIN_HALF_WIDTH_M, -pos.alongM * FINAL_CONE);
      if (Math.abs(pos.crossM) <= halfWidth) return end.ident;
    }
  }
  return null;
}

/** What the classifier remembers about an aircraft between updates. */
export interface PhaseMemory {
  phase: Phase | null;
  /** When the aircraft was first seen standing still in the current stop, epoch ms. */
  stationarySince: number | null;
  /** Track over the ground when the aircraft last left the runway, for telling a pattern from a departure. */
  departureTrackDeg: number | null;
  lastDistNm: number | null;
  lastGsKt: number | null;
}

export function newPhaseMemory(): PhaseMemory {
  return { phase: null, stationarySince: null, departureTrackDeg: null, lastDistNm: null, lastGsKt: null };
}

export interface PhaseInput {
  onGround: boolean;
  lat: number;
  lon: number;
  gsKt: number | null;
  trackDeg: number | null;
  vertRateFpm: number | null;
  aglFt: number | null;
  /** Distance from the airport reference point. */
  distNm: number;
  runways: readonly Runway[];
  /** Time of the position, epoch ms. */
  time: number;
}

/**
 * Works out the phase and updates `memory` in place. Pure apart from that: the same inputs and memory always
 * give the same answer.
 */
export function classifyPhase(input: PhaseInput, memory: PhaseMemory): Phase {
  const phase = input.onGround ? groundPhase(input, memory) : airbornePhase(input, memory);
  if (input.onGround) memory.departureTrackDeg = null;
  memory.phase = phase;
  memory.lastDistNm = input.distNm;
  memory.lastGsKt = input.gsKt;
  return phase;
}

function groundPhase(input: PhaseInput, memory: PhaseMemory): Phase {
  const gs = input.gsKt ?? 0;
  const prev = memory.phase;
  const onRunway = runwayAt(input.lat, input.lon, input.runways) !== null;

  if (gs < STATIONARY_GS_KT) {
    if (memory.stationarySince == null) memory.stationarySince = input.time;
    // Stopped on a runway is lined up and waiting, or about to vacate: not parked.
    if (onRunway) return 'taxiing';
    // First sight of an aircraft that is already standing still: assume it is parked.
    if (prev == null || prev === 'parked') return 'parked';
    return input.time - memory.stationarySince >= PARKED_AFTER_MS ? 'parked' : 'taxiing';
  }
  memory.stationarySince = null;

  // Nothing taxis at 40 kt: that fast on the ground is a take-off or landing roll, even where the runway
  // data and the position do not quite line up.
  if (onRunway || gs >= GROUND_MAX_GS_KT) {
    const accelerating = memory.lastGsKt != null && gs > memory.lastGsKt + 3;
    if (gs >= ROLL_MIN_GS_KT) {
      if (prev === 'takeoff_roll') return 'takeoff_roll';
      // A touch-and-go: rolling out, then speeding up again.
      if (prev === 'landing_roll') return accelerating ? 'takeoff_roll' : 'landing_roll';
      if (prev === 'taxiing' || prev === 'parked') return 'takeoff_roll';
      if (prev != null) return 'landing_roll'; // was airborne a moment ago
      // First seen already rolling: there is no history to decide with. Speed building means take-off.
      return accelerating || memory.lastGsKt == null ? 'takeoff_roll' : 'landing_roll';
    }
    // Slow on the runway: still rolling out after landing, or the first seconds of a take-off roll.
    if (prev === 'landing_roll') return 'landing_roll';
    if (prev === 'takeoff_roll' && accelerating) return 'takeoff_roll';
  }
  return 'taxiing';
}

function airbornePhase(input: PhaseInput, memory: PhaseMemory): Phase {
  const prev = memory.phase;
  const vr = input.vertRateFpm ?? 0;
  const agl = input.aglFt;
  const closing = memory.lastDistNm != null && input.distNm < memory.lastDistNm - 0.005;
  const opening = memory.lastDistNm != null && input.distNm > memory.lastDistNm + 0.005;
  const lowAndClose =
    agl != null &&
    agl >= PATTERN_MIN_AGL_FT &&
    agl <= PATTERN_MAX_AGL_FT &&
    input.distNm <= PATTERN_MAX_DISTANCE_NM;

  // Lined up with a runway and low enough to land on it.
  if ((agl == null || agl <= FINAL_MAX_AGL_FT) && vr < CLIMB_FPM) {
    if (finalApproachTo(input.lat, input.lon, input.trackDeg, input.runways)) return 'arriving';
  }

  const justLeftGround =
    prev === 'takeoff_roll' || prev === 'taxiing' || prev === 'parked' || prev === 'landing_roll';
  if (justLeftGround) {
    memory.departureTrackDeg = input.trackDeg;
    return 'departing';
  }

  if (prev === 'departing') {
    // Closed traffic turns well away from the runway heading while still low and near the field.
    const turned =
      memory.departureTrackDeg != null &&
      input.trackDeg != null &&
      Math.abs(angleDiffDeg(memory.departureTrackDeg, input.trackDeg)) > 60;
    if (turned && lowAndClose && vr < 700) return 'pattern';
    return 'departing';
  }

  if (prev === 'pattern') {
    if (lowAndClose) return 'pattern';
    if (opening && vr >= 0) return 'departing';
  }

  if (prev === 'arriving' && vr < CLIMB_FPM && (closing || lowAndClose)) {
    return lowAndClose ? 'pattern' : 'arriving';
  }

  if (vr >= CLIMB_FPM && !closing) return 'departing';
  if (vr <= DESCENT_FPM && !opening) return 'arriving';
  if (lowAndClose) return 'pattern';
  if (prev === 'arriving') return prev;
  return 'transit';
}

/**
 * Direction to draw the nose. True heading when the aircraft sends it, otherwise track over the ground,
 * but never track while standing still: below about 2 kt it is noise, so the last good heading is kept.
 */
export function resolveHeading(
  previous: number | null,
  trueHeadingDeg: number | null,
  trackDeg: number | null,
  gsKt: number | null,
): number | null {
  if (trueHeadingDeg != null) return trueHeadingDeg;
  if (trackDeg == null) return previous;
  const moving = gsKt == null || gsKt >= STATIONARY_GS_KT;
  if (moving) return trackDeg;
  return previous ?? trackDeg;
}
