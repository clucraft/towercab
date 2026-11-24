import {
  type Aircraft,
  bearingDeg,
  distanceM,
  distanceNm,
  estimateAltitude,
  type Phase,
  type Runway,
  type TrailPoint,
} from '@towercab/shared';
import type { Observation } from '../providers/types';
import {
  classifyPhase,
  isOnGround,
  newPhaseMemory,
  PARKED_AFTER_MS,
  type PhaseMemory,
  resolveHeading,
  runwayAt,
} from './classify';

/** What the tracker needs to know about its airport. Read fresh on every commit, so METAR updates apply. */
export interface TrackerContext {
  lat: number;
  lon: number;
  elevationFt: number;
  geoidUndulationM: number;
  radiusNm: number;
  ceilingFtAgl: number;
  runways: readonly Runway[];
  /** Altimeter setting from the METAR, when there is one. */
  qnhHpa: number | null;
  /** Surface temperature from the METAR, for the temperature correction of barometric altitudes. */
  tempC?: number | null;
}

export interface TrackerOptions {
  /** How long a 10-minute trail is kept per aircraft. */
  historyMs?: number;
  /** Trail points closer together than this are skipped. */
  historyMinSpacingMs?: number;
}

export interface TrackerDelta {
  upserts: Aircraft[];
  removed: string[];
}

/** Positions this close in time count as the same moment; the higher-priority source wins. */
const TIE_MS = 250;
/** A less accurate source may not replace a better one unless the better position is this old. */
const QUALITY_HOLD_MS = 10_000;
/** Above the ceiling an aircraft that is already shown stays until it climbs this much further. */
const CEILING_HYSTERESIS_FT = 300;
/** Standing this still, an old position is still the right position. */
const STATIONARY_GS_KT = 5;
/** A track is worked out from two positions only when they are at least this far apart. */
const MIN_MOVE_FOR_TRACK_M = 8;
const SHADOW_BASE_NM = 0.3;
const SHADOW_MAX_ALT_DIFF_FT = 500;

interface Track {
  hex: string;
  obs: Observation;
  priority: number;
  /** Local time an observation for this aircraft last arrived, whether or not its position was newer. */
  lastHeardAt: number;
  /** Position time of the state last sent to clients. */
  publishedPosTime: number;
  published: Aircraft | null;
  dirty: boolean;
  heading: number | null;
  memory: PhaseMemory;
  history: TrailPoint[];
  /** Latest altimeter setting the aircraft itself reports (`nav_qnh`). */
  navQnhHpa: number | null;
  overRunway: boolean;
}

/**
 * Per-airport state: merges observations from every source into one track per aircraft, classifies them and
 * reports what changed.
 *
 * Merging rules:
 * - one track per ICAO hex, holding the freshest position (position time = data time - seen_pos);
 * - when two positions are equally fresh, the source with the lower priority number wins (the local receiver);
 * - a position that is not newer than the one already sent to clients is never accepted;
 * - an aircraft is removed once nothing has been heard about it for `staleAfterMs`;
 * - TIS-B / ADS-R shadows of a real ADS-B track are suppressed.
 */
export class AirportTracker {
  private readonly tracks = new Map<string, Track>();
  private readonly historyMs: number;
  private readonly historyMinSpacingMs: number;

  constructor(
    private readonly context: () => TrackerContext,
    options: TrackerOptions = {},
  ) {
    this.historyMs = options.historyMs ?? 600_000;
    this.historyMinSpacingMs = options.historyMinSpacingMs ?? 1000;
  }

  get size(): number {
    let n = 0;
    for (const t of this.tracks.values()) if (t.published) n += 1;
    return n;
  }

  /** Feeds one source's observations in. Nothing is visible to clients until `commit`. */
  ingest(observations: readonly Observation[], priority: number, receivedAt: number): void {
    for (const obs of observations) {
      const track = this.tracks.get(obs.hex);
      if (!track) {
        this.tracks.set(obs.hex, {
          hex: obs.hex,
          obs: { ...obs },
          priority,
          lastHeardAt: receivedAt,
          publishedPosTime: Number.NEGATIVE_INFINITY,
          published: null,
          dirty: true,
          heading: null,
          memory: newPhaseMemory(),
          history: [],
          navQnhHpa: obs.navQnhHpa ?? null,
          overRunway: false,
        });
        continue;
      }
      track.lastHeardAt = Math.max(track.lastHeardAt, receivedAt);
      if (obs.navQnhHpa != null) track.navQnhHpa = obs.navQnhHpa;
      if (acceptsPosition(track, obs, priority)) {
        const previous = track.obs;
        track.obs = { ...obs };
        carryMetadata(track.obs, previous);
        track.priority = priority;
        track.dirty = true;
      } else if (fillMetadata(track.obs, obs)) {
        track.dirty = true;
      }
    }
  }

