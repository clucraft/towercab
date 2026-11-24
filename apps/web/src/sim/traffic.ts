import {
  type Aircraft,
  type AirportInfo,
  bearingDeg,
  destinationPoint,
  M_PER_FT,
  normalizeDeg,
  type Phase,
  type RunwayEnd,
  toLocalEnu,
} from '@towercab/shared';

/**
 * Simulated traffic for one airport: aircraft flying circuits to every runway end, taxiing, and parked.
 * It exists to exercise the scene (frame rate with 150 aircraft, wheels on the runway, smooth motion) and to
 * demo the app when nothing is flying. It is deterministic: the same airport and count give the same traffic.
 */

interface Waypoint {
  /** Metres east and north of the airport reference point. */
  x: number;
  y: number;
  aglFt: number;
  gsKt: number;
  phase: Phase;
}

interface Route {
  /** Densely sampled path, with the time at which each point is reached. */
  points: (Waypoint & { t: number })[];
  /** Seconds for one lap. */
  period: number;
}

export interface SimAircraft {
  hex: string;
  callsign: string;
  registration: string;
  typeCode: string;
  category: string;
  operator?: string;
  route: Route;
  /** Where on its lap the aircraft is at time zero, seconds. */
  offset: number;
  /** Fixed heading for parked aircraft. */
  parkedHeading?: number;
}

const KT = 0.514444;

/** A small repeatable random number generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A smooth closed curve through the waypoints, so turns are curves rather than corners.
 *
 * Each segment is a cubic Hermite curve. The direction through a waypoint is the direction from the one
 * before it to the one after it; the tangent's length is tied to the shorter of the two adjoining segments.
 * A plain Catmull-Rom spline would overshoot where a long leg meets a short one, and an aircraft would be
 * seen backing up for an instant after touchdown.
 */
function smooth(waypoints: Waypoint[], perSegment: number): Waypoint[] {
  const n = waypoints.length;
  const out: Waypoint[] = [];
  const tangent = (before: Waypoint, at: Waypoint, after: Waypoint, segment: number): [number, number] => {
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    const reach = Math.min(
      Math.hypot(at.x - before.x, at.y - before.y),
      Math.hypot(after.x - at.x, after.y - at.y),
    );
    const scale = Math.min(reach, segment) / length;
    return [dx * scale, dy * scale];
  };
  for (let i = 0; i < n; i += 1) {
    const p0 = waypoints[(i - 1 + n) % n] as Waypoint;
    const p1 = waypoints[i] as Waypoint;
    const p2 = waypoints[(i + 1) % n] as Waypoint;
    const p3 = waypoints[(i + 2) % n] as Waypoint;
    // Straight, unsmoothed motion on the ground: aircraft roll along the centreline.
    const straight = p1.aglFt === 0 && p2.aglFt === 0;
    const segment = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const m1 = tangent(p0, p1, p2, segment);
    const m2 = tangent(p1, p2, p3, segment);
    for (let k = 0; k < perSegment; k += 1) {
      const u = k / perSegment;
      const hermite = (a: number, ma: number, b: number, mb: number) =>
        straight
          ? a + (b - a) * u
          : (2 * u ** 3 - 3 * u ** 2 + 1) * a +
            (u ** 3 - 2 * u ** 2 + u) * ma +
            (-2 * u ** 3 + 3 * u ** 2) * b +
            (u ** 3 - u ** 2) * mb;
      out.push({
        x: hermite(p1.x, m1[0], p2.x, m2[0]),
        y: hermite(p1.y, m1[1], p2.y, m2[1]),
        aglFt: Math.max(0, p1.aglFt + (p2.aglFt - p1.aglFt) * u),
        gsKt: p1.gsKt + (p2.gsKt - p1.gsKt) * u,
        phase: p1.phase,
      });
    }
  }
  return out;
}

function timed(points: Waypoint[], closed: boolean): Route {
  const out: Route['points'] = [];
  let t = 0;
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i] as Waypoint;
    out.push({ ...p, t });
    const next = points[(i + 1) % points.length] as Waypoint;
    if (i === points.length - 1 && !closed) break;
    const distance = Math.hypot(next.x - p.x, next.y - p.y);
    const speed = Math.max(1.5, ((p.gsKt + next.gsKt) / 2) * KT);
    t += distance / speed;
  }
  return { points: out, period: Math.max(1, t) };
}

