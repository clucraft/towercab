import { EventEmitter } from 'node:events';
import {
  type AirportDetail,
  type AirportEntry,
  type AirportInfo,
  type AirportSummary,
  type AirportTower,
  fieldElevationEllipsoidM,
  type LayoutCollection,
  type Runway,
} from '@towercab/shared';
import { geoidUndulationM } from './geoid';
import type { AirportRecord } from './ourairports';
import { findTower } from './overpass';

/** Eye level in a tower cab sits a little below the top of the structure OSM gives the height of. */
const CAB_BELOW_TOP_M = 3;

export function defaultLinks(icao: string): Required<NonNullable<AirportEntry['links']>> {
  return {
    liveatc: `https://www.liveatc.net/search/?icao=${icao}`,
    // The FAA has no stable per-airport diagram URL (the path changes every 28-day cycle), so this is the
    // search page. Put a direct link in config to override it.
    diagram: 'https://www.faa.gov/airports/runway_safety/diagrams/',
    flightaware: `https://www.flightaware.com/live/airport/${icao}`,
  };
}

/**
 * Merges what the config says about an airport with what OurAirports and OSM know. Config always wins.
 * Returns null when there is no position for the airport from either source.
 */
export function buildAirportInfo(
  entry: AirportEntry,
  record: AirportRecord | undefined,
  runways: Runway[],
  layout: LayoutCollection | null,
  geoid: (lat: number, lon: number) => number = geoidUndulationM,
): AirportInfo | null {
  const lat = entry.lat ?? record?.lat;
  const lon = entry.lon ?? record?.lon;
  const elevationFt = entry.elevationFt ?? record?.elevationFt ?? null;
  if (lat === undefined || lon === undefined || elevationFt === null) return null;

  const undulation = geoid(lat, lon);
  let tower: AirportTower | null = null;
  if (entry.tower) {
    tower = { ...entry.tower, source: 'config' };
  } else if (layout) {
    const mapped = findTower(layout);
    if (mapped) {
      tower = { lat: mapped.lat, lon: mapped.lon, approximate: true, source: 'osm' };
      if (mapped.heightM != null) tower.heightM = Math.max(5, mapped.heightM - CAB_BELOW_TOP_M);
    }
  }

  return {
    icao: entry.icao,
    name: entry.name ?? record?.name ?? entry.icao,
    city: entry.city ?? record?.municipality ?? null,
    lat,
    lon,
    elevationFt,
    defaultView: entry.defaultView,
    available: true,
    geoidUndulationM: Math.round(undulation * 100) / 100,
    elevationEllipsoidM: Math.round(fieldElevationEllipsoidM(elevationFt, undulation) * 100) / 100,
    radiusNm: entry.radiusNm,
    ceilingFtAgl: entry.ceilingFtAgl,
    tower,
    runways,
    links: { ...defaultLinks(entry.icao), ...entry.links },
    sources: {
      airport: record ? 'ourairports' : 'config',
      layout: layout && layout.features.length > 0 ? 'osm' : null,
      layoutFetchedAt: layout && layout.features.length > 0 ? layout.fetchedAt : null,
    },
  };
}

export interface AirportLookup {
  lookup(icaos: string[]): Promise<{ airports: Map<string, AirportRecord>; runways: Map<string, Runway[]> }>;
}

export interface LayoutSource {
  get(icao: string): Promise<LayoutCollection | null>;
  onUpdate(listener: (icao: string, layout: LayoutCollection) => void): void;
}

export interface AirportServiceEvents {
  /** The set of airports, or what is known about one of them, changed. */
  change: [];
}

/** The server's view of the configured airports. */
export class AirportService extends EventEmitter<AirportServiceEvents> {
  private entries: AirportEntry[] = [];
  private infos = new Map<string, AirportInfo>();
  private records = new Map<string, AirportRecord>();
  private runways = new Map<string, Runway[]>();
  private loading: Promise<void> = Promise.resolve();

  constructor(
    private readonly reference: AirportLookup,
    private readonly layouts: LayoutSource,
    private readonly log?: { warn(obj: object, msg: string): void },
  ) {
    super();
    // A layout that arrives later can carry the tower position.
    this.layouts.onUpdate((icao) => {
      void this.rebuild(icao).then(() => this.emit('change'));
    });
  }

  /** Loads (or reloads) reference data for the configured airports. Safe to call again after a config change. */
  load(entries: AirportEntry[]): Promise<void> {
    this.loading = this.loading.then(async () => {
      this.entries = entries;
      const found = await this.reference.lookup(entries.map((e) => e.icao));
      this.records = found.airports;
      this.runways = found.runways;
      const next = new Map<string, AirportInfo>();
      for (const entry of entries) {
        const info = buildAirportInfo(
          entry,
          this.records.get(entry.icao),
          this.runways.get(entry.icao) ?? [],
          await this.layouts.get(entry.icao),
        );
        if (info) next.set(entry.icao, info);
        else {
          this.log?.warn(
            { icao: entry.icao },
            'no reference data for this airport: set lat, lon and elevationFt in config, or check the OurAirports download',
          );
        }
      }
      this.infos = next;
      this.emit('change');
    });
    return this.loading;
  }

  list(): AirportSummary[] {
    return this.entries.map((entry) => {
      const info = this.infos.get(entry.icao);
      if (info) {
        const { icao, name, city, lat, lon, elevationFt, defaultView, available } = info;
        return { icao, name, city, lat, lon, elevationFt, defaultView, available };
      }
      return {
        icao: entry.icao,
        name: entry.name ?? entry.icao,
        city: entry.city ?? null,
        lat: entry.lat ?? 0,
        lon: entry.lon ?? 0,
        elevationFt: entry.elevationFt ?? 0,
        defaultView: entry.defaultView,
        available: false,
      };
    });
  }

  get(icao: string): AirportInfo | undefined {
    return this.infos.get(icao);
  }

  isConfigured(icao: string): boolean {
    return this.entries.some((e) => e.icao === icao);
  }

  async detail(icao: string): Promise<AirportDetail | undefined> {
    const info = this.infos.get(icao);
    if (!info) return undefined;
    const found = await this.layouts.get(icao);
    const layout = found && found.features.length > 0 ? found : null;
    return {
      ...info,
      // The layout can arrive after the airport was built; describe what is being returned now.
      sources: { ...info.sources, layout: layout ? 'osm' : null, layoutFetchedAt: layout?.fetchedAt ?? null },
      layout,
    };
  }

  private async rebuild(icao: string): Promise<void> {
    const entry = this.entries.find((e) => e.icao === icao);
    if (!entry) return;
    const info = buildAirportInfo(
      entry,
      this.records.get(icao),
      this.runways.get(icao) ?? [],
      await this.layouts.get(icao),
    );
    if (info) this.infos.set(icao, info);
  }
}