  /**
   * Applies everything ingested since the last commit and returns the changes to send.
   * `staleAfterMs` is 30 s while polling fast; the caller raises it when polling slowly.
   */
  commit(now: number, staleAfterMs = 30_000): TrackerDelta {
    const ctx = this.context();
    const upserts: Aircraft[] = [];
    const removed: string[] = [];
    const candidates: { track: Track; aircraft: Aircraft }[] = [];

    for (const track of this.tracks.values()) {
      if (now - track.lastHeardAt > staleAfterMs) {
        if (track.published) removed.push(track.hex);
        this.tracks.delete(track.hex);
        continue;
      }
      // A source can keep listing an aircraft for a minute after its last position. For anything that
      // moves, a position that old is wrong, so it stops being shown; a parked aircraft stays.
      const standing = track.obs.altBaro === 'ground' || track.published?.onGround === true;
      const stationary = standing && (track.obs.gsKt ?? 0) < STATIONARY_GS_KT;
      const expired = !stationary && now - track.obs.posTime > staleAfterMs;
      const aircraft = expired ? null : this.derive(track, ctx, now);
      if (aircraft) candidates.push({ track, aircraft });
      else if (track.published) {
        // Left the geofence, went stale, or lost the altitude needed to draw it.
        removed.push(track.hex);
        track.published = null;
      }
    }

    const shadows = findShadows(candidates.map((c) => c.aircraft));
    for (const { track, aircraft } of candidates) {
      if (shadows.has(aircraft.hex)) {
        if (track.published) removed.push(track.hex);
        track.published = null;
        continue;
      }
      const changed = track.dirty || !track.published || track.published.phase !== aircraft.phase;
      track.dirty = false;
      if (!changed) continue;
      this.recordHistory(track, aircraft, now);
      track.published = aircraft;
      track.publishedPosTime = aircraft.posTime;
      upserts.push(aircraft);
    }
    return { upserts, removed };
  }

  /** Everything currently visible, with trails. Sent to a browser when it subscribes. */
  snapshot(
    trailMs = 180_000,
    now = Date.now(),
  ): { aircraft: Aircraft[]; trails: Record<string, TrailPoint[]> } {
    const aircraft: Aircraft[] = [];
    const trails: Record<string, TrailPoint[]> = {};
    const cutoff = now - trailMs;
    for (const track of this.tracks.values()) {
      if (!track.published) continue;
      aircraft.push(track.published);
      const trail = track.history.filter((p) => p[0] >= cutoff);
      if (trail.length > 1) trails[track.hex] = trail;
    }
    return { aircraft, trails };
  }