interface CircuitOptions {
  patternKt: number;
  finalKt: number;
  rotateKt: number;
  patternAglFt: number;
  /** Distance of the downwind leg from the runway, metres. */
  lateralM: number;
  /** How far past the threshold the downwind leg continues, metres. */
  extendM: number;
  /** 1 for a left-hand circuit, -1 for right-hand. */
  side: 1 | -1;
}

/** A touch-and-go circuit to one runway end. */
function circuit(airport: AirportInfo, end: RunwayEnd, far: RunwayEnd, o: CircuitOptions): Route {
  const origin = toLocalEnu(airport.lat, airport.lon, end.lat, end.lon);
  const farLocal = toLocalEnu(airport.lat, airport.lon, far.lat, far.lon);
  const length = Math.hypot(farLocal.east - origin.east, farLocal.north - origin.north);
  const ux = (farLocal.east - origin.east) / length;
  const uy = (farLocal.north - origin.north) / length;
  // Left of the direction of travel.
  const lx = -uy * o.side;
  const ly = ux * o.side;
  const at = (along: number, lateral: number, aglFt: number, gsKt: number, phase: Phase): Waypoint => ({
    x: origin.east + ux * along + lx * lateral,
    y: origin.north + uy * along + ly * lateral,
    aglFt,
    gsKt,
    phase,
  });
  const liftOff = Math.min(length * 0.55, 420 + o.rotateKt * 6);
  const waypoints: Waypoint[] = [
    at(280, 0, 0, o.finalKt * 0.92, 'landing_roll'),
    at(280 + (liftOff - 280) * 0.5, 0, 0, o.finalKt * 0.8, 'takeoff_roll'),
    at(liftOff, 0, 0, o.rotateKt, 'takeoff_roll'),
    at(length + 350, 0, o.patternAglFt * 0.45, o.patternKt * 0.9, 'departing'),
    at(
      length + 650 + o.lateralM * 0.2,
      o.lateralM * 0.4,
      o.patternAglFt * 0.75,
      o.patternKt * 0.95,
      'departing',
    ),
    at(length + 450, o.lateralM, o.patternAglFt, o.patternKt, 'pattern'),
    at(length * 0.4, o.lateralM, o.patternAglFt, o.patternKt, 'pattern'),
    at(-o.extendM, o.lateralM, o.patternAglFt, o.patternKt * 0.95, 'pattern'),
    at(-o.extendM - o.lateralM * 0.18, o.lateralM * 0.45, o.patternAglFt * 0.72, o.finalKt * 1.15, 'pattern'),
    at(-o.extendM * 0.82, 0, o.patternAglFt * 0.5, o.finalKt * 1.05, 'arriving'),
    at(-o.extendM * 0.4, 0, o.patternAglFt * 0.26, o.finalKt, 'arriving'),
    at(0, 0, 45, o.finalKt, 'arriving'),
  ];
  return timed(smooth(waypoints, 8), true);
}

/** Back and forth along a line beside the runway, at taxi speed. */
function taxiLoop(
  airport: AirportInfo,
  end: RunwayEnd,
  far: RunwayEnd,
  lateralM: number,
  fraction: number,
): Route {
  const a = toLocalEnu(airport.lat, airport.lon, end.lat, end.lon);
  const b = toLocalEnu(airport.lat, airport.lon, far.lat, far.lon);
  const length = Math.hypot(b.east - a.east, b.north - a.north);
  const ux = (b.east - a.east) / length;
  const uy = (b.north - a.north) / length;
  const at = (along: number, lateral: number, gsKt: number): Waypoint => ({
    x: a.east + ux * along - uy * lateral,
    y: a.north + uy * along + ux * lateral,
    aglFt: 0,
    gsKt,
    phase: 'taxiing',
  });
  const start = length * (0.5 - fraction / 2);
  const stop = length * (0.5 + fraction / 2);
  // Out along one line, a tight turn, and back along a parallel line 30 m over.
  const waypoints = [
    at(start, lateralM, 14),
    at(stop, lateralM, 14),
    at(stop + 18, lateralM + 15, 6),
    at(stop, lateralM + 30, 14),
    at(start, lateralM + 30, 14),
    at(start - 18, lateralM + 15, 6),
  ];
  return timed(smooth(waypoints, 6), true);
}

