import * as egm96 from 'egm96-universal';

/**
 * EGM96 geoid undulation N at a point, in metres: how far mean sea level sits above (+) or below (-) the
 * WGS84 ellipsoid there. Ellipsoid height = MSL height + N. Roughly -33 m in central Indiana.
 */
export function geoidUndulationM(lat: number, lon: number): number {
  return egm96.meanSeaLevel(lat, lon);
}