  /** Median altimeter setting reported by the aircraft themselves: a stand-in when there is no METAR. */
  aircraftQnhHpa(): number | null {
    const values: number[] = [];
    for (const t of this.tracks.values()) if (t.navQnhHpa != null) values.push(t.navQnhHpa);
    if (values.length === 0) return null;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] ?? null;
  }

  /** Forgets everything. Used when polling pauses, so a later viewer is not shown stale traffic. */
  clear(): string[] {
    const removed: string[] = [];
    for (const t of this.tracks.values()) if (t.published) removed.push(t.hex);
    this.tracks.clear();
    return removed;
  }

  private derive(track: Track, ctx: TrackerContext, now: number): Aircraft | null {
    if (!track.dirty) {
      // Nothing new was heard. The only thing time alone changes is an aircraft that has now been
      // standing still long enough to count as parked.
      const current = track.published;
      if (!current) return null;
      const since = track.memory.stationarySince;
      if (
        current.phase === 'taxiing' &&
        !track.overRunway &&
        since != null &&
        now - since >= PARKED_AFTER_MS
      ) {
        track.memory.phase = 'parked';
        return { ...current, phase: 'parked' };
      }
      return current;
    }

    const obs = track.obs;
    const distNm = distanceNm(ctx.lat, ctx.lon, obs.lat, obs.lon);
    if (distNm > ctx.radiusNm) return null;

    const altBaroFt = typeof obs.altBaro === 'number' ? obs.altBaro : null;
    const estimate = estimateAltitude({
      altGeomFt: obs.altGeomFt,
      altBaroFt,
      qnhHpa: ctx.qnhHpa,
      geoidUndulationM: ctx.geoidUndulationM,
      station: { elevationFt: ctx.elevationFt, tempC: ctx.tempC },
    });
    const overRunway = runwayAt(obs.lat, obs.lon, ctx.runways) !== null;
    track.overRunway = overRunway;
    const onGround = isOnGround({
      altBaro: obs.altBaro,
      altMslFt: estimate.mslFt,
      gsKt: obs.gsKt,
      fieldElevationFt: ctx.elevationFt,
      overRunway,
    });
    // An airborne aircraft with no altitude at all cannot be placed in the scene.
    if (!onGround && estimate.ellipsoidM == null) return null;

    const aglFt = estimate.mslFt == null ? null : estimate.mslFt - ctx.elevationFt;
    if (!onGround && aglFt != null) {
      const ceiling = ctx.ceilingFtAgl + (track.published ? CEILING_HYSTERESIS_FT : 0);
      if (aglFt > ceiling) return null;
    }

    // Surface position messages often carry no track. When the aircraft sends neither heading nor track,
    // the direction it has just moved in is the next best thing.
    let trackDeg = obs.trackDeg;
    const last = track.published;
    if (trackDeg == null && obs.trueHeadingDeg == null && last && last.posTime < obs.posTime) {
      if (distanceM(last.lat, last.lon, obs.lat, obs.lon) >= MIN_MOVE_FOR_TRACK_M) {
        trackDeg = bearingDeg(last.lat, last.lon, obs.lat, obs.lon);
      }
    }
    track.heading = resolveHeading(track.heading, obs.trueHeadingDeg, trackDeg, obs.gsKt);
    const vertRateFpm = obs.baroRateFpm ?? obs.geomRateFpm;
    const phase: Phase = classifyPhase(
      {
        onGround,
        lat: obs.lat,
        lon: obs.lon,
        gsKt: obs.gsKt,
        trackDeg: trackDeg ?? track.heading,
        vertRateFpm,
        aglFt: onGround ? 0 : aglFt,
        distNm,
        runways: ctx.runways,
        time: obs.posTime,
      },
      track.memory,
    );

    const aircraft: Aircraft = {
      hex: obs.hex,
      addrType: obs.addrType,
      lat: round(obs.lat, 6),
      lon: round(obs.lon, 6),
      posTime: Math.round(obs.posTime),
      seenTime: Math.round(obs.seenTime),
      altSource: onGround ? 'ground' : estimate.source,
      onGround,
      phase,
      source: obs.source,
    };
    if (obs.callsign) aircraft.callsign = obs.callsign;
    if (obs.registration) aircraft.registration = obs.registration;
    if (obs.typeCode) aircraft.typeCode = obs.typeCode;
    if (obs.typeDesc) aircraft.typeDesc = obs.typeDesc;
    if (obs.operator) aircraft.operator = obs.operator;
    if (obs.category) aircraft.category = obs.category;
    if (altBaroFt != null) aircraft.altBaroFt = Math.round(altBaroFt);
    if (obs.altGeomFt != null) aircraft.altGeomFt = Math.round(obs.altGeomFt);
    if (estimate.mslFt != null) aircraft.altMslFt = Math.round(estimate.mslFt);
    if (!onGround && estimate.ellipsoidM != null) aircraft.heightM = round(estimate.ellipsoidM, 1);
    if (onGround) aircraft.aglFt = 0;
    else if (aglFt != null) aircraft.aglFt = Math.round(aglFt);
    if (obs.gsKt != null) aircraft.gsKt = round(obs.gsKt, 1);
    if (trackDeg != null) aircraft.trackDeg = round(trackDeg, 1);
    if (track.heading != null) aircraft.headingDeg = round(track.heading, 1);
    if (vertRateFpm != null) aircraft.vertRateFpm = Math.round(vertRateFpm);
    if (obs.squawk) aircraft.squawk = obs.squawk;
    if (obs.emergency) aircraft.emergency = obs.emergency;
    if (obs.rssi != null) aircraft.rssi = obs.rssi;
    if (obs.nic != null) aircraft.nic = obs.nic;
    if (obs.nacP != null) aircraft.nacP = obs.nacP;
    return aircraft;
  }

  private recordHistory(track: Track, aircraft: Aircraft, now: number): void {
    const last = track.history[track.history.length - 1];
    const moved = !last || last[1] !== aircraft.lat || last[2] !== aircraft.lon;
    if (moved && (!last || aircraft.posTime - last[0] >= this.historyMinSpacingMs)) {
      track.history.push([aircraft.posTime, aircraft.lat, aircraft.lon, aircraft.heightM ?? null]);
    }
    const cutoff = now - this.historyMs;
    let drop = 0;
    while (drop < track.history.length && (track.history[drop] as TrailPoint)[0] < cutoff) drop += 1;
    if (drop > 0) track.history.splice(0, drop);
  }
}

