import { FT_PER_M, M_PER_FT } from './geo';

/**
 * The height pipeline. Wrong altitudes are the main reason aircraft float above or sink into the ground,
 * so every step is a small pure function with tests.
 *
 * Three vertical references are in play:
 * - pressure altitude: what `alt_baro` is, referenced to 1013.25 hPa;
 * - height above mean sea level (MSL / the geoid): field elevations and runway elevations;
 * - height above the WGS84 ellipsoid (HAE): what `alt_geom` is (readsb README-json), and what Cesium,
 *   Cesium World Terrain and Google's 3D tiles all use.
 *
 * `HAE = MSL + N`, where N is the geoid undulation (EGM96). In central Indiana N is about -33 m.
 */

export const STANDARD_PRESSURE_HPA = 1013.25;

/**
 * Feet to add to a pressure altitude to get the altitude an altimeter set to `qnhHpa` would show.
 * ICAO standard atmosphere, valid in the troposphere. About +27 ft per hPa above standard near sea level.
 */
export function baroCorrectionFt(qnhHpa: number): number {
  return 145366.45 * ((qnhHpa / STANDARD_PRESSURE_HPA) ** 0.190284 - 1);
}

/** Pressure altitude to altitude above MSL, given the local altimeter setting. */
export function pressureAltToMslFt(altBaroFt: number, qnhHpa: number): number {
  return altBaroFt + baroCorrectionFt(qnhHpa);
}

/**
 * Temperature error of a barometric altitude. An altimeter assumes a standard atmosphere; in colder air the
 * aircraft is lower than indicated, in warmer air higher, by about 4 ft per 1,000 ft above the station per
 * degree of deviation from standard. Returns the feet to add to the indicated altitude.
 */
export function temperatureCorrectionFt(
  indicatedMslFt: number,
  stationElevationFt: number,
  stationTempC: number,
): number {
  const standardTempC = 15 - 0.0019812 * stationElevationFt;
  const heightAboveStationFt = indicatedMslFt - stationElevationFt;
  return heightAboveStationFt * (stationTempC - standardTempC) * 0.004;
}

/** Height above MSL to height above the WGS84 ellipsoid. */
export function mslToEllipsoidM(mslM: number, geoidUndulationM: number): number {
  return mslM + geoidUndulationM;
}

/** Height above the WGS84 ellipsoid to height above MSL. */
export function ellipsoidToMslM(ellipsoidM: number, geoidUndulationM: number): number {
  return ellipsoidM - geoidUndulationM;
}

/** Field (or runway) elevation in feet MSL as an ellipsoid height in metres. */
export function fieldElevationEllipsoidM(elevationFt: number, geoidUndulationM: number): number {
  return mslToEllipsoidM(elevationFt * M_PER_FT, geoidUndulationM);
}

export type AltitudeSource = 'geom' | 'baro-qnh' | 'baro-std' | 'none';

export interface AltitudeInput {
  /** `alt_geom`: feet above the WGS84 ellipsoid. */
  altGeomFt: number | null | undefined;
  /** `alt_baro` as a number. Pass null when the aircraft reports `"ground"`. */
  altBaroFt: number | null | undefined;
  /** Altimeter setting from the latest METAR, when there is one. */
  qnhHpa: number | null | undefined;
  /** EGM96 geoid undulation at the airport, metres. */
  geoidUndulationM: number;
  /**
   * Field elevation and METAR temperature. When both are given, QNH-corrected barometric altitude is also
   * corrected for temperature; without it, aircraft with no `alt_geom` sit tens of metres too high at a few
   * thousand feet on a cold day.
   */
  station?: { elevationFt: number; tempC: number | null | undefined };
}

export interface AltitudeEstimate {
  /** Height above the WGS84 ellipsoid, metres. Null when the aircraft reports no usable altitude. */
  ellipsoidM: number | null;
  /** Height above mean sea level, feet. */
  mslFt: number | null;
  source: AltitudeSource;
}

/**
 * Best estimate of an airborne aircraft's height.
 * 1. `alt_geom` is already an ellipsoid height: use it directly.
 * 2. Otherwise correct `alt_baro` with the METAR altimeter setting (and temperature, when known), then add
 *    the geoid undulation.
 * 3. With no METAR, fall back to uncorrected pressure altitude (flagged `baro-std`).
 */
export function estimateAltitude(input: AltitudeInput): AltitudeEstimate {
  const { altGeomFt, altBaroFt, qnhHpa, geoidUndulationM, station } = input;
  if (isFiniteNumber(altGeomFt)) {
    const ellipsoidM = altGeomFt * M_PER_FT;
    return {
      ellipsoidM,
      mslFt: ellipsoidToMslM(ellipsoidM, geoidUndulationM) * FT_PER_M,
      source: 'geom',
    };
  }
  if (isFiniteNumber(altBaroFt)) {
    const corrected = isFiniteNumber(qnhHpa) && qnhHpa > 850 && qnhHpa < 1100;
    let mslFt = corrected ? pressureAltToMslFt(altBaroFt, qnhHpa) : altBaroFt;
    if (corrected && station && isFiniteNumber(station.tempC)) {
      mslFt += temperatureCorrectionFt(mslFt, station.elevationFt, station.tempC);
    }
    return {
      ellipsoidM: mslToEllipsoidM(mslFt * M_PER_FT, geoidUndulationM),
      mslFt,
      source: corrected ? 'baro-qnh' : 'baro-std',
    };
  }
  return { ellipsoidM: null, mslFt: null, source: 'none' };
}

/**
 * Height of an aircraft's reference point above the ground it is standing on, as an ellipsoid height.
 * `sampledGroundM` is the terrain/3D-tile height under the aircraft; when sampling is not possible the
 * field elevation converted through the geoid is used instead.
 */
export function groundHeightEllipsoidM(
  sampledGroundM: number | null | undefined,
  fieldElevationFt: number,
  geoidUndulationM: number,
): number {
  if (isFiniteNumber(sampledGroundM)) return sampledGroundM;
  return fieldElevationEllipsoidM(fieldElevationFt, geoidUndulationM);
}

function isFiniteNumber(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