const GA = ['C172', 'P28A', 'SR22', 'PA44', 'DA40', 'C182', 'BE58', 'C152'];
const TURBINE = ['PC12', 'C25B', 'E55P', 'CL30', 'BE20'];
const AIRLINERS = [
  'CRJ9',
  'E75L',
  'A320',
  'B738',
  'A321',
  'B752',
  'B763',
  'B77L',
  'MD11',
  'A306',
  'CRJ2',
  'B38M',
];
const AIRLINES = ['FDX', 'RPA', 'SWA', 'DAL', 'AAL', 'UAL', 'ENY', 'SKW'];

/** Builds `count` aircraft for an airport: about 60% flying circuits, 20% taxiing, 20% parked. */
export function createTraffic(airport: AirportInfo, count: number, seed = 20261124): SimAircraft[] {
  const random = rng(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const runways = airport.runways.filter((r) => !r.closed);
  const out: SimAircraft[] = [];
  if (runways.length === 0) return out;
  const longest = [...runways].sort((a, b) => b.lengthFt - a.lengthFt)[0] ?? runways[0];
  if (!longest) return out;
  const bigField = longest.lengthFt >= 8000;

  for (let i = 0; i < count; i += 1) {
    const hex = `5${i.toString(16).padStart(5, '0')}`;
    const role = i % 5 === 3 ? 'taxi' : i % 5 === 4 ? 'parked' : 'circuit';
    const kind = bigField
      ? random() < 0.55
        ? 'airliner'
        : random() < 0.5
          ? 'turbine'
          : 'ga'
      : random() < 0.85
        ? 'ga'
        : 'turbine';
    const typeCode = pick(kind === 'airliner' ? AIRLINERS : kind === 'turbine' ? TURBINE : GA);
    const registration = `N${100 + ((i * 37) % 900)}${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + ((i * 7) % 26))}`;
    const callsign = kind === 'airliner' ? `${pick(AIRLINES)}${100 + ((i * 53) % 2900)}` : registration;
    const category =
      kind === 'airliner'
        ? typeCode.startsWith('B7') || typeCode === 'MD11' || typeCode === 'A306'
          ? 'A5'
          : 'A3'
        : kind === 'turbine'
          ? 'A2'
          : 'A1';

    let route: Route;
    let parkedHeading: number | undefined;
    if (role === 'circuit') {
      const runway = runways[i % runways.length] ?? longest;
      const flip = Math.floor(i / runways.length) % 2 === 0;
      const end = flip ? runway.ends[0] : runway.ends[1];
      const far = flip ? runway.ends[1] : runway.ends[0];
      const speeds =
        kind === 'airliner'
          ? {
              patternKt: 170 + random() * 20,
              finalKt: 135 + random() * 10,
              rotateKt: 140,
              patternAglFt: 1500 + Math.floor(random() * 5) * 300,
            }
          : kind === 'turbine'
            ? {
                patternKt: 135 + random() * 15,
                finalKt: 105 + random() * 10,
                rotateKt: 100,
                patternAglFt: 1200 + Math.floor(random() * 4) * 250,
              }
            : {
                patternKt: 85 + random() * 12,
                finalKt: 65 + random() * 8,
                rotateKt: 58,
                patternAglFt: 800 + Math.floor(random() * 4) * 150,
              };
      const scale = kind === 'airliner' ? 3.6 : kind === 'turbine' ? 2.2 : 1;
      route = circuit(airport, end, far, {
        ...speeds,
        lateralM: (1100 + random() * 900) * scale,
        extendM: (1300 + random() * 1100) * scale,
        side: random() < 0.5 ? 1 : -1,
      });
    } else if (role === 'taxi') {
      const runway = runways[i % runways.length] ?? longest;
      route = taxiLoop(
        airport,
        runway.ends[0],
        runway.ends[1],
        190 + (i % 4) * 55 * (random() < 0.5 ? 1 : -1),
        0.35 + random() * 0.4,
      );
    } else {
      // Parked in rows on one side of the longest runway.
      const a = toLocalEnu(airport.lat, airport.lon, longest.ends[0].lat, longest.ends[0].lon);
      const b = toLocalEnu(airport.lat, airport.lon, longest.ends[1].lat, longest.ends[1].lon);
      const length = Math.hypot(b.east - a.east, b.north - a.north);
      const ux = (b.east - a.east) / length;
      const uy = (b.north - a.north) / length;
      const slot = Math.floor(i / 5);
      const row = slot % 3;
      const along = length * 0.3 + (Math.floor(slot / 3) % 14) * (kind === 'airliner' ? 62 : 22);
      const lateral = 420 + row * (kind === 'airliner' ? 75 : 28);
      route = timed(
        [
          {
            x: a.east + ux * along - uy * lateral,
            y: a.north + uy * along + ux * lateral,
            aglFt: 0,
            gsKt: 0,
            phase: 'parked',
          },
        ],
        false,
      );
      parkedHeading = normalizeDeg(longest.ends[0].headingTrue + 90 + (row % 2) * 180);
    }
    out.push({
      hex,
      callsign,
      registration,
      typeCode,
      category,
      operator: kind === 'airliner' ? 'SIMULATED AIRLINE' : undefined,
      route,
      offset: random() * route.period,
      parkedHeading,
    });
  }
  return out;
}

/** The state of one simulated aircraft at `timeMs`, in the same shape the server sends. */
export function simulate(aircraft: SimAircraft, airport: AirportInfo, timeMs: number): Aircraft {
  const { route } = aircraft;
  const points = route.points;
  const at = (seconds: number) => {
    if (points.length === 1) return points[0] as Route['points'][number];
    const t = (((seconds + aircraft.offset) % route.period) + route.period) % route.period;
    let i = 0;
    // The routes are short; a linear scan from a guessed index is plenty.
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((points[mid] as { t: number }).t <= t) lo = mid;
      else hi = mid - 1;
    }
    i = lo;
    const p = points[i] as Route['points'][number];
    const q = points[(i + 1) % points.length] as Route['points'][number];
    const end = i === points.length - 1 ? route.period : q.t;
    const u = end > p.t ? (t - p.t) / (end - p.t) : 0;
    return {
      x: p.x + (q.x - p.x) * u,
      y: p.y + (q.y - p.y) * u,
      aglFt: p.aglFt + (q.aglFt - p.aglFt) * u,
      gsKt: p.gsKt + (q.gsKt - p.gsKt) * u,
      phase: p.phase,
      t,
    };
  };
  const seconds = timeMs / 1000;
  const now = at(seconds);
  const ahead = at(seconds + 1);
  const toLatLon = (x: number, y: number) => {
    const distance = Math.hypot(x, y);
    return destinationPoint(airport.lat, airport.lon, (Math.atan2(x, y) * 180) / Math.PI, distance);
  };
  const here = toLatLon(now.x, now.y);
  const next = toLatLon(ahead.x, ahead.y);
  const moving = Math.hypot(ahead.x - now.x, ahead.y - now.y) > 0.3;
  const heading = moving ? bearingDeg(here.lat, here.lon, next.lat, next.lon) : (aircraft.parkedHeading ?? 0);
  const onGround = now.aglFt < 1;
  const vertRate = Math.round(((ahead.aglFt - now.aglFt) * 60) / 25) * 25;

  const result: Aircraft = {
    hex: aircraft.hex,
    addrType: 'adsb_icao',
    callsign: aircraft.callsign,
    registration: aircraft.registration,
    typeCode: aircraft.typeCode,
    category: aircraft.category,
    lat: Math.round(here.lat * 1e6) / 1e6,
    lon: Math.round(here.lon * 1e6) / 1e6,
    posTime: Math.round(timeMs),
    seenTime: Math.round(timeMs),
    altSource: onGround ? 'ground' : 'geom',
    onGround,
    aglFt: onGround ? 0 : Math.round(now.aglFt),
    gsKt: Math.round(now.gsKt * 10) / 10,
    trackDeg: Math.round(heading * 10) / 10,
    headingDeg: Math.round(heading * 10) / 10,
    squawk: '1200',
    phase: onGround && now.gsKt < 2 ? 'parked' : now.phase,
    source: 'simulator',
  };
  if (aircraft.operator) result.operator = aircraft.operator;
  if (!onGround) {
    result.altMslFt = Math.round(airport.elevationFt + now.aglFt);
    result.altGeomFt = Math.round((airport.elevationEllipsoidM + now.aglFt * M_PER_FT) / M_PER_FT);
    result.heightM = Math.round((airport.elevationEllipsoidM + now.aglFt * M_PER_FT) * 10) / 10;
    result.vertRateFpm = vertRate;
  }
  return result;
}
