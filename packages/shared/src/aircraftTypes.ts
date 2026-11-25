import table from '../data/aircraft-types.json' with { type: 'json' };

/** One 3D model exists per class. The model is scaled to the real wingspan (rotor diameter for helicopters). */
export const MODEL_CLASSES = [
  'ga-single-high',
  'ga-single-low',
  'ga-twin',
  'turboprop-single',
  'turboprop-twin',
  'bizjet',
  'regional-jet',
  'narrowbody',
  'widebody-twin',
  'widebody-tri',
  'widebody-quad',
  'helicopter',
  'ground-vehicle',
  'generic',
] as const;
export type ModelClass = (typeof MODEL_CLASSES)[number];

export interface AircraftTypeInfo {
  class: ModelClass;
  /** Wingspan in metres; rotor diameter for helicopters. */
  wingspanM: number;
  lengthM: number;
}

export interface ResolvedAircraftType extends AircraftTypeInfo {
  /** How the dimensions were found: exact ICAO type, ADS-B emitter category, or the generic fallback. */
  matched: 'type' | 'category' | 'generic';
}

const TYPE_TABLE = table as Record<string, AircraftTypeInfo>;

/**
 * Typical dimensions per ADS-B emitter category (DO-260B 2.2.3.2.5.2), used when the type code is unknown.
 * A1 light (< 15,500 lb), A2 small, A3 large, A4 high-vortex large (B757), A5 heavy, A6 high performance,
 * A7 rotorcraft. B = gliders, balloons, UAVs and the like. C1/C2 = surface vehicles.
 */
const CATEGORY_TABLE: Record<string, AircraftTypeInfo> = {
  A1: { class: 'ga-single-low', wingspanM: 11, lengthM: 8 },
  A2: { class: 'bizjet', wingspanM: 16, lengthM: 16 },
  A3: { class: 'narrowbody', wingspanM: 35.8, lengthM: 38 },
  A4: { class: 'narrowbody', wingspanM: 38.05, lengthM: 47.3 },
  A5: { class: 'widebody-twin', wingspanM: 60, lengthM: 63 },
  A6: { class: 'generic', wingspanM: 11, lengthM: 15 },
  A7: { class: 'helicopter', wingspanM: 11, lengthM: 13 },
  B1: { class: 'generic', wingspanM: 15, lengthM: 7 },
  B4: { class: 'generic', wingspanM: 9, lengthM: 6 },
  B6: { class: 'generic', wingspanM: 3, lengthM: 2 },
  C1: { class: 'ground-vehicle', wingspanM: 2.5, lengthM: 6 },
  C2: { class: 'ground-vehicle', wingspanM: 2.5, lengthM: 6 },
};

const GENERIC: AircraftTypeInfo = { class: 'generic', wingspanM: 11, lengthM: 8.5 };

/** Number of ICAO type codes with real dimensions. */
export const KNOWN_TYPE_COUNT = Object.keys(TYPE_TABLE).length;

/**
 * Model class and real dimensions for an aircraft: by ICAO type code, then by emitter category,
 * then a generic light aircraft.
 */
export function resolveAircraftType(
  typeCode: string | null | undefined,
  category: string | null | undefined,
): ResolvedAircraftType {
  const byType = typeCode ? TYPE_TABLE[typeCode.trim().toUpperCase()] : undefined;
  if (byType) return { ...byType, matched: 'type' };
  const byCategory = category ? CATEGORY_TABLE[category.trim().toUpperCase()] : undefined;
  if (byCategory) return { ...byCategory, matched: 'category' };
  return { ...GENERIC, matched: 'generic' };
}

/** Whether this is an airport vehicle (ADS-B emitter categories C1 and C2) and not an aircraft. */
export function isGroundVehicle(of: { typeCode?: string; category?: string }): boolean {
  return resolveAircraftType(of.typeCode, of.category).class === 'ground-vehicle';
}