/** ADS-B beats MLAT, which beats radar-derived TIS-B. */
function sourceQuality(addrType: string): number {
  if (addrType.startsWith('adsb') || addrType.startsWith('adsr')) return 3;
  if (addrType === 'mlat') return 2;
  if (addrType.startsWith('tisb')) return 1;
  return 2;
}

function acceptsPosition(track: Track, obs: Observation, priority: number): boolean {
  // Never go back in time relative to what clients have already been shown.
  if (obs.posTime <= track.publishedPosTime) return false;
  const current = track.obs;
  const delta = obs.posTime - current.posTime;
  if (
    sourceQuality(obs.addrType) < sourceQuality(current.addrType) &&
    obs.posTime - current.posTime < QUALITY_HOLD_MS
  ) {
    return false;
  }
  if (delta > TIE_MS) return true;
  if (delta < -TIE_MS) return false;
  if (priority !== track.priority) return priority < track.priority;
  return delta > 0;
}

const METADATA_KEYS = [
  'callsign',
  'registration',
  'typeCode',
  'typeDesc',
  'operator',
  'category',
  'squawk',
] as const;

/** Keeps identity fields the new observation lacks. Sources differ in how much database detail they add. */
function carryMetadata(target: Observation, previous: Observation): void {
  for (const key of METADATA_KEYS) {
    if (target[key] === undefined && previous[key] !== undefined) target[key] = previous[key];
  }
}

/** Fills identity fields from an observation whose position was not used. Returns true if anything was added. */
function fillMetadata(target: Observation, other: Observation): boolean {
  let changed = false;
  for (const key of METADATA_KEYS) {
    if (target[key] === undefined && other[key] !== undefined) {
      target[key] = other[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Finds TIS-B / ADS-R targets that duplicate a real ADS-B track. readsb marks non-ICAO addresses with `~`;
 * such a target is a shadow when a real aircraft is close by at a similar altitude, and their callsigns match
 * (or at least one of them has none).
 */
export function findShadows(aircraft: readonly Aircraft[]): Set<string> {
  const shadows = new Set<string>();
  const real = aircraft.filter((a) => !a.hex.startsWith('~'));
  for (const candidate of aircraft) {
    if (!candidate.hex.startsWith('~')) continue;
    for (const other of real) {
      if (candidate.callsign && other.callsign && candidate.callsign !== other.callsign) continue;
      if (
        candidate.altMslFt != null &&
        other.altMslFt != null &&
        Math.abs(candidate.altMslFt - other.altMslFt) > SHADOW_MAX_ALT_DIFF_FT
      ) {
        continue;
      }
      if (candidate.onGround !== other.onGround) continue;
      // Radar-derived positions lag; allow for the distance flown between the two position times.
      const dtS = Math.min(15, Math.abs(candidate.posTime - other.posTime) / 1000);
      const speedKt = Math.max(candidate.gsKt ?? 0, other.gsKt ?? 0);
      const allowanceNm = SHADOW_BASE_NM + (speedKt * dtS) / 3600;
      if (distanceNm(candidate.lat, candidate.lon, other.lat, other.lon) <= allowanceNm) {
        shadows.add(candidate.hex);
        break;
      }
    }
  }
  return shadows;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
