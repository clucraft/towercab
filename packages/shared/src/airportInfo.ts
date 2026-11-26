import type { AirportLinks, Tower } from './airport';
import type { PublicAudioStation } from './audio';
import { angleDiffDeg } from './geo';

export interface RunwayEnd {
  /** Designator, e.g. `05L`. */
  ident: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  /** Direction of travel when using this end, degrees true. */
  headingTrue: number;
  displacedThresholdFt: number;
}

export interface Runway {
  /** Both designators joined, e.g. `05L/23R`. */
  id: string;
  lengthFt: number;
  widthFt: number;
  surface: string;
  lighted: boolean;
  closed: boolean;
  ends: [RunwayEnd, RunwayEnd];
}

export interface AirportTower extends Tower {
  /** Where the position came from. */
  source: 'config' | 'osm';
}

/** One row of `/api/airports`. */
export interface AirportSummary {
  icao: string;
  name: string;
  city: string | null;
  lat: number;
  lon: number;
  elevationFt: number;
  defaultView: string;
  /** False when reference data could not be loaded and the airport cannot be shown yet. */
  available: boolean;
}

/** Everything the browser needs to draw an airport, from `/api/airports/:icao`. */
export interface AirportInfo extends AirportSummary {
  /** EGM96 geoid undulation at the reference point, metres. Ellipsoid height = MSL height + this. */
  geoidUndulationM: number;
  /** Field elevation as a height above the WGS84 ellipsoid, metres. */
  elevationEllipsoidM: number;
  /** IANA time zone, for the local times that are shown. */
  timezone: string;
  radiusNm: number;
  ceilingFtAgl: number;
  tower: AirportTower | null;
  runways: Runway[];
  /** There is no diagram where none is known. */
  links: Required<Omit<AirportLinks, 'diagram'>> & Pick<AirportLinks, 'diagram'>;
  /** Stations for the radio. Empty when none are configured. */
  audio: PublicAudioStation[];
  /** Where the reference data came from, for the attribution footer. */
  sources: {
    airport: 'ourairports' | 'config';
    layout: 'osm' | null;
    /** Epoch ms the OSM layout was fetched, when there is one. */
    layoutFetchedAt: number | null;
  };
}

/** GeoJSON, kept loose on purpose: the layout is passed through to the renderer. */
export interface LayoutFeature {
  type: 'Feature';
  id?: string | number;
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Polygon'; coordinates: [number, number][][] }
    | { type: 'MultiPolygon'; coordinates: [number, number][][][] };
  properties: Record<string, string | number | boolean | null>;
}

export interface LayoutCollection {
  type: 'FeatureCollection';
  features: LayoutFeature[];
  /** Licence line that has to be shown wherever the layout is drawn. */
  attribution: string;
  fetchedAt: number;
}

export interface AirportDetail extends AirportInfo {
  layout: LayoutCollection | null;
}

/** Tokens and switches the browser is allowed to see. One image serves every deployment. */
export interface ClientConfig {
  version: string;
  /** Sent to the browser by design; restrict it to your hostname in the Cesium ion dashboard. */
  cesiumIonToken: string | null;
  /** Sent to the browser by design; restrict it by HTTP referrer in the Google Cloud console. */
  googleMapsApiKey: string | null;
  features: {
    photoreal: boolean;
    terrain: boolean;
    cameras: boolean;
    admin: boolean;
    photos: boolean;
    /** Pictures of the aircraft type, when there is none of the aircraft. */
    typePhotos: boolean;
  };
  /** How far behind real time the scene renders, milliseconds. */
  renderDelayMs: number;
  /** Credits for the data sources that are switched on. */
  attributions: { name: string; url: string; note?: string }[];
}

export interface WindComponents {
  ident: string;
  headingTrue: number;
  /** Positive is a headwind. */
  headwindKt: number;
  /** Absolute crosswind component. */
  crosswindKt: number;
}

/**
 * Runway ends ranked by headwind, best first. With calm or variable wind there is nothing to rank by,
 * so the result is empty and the UI says so.
 *
 * `windDirDeg` is degrees true, the direction the wind blows from. METAR winds are true; runway headings
 * here are true as well.
 */
export function rankRunwaysByWind(
  runways: Runway[],
  windDirDeg: number | null | undefined,
  windSpeedKt: number | null | undefined,
): WindComponents[] {
  if (windDirDeg == null || windSpeedKt == null || windSpeedKt < 3) return [];
  const out: WindComponents[] = [];
  for (const runway of runways) {
    if (runway.closed) continue;
    for (const end of runway.ends) {
      const off = (angleDiffDeg(end.headingTrue, windDirDeg) * Math.PI) / 180;
      out.push({
        ident: end.ident,
        headingTrue: end.headingTrue,
        headwindKt: windSpeedKt * Math.cos(off),
        crosswindKt: Math.abs(windSpeedKt * Math.sin(off)),
      });
    }
  }
  return out.sort((a, b) => b.headwindKt - a.headwindKt);
}
