import { z } from 'zod';

/**
 * What an aircraft is doing relative to the airport. The build prompt lists seven phases; `transit` is added
 * for traffic inside the geofence that is neither arriving, departing nor in the pattern.
 */
export const PHASES = [
  'parked',
  'taxiing',
  'takeoff_roll',
  'departing',
  'arriving',
  'landing_roll',
  'pattern',
  'transit',
] as const;
export const PhaseSchema = z.enum(PHASES);
export type Phase = z.infer<typeof PhaseSchema>;

export const PHASE_LABELS: Record<Phase, string> = {
  parked: 'Parked',
  taxiing: 'Taxiing',
  takeoff_roll: 'Takeoff roll',
  departing: 'Departing',
  arriving: 'Arriving',
  landing_roll: 'Landing roll',
  pattern: 'Pattern',
  transit: 'Transit',
};

export const AltitudeSourceSchema = z.enum(['geom', 'baro-qnh', 'baro-std', 'ground', 'none']);

const finite = z.number().refine(Number.isFinite, 'must be finite');

/**
 * One tracked aircraft as sent to browsers. Optional fields are simply absent when unknown, which keeps
 * WebSocket messages small.
 */
export const AircraftSchema = z.object({
  /** 24-bit ICAO address, lower-case hex. Non-ICAO addresses (TIS-B track files) start with `~`. */
  hex: z.string().min(1),
  /** readsb `type`: adsb_icao, adsr_icao, tisb_icao, mlat, mode_s, … */
  addrType: z.string(),
  callsign: z.string().optional(),
  registration: z.string().optional(),
  /** ICAO type designator, e.g. `C172`. */
  typeCode: z.string().optional(),
  typeDesc: z.string().optional(),
  operator: z.string().optional(),
  /** ADS-B emitter category, e.g. `A1`. */
  category: z.string().optional(),

  lat: finite,
  lon: finite,
  /** When the position was valid, epoch milliseconds on the server clock. Never decreases for an aircraft. */
  posTime: finite,
  /** When any message was last received from the aircraft, epoch milliseconds. */
  seenTime: finite,

  /** Pressure altitude in feet. Absent on the ground or when not reported. */
  altBaroFt: finite.optional(),
  /** Geometric altitude in feet above the WGS84 ellipsoid. */
  altGeomFt: finite.optional(),
  /** Best estimate of altitude above mean sea level, feet. */
  altMslFt: finite.optional(),
  /** Best estimate of height above the WGS84 ellipsoid, metres. Absent on the ground. */
  heightM: finite.optional(),
  /** Height above field elevation, feet. */
  aglFt: finite.optional(),
  altSource: AltitudeSourceSchema,
  onGround: z.boolean(),

  gsKt: finite.optional(),
  trackDeg: finite.optional(),
  /** Direction the nose points, for drawing: true heading when sent, else track, frozen below 2 kt. */
  headingDeg: finite.optional(),
  vertRateFpm: finite.optional(),
  squawk: z.string().optional(),
  /** ADS-B emergency status when it is not `none`. */
  emergency: z.string().optional(),

  phase: PhaseSchema,
  /** Id of the provider the current position came from. */
  source: z.string(),
  rssi: finite.optional(),
  nic: finite.optional(),
  nacP: finite.optional(),
});
export type Aircraft = z.infer<typeof AircraftSchema>;

/** A point of an aircraft's recent path: time (epoch ms), latitude, longitude, ellipsoid height in metres or null on the ground. */
export const TrailPointSchema = z.tuple([finite, finite, finite, finite.nullable()]);
export type TrailPoint = z.infer<typeof TrailPointSchema>;

/** Human-readable name for readsb's `type` field. */
export function describeAddrType(addrType: string): string {
  switch (addrType) {
    case 'adsb_icao':
      return 'ADS-B';
    case 'adsb_icao_nt':
      return 'ADS-B (non-transponder)';
    case 'adsr_icao':
    case 'adsr_other':
      return 'ADS-R (rebroadcast, e.g. UAT)';
    case 'tisb_icao':
    case 'tisb_trackfile':
    case 'tisb_other':
      return 'TIS-B';
    case 'mlat':
      return 'MLAT';
    case 'mode_s':
      return 'Mode S';
    case 'adsc':
      return 'ADS-C';
    case 'adsb_other':
      return 'ADS-B (non-ICAO address)';
    default:
      return addrType || 'Unknown';
  }
}

/** Text to show for an aircraft when space is tight: callsign, else registration, else the hex address. */
export function aircraftLabel(a: Pick<Aircraft, 'callsign' | 'registration' | 'hex'>): string {
  return a.callsign ?? a.registration ?? a.hex.toUpperCase();
}
