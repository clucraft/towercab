import { type AirportInfo, bearingDeg, destinationPoint, distanceM, normalizeDeg } from '@towercab/shared';

/**
 * View presets, worked out from the airport data. Plain numbers only: the scene controller turns them into
 * camera moves.
 */

export type ViewKind = 'pose' | 'overhead' | 'orbit' | 'follow';

export interface ViewPreset {
  /** `tower`, `overhead`, `orbit`, `follow` or `rwy-<designator>`. Used in the URL. */
  id: string;
  label: string;
  kind: ViewKind;
  available: boolean;
  /** Why it is not available, or a caveat such as "approximate position". */
  note?: string;
  /** For `pose`: where the camera stands and where it looks. Height is above field elevation. */
  pose?: { lat: number; lon: number; heightAglM: number; headingDeg: number; pitchDeg: number };
  /** For `overhead` and `orbit`: what to look at, and from how far. */
  target?: { lat: number; lon: number; rangeM: number; headingDeg: number; pitchDeg: number };
}

/** Eye height used when a tower's height is not known. Marked approximate in the UI. */
export const DEFAULT_TOWER_EYE_HEIGHT_M = 25;
const RUNWAY_VIEW_BACK_M = 480;
const RUNWAY_VIEW_HEIGHT_M = 60;

/** The middle of the runway system, and the distance from it to the farthest runway end. */
export function airportFootprint(airport: Pick<AirportInfo, 'lat' | 'lon' | 'runways'>): {
  lat: number;
  lon: number;
  radiusM: number;
} {
  const ends = airport.runways.filter((r) => !r.closed).flatMap((r) => r.ends);
  if (ends.length === 0) return { lat: airport.lat, lon: airport.lon, radiusM: 1500 };
  const lat = ends.reduce((sum, e) => sum + e.lat, 0) / ends.length;
  const lon = ends.reduce((sum, e) => sum + e.lon, 0) / ends.length;
  const radiusM = Math.max(...ends.map((e) => distanceM(lat, lon, e.lat, e.lon)));
  return { lat, lon, radiusM: Math.max(600, radiusM) };
}

export function buildViewPresets(airport: AirportInfo): ViewPreset[] {
  const centre = airportFootprint(airport);
  const presets: ViewPreset[] = [];

  const tower = airport.tower;
  if (tower) {
    presets.push({
      id: 'tower',
      label: 'Tower cab',
      kind: 'pose',
      available: true,
      note: tower.approximate ? 'Tower position is approximate' : undefined,
      pose: {
        lat: tower.lat,
        lon: tower.lon,
        heightAglM: tower.heightM ?? DEFAULT_TOWER_EYE_HEIGHT_M,
        headingDeg: bearingDeg(tower.lat, tower.lon, centre.lat, centre.lon),
        pitchDeg: -4,
      },
    });
  } else {
    presets.push({
      id: 'tower',
      label: 'Tower cab',
      kind: 'pose',
      available: false,
      note: 'No tower position is known for this airport. Set `tower` in config.yaml.',
    });
  }

  presets.push({
    id: 'overhead',
    label: 'Overhead',
    kind: 'overhead',
    available: true,
    // Far enough back that the whole runway system fits with room to spare.
    target: { lat: centre.lat, lon: centre.lon, rangeM: centre.radiusM * 2.6, headingDeg: 0, pitchDeg: -90 },
  });

  for (const runway of airport.runways) {
    if (runway.closed) continue;
    for (const end of runway.ends) {
      // Stand on the extended centreline short of the threshold, looking down the runway.
      const behind = destinationPoint(
        end.lat,
        end.lon,
        normalizeDeg(end.headingTrue + 180),
        RUNWAY_VIEW_BACK_M,
      );
      presets.push({
        id: `rwy-${end.ident}`,
        label: `Runway ${end.ident}`,
        kind: 'pose',
        available: true,
        pose: {
          lat: behind.lat,
          lon: behind.lon,
          heightAglM: RUNWAY_VIEW_HEIGHT_M,
          headingDeg: end.headingTrue,
          pitchDeg: -8,
        },
      });
    }
  }

  presets.push({
    id: 'orbit',
    label: 'Free orbit',
    kind: 'orbit',
    available: true,
    target: { lat: centre.lat, lon: centre.lon, rangeM: centre.radiusM * 1.9, headingDeg: 25, pitchDeg: -28 },
  });

  presets.push({
    id: 'follow',
    label: 'Follow',
    kind: 'follow',
    available: true,
    note: 'Select an aircraft first',
  });
  return presets;
}

/** The preset for an id from the URL or config, falling back to overhead when it is unknown or unavailable. */
export function resolveView(presets: readonly ViewPreset[], id: string | null | undefined): ViewPreset {
  const wanted = id ? presets.find((p) => p.id.toLowerCase() === id.toLowerCase()) : undefined;
  if (wanted?.available && wanted.kind !== 'follow') return wanted;
  return presets.find((p) => p.id === 'overhead') as ViewPreset;
}

/**
 * Keys 1 to 5: tower, overhead, runway ends (each press moves to the next end), orbit, follow.
 * Returns the id of the preset to switch to.
 */
export function viewForShortcut(
  presets: readonly ViewPreset[],
  key: string,
  currentId: string,
): string | null {
  switch (key) {
    case '1':
      return 'tower';
    case '2':
      return 'overhead';
    case '3': {
      const ends = presets.filter((p) => p.id.startsWith('rwy-'));
      if (ends.length === 0) return null;
      const index = ends.findIndex((p) => p.id === currentId);
      return (ends[(index + 1) % ends.length] as ViewPreset).id;
    }
    case '4':
      return 'orbit';
    case '5':
      return 'follow';
    default:
      return null;
  }
}
