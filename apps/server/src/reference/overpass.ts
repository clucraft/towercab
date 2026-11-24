import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LayoutCollection, LayoutFeature } from '@towercab/shared';
import type { FetchLike } from '../providers/http';

/**
 * Airport layout from OpenStreetMap through the Overpass API.
 * Checked live on 2026-11-24: the public instance answers 406 to generic User-Agents, and 502 with a
 * "server is at capacity, retry with exponential backoff" body when busy. So: an identifying User-Agent,
 * one query per airport, a weekly refresh, patient retries, and the cached copy is used whenever a fetch fails.
 */
export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0';
const WEEK_MS = 7 * 86_400_000;

/** `aeroway` values worth drawing. Anything else inside the aerodrome is ignored. */
const AEROWAY_KINDS = new Set([
  'aerodrome',
  'runway',
  'taxiway',
  'taxilane',
  'apron',
  'holding_position',
  'parking_position',
  'gate',
  'terminal',
  'hangar',
  'tower',
  'control_tower',
  'windsock',
  'helipad',
  'stopway',
]);
/** Kinds that are areas when drawn as a closed way. Runways and taxiways are centrelines unless `area=yes`. */
const AREA_KINDS = new Set([
  'aerodrome',
  'apron',
  'terminal',
  'hangar',
  'building',
  'helipad',
  'tower',
  'control_tower',
]);

/** Everything with an `aeroway` tag, plus buildings and towers, inside the aerodrome that carries this ICAO code. */
export function buildOverpassQuery(icao: string): string {
  const code = icao.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  return `[out:json][timeout:60];
(
  way["aeroway"="aerodrome"]["icao"="${code}"];
  relation["aeroway"="aerodrome"]["icao"="${code}"];
)->.field;
.field out tags geom;
.field map_to_area->.a;
(
  nwr["aeroway"](area.a);
  nwr["man_made"="tower"](area.a);
  way["building"](area.a);
  relation["building"](area.a);
);
out tags geom;`;
}

type LonLat = [number, number];
interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: ({ lat: number; lon: number } | null)[];
  members?: { type: string; role: string; geometry?: ({ lat: number; lon: number } | null)[] }[];
}

const samePoint = (a: LonLat, b: LonLat): boolean => a[0] === b[0] && a[1] === b[1];
const round = (v: number): number => Math.round(v * 1e7) / 1e7;

function toLine(geometry: OverpassElement['geometry']): LonLat[] {
  const out: LonLat[] = [];
  for (const p of geometry ?? []) if (p) out.push([round(p.lon), round(p.lat)]);
  return out;
}

/** Joins way fragments end to end into closed rings. Fragments that never close are dropped. */
export function assembleRings(parts: LonLat[][]): LonLat[][] {
  const rings: LonLat[][] = [];
  const open = parts.filter((p) => p.length >= 2).map((p) => [...p]);
  while (open.length > 0) {
    let ring = open.shift() as LonLat[];
    let extended = true;
    while (!samePoint(ring[0] as LonLat, ring[ring.length - 1] as LonLat) && extended) {
      extended = false;
      const tail = ring[ring.length - 1] as LonLat;
      for (let i = 0; i < open.length; i += 1) {
        const part = open[i] as LonLat[];
        if (samePoint(part[0] as LonLat, tail)) {
          ring = ring.concat(part.slice(1));
        } else if (samePoint(part[part.length - 1] as LonLat, tail)) {
          ring = ring.concat([...part].reverse().slice(1));
        } else {
          continue;
        }
        open.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4 && samePoint(ring[0] as LonLat, ring[ring.length - 1] as LonLat)) rings.push(ring);
  }
  return rings;
}

function pointInRing(point: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i] as LonLat;
    const b = ring[j] as LonLat;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function classify(tags: Record<string, string>): string | null {
  const aeroway = tags.aeroway;
  if (aeroway && AEROWAY_KINDS.has(aeroway)) return aeroway === 'control_tower' ? 'tower' : aeroway;
  if (tags.man_made === 'tower' && tags['tower:type'] === 'airport_control') return 'tower';
  if (tags.building === 'control_tower') return 'tower';
  if (tags.building && tags.building !== 'no') return 'building';
  return null;
}

function properties(el: OverpassElement, kind: string): LayoutFeature['properties'] {
  const tags = el.tags ?? {};
  const props: LayoutFeature['properties'] = { kind, osm: `${el.type}/${el.id}` };
  const copy = (key: string, as = key) => {
    const value = tags[key];
    if (value !== undefined && value !== '') props[as] = value;
  };
  copy('ref');
  copy('name');
  copy('surface');
  copy('icao');
  const metres = (key: string, as: string) => {
    const n = Number.parseFloat(tags[key] ?? '');
    if (Number.isFinite(n) && n > 0) props[as] = n;
  };
  metres('width', 'widthM');
  metres('height', 'heightM');
  metres('building:levels', 'levels');
  metres('ele', 'eleM');
  if (kind === 'building' && tags.building && tags.building !== 'yes') props.building = tags.building;
  return props;
}

/** Converts an Overpass `out tags geom` answer to GeoJSON, keeping only what the scene draws. */
export function overpassToLayout(json: unknown, fetchedAt: number): LayoutCollection {
  const elements = (json as { elements?: OverpassElement[] } | null)?.elements;
  if (!Array.isArray(elements)) throw new Error('Overpass answer has no "elements"');

  const features: LayoutFeature[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    const tags = el.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;
    seen.add(key);
    const props = properties(el, kind);

    if (el.type === 'node') {
      if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
      features.push({
        type: 'Feature',
        id: key,
        geometry: { type: 'Point', coordinates: [round(el.lon), round(el.lat)] },
        properties: props,
      });
    } else if (el.type === 'way') {
      const line = toLine(el.geometry);
      if (line.length < 2) continue;
      const closed = line.length >= 4 && samePoint(line[0] as LonLat, line[line.length - 1] as LonLat);
      const isArea = closed && (AREA_KINDS.has(kind) || tags.area === 'yes');
      features.push({
        type: 'Feature',
        id: key,
        geometry: isArea
          ? { type: 'Polygon', coordinates: [line] }
          : { type: 'LineString', coordinates: line },
        properties: props,
      });
    } else {
      const outers = assembleRings(
        (el.members ?? [])
          .filter((m) => m.type === 'way' && m.role !== 'inner')
          .map((m) => toLine(m.geometry)),
      );
      const inners = assembleRings(
        (el.members ?? [])
          .filter((m) => m.type === 'way' && m.role === 'inner')
          .map((m) => toLine(m.geometry)),
      );
      if (outers.length === 0) continue;
      const polygons = outers.map((outer) => [
        outer,
        ...inners.filter((inner) => pointInRing(inner[0] as LonLat, outer)),
      ]);
      features.push({
        type: 'Feature',
        id: key,
        geometry:
          polygons.length === 1
            ? { type: 'Polygon', coordinates: polygons[0] as LonLat[][] }
            : { type: 'MultiPolygon', coordinates: polygons },
        properties: props,
      });
    }
  }
  return { type: 'FeatureCollection', features, attribution: OSM_ATTRIBUTION, fetchedAt };
}

/** The control tower in a layout, when OSM has one: its centre and mapped height. */
export function findTower(
  layout: LayoutCollection,
): { lat: number; lon: number; heightM: number | null } | null {
  const tower = layout.features.find((f) => f.properties.kind === 'tower');
  if (!tower) return null;
  let points: LonLat[];
  switch (tower.geometry.type) {
    case 'Point':
      points = [tower.geometry.coordinates];
      break;
    case 'LineString':
      points = tower.geometry.coordinates;
      break;
    case 'Polygon':
      points = tower.geometry.coordinates[0] ?? [];
      break;
    default:
      points = tower.geometry.coordinates[0]?.[0] ?? [];
  }
  if (points.length === 0) return null;
  // Closed rings repeat their first point; leave the duplicate out of the average.
  const unique =
    points.length > 1 && samePoint(points[0] as LonLat, points[points.length - 1] as LonLat)
      ? points.slice(1)
      : points;
  const lon = unique.reduce((sum, p) => sum + p[0], 0) / unique.length;
  const lat = unique.reduce((sum, p) => sum + p[1], 0) / unique.length;
  const height = tower.properties.heightM;
  return { lat, lon, heightM: typeof height === 'number' ? height : null };
}

export interface LayoutStoreOptions {
  dataDir: string;
  userAgent: string;
  overpassUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Waits between attempts when the server is busy. */
  retryDelaysMs?: number[];
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** Keeps one GeoJSON layout per airport in `/data/osm/{icao}.geojson`, refreshed weekly. */
export class LayoutStore {
  private readonly dir: string;
  private readonly memory = new Map<string, LayoutCollection>();
  private readonly attemptedAt = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Requests run one at a time: the public Overpass instance allows very little concurrency. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(icao: string, layout: LayoutCollection) => void>();

  constructor(private readonly options: LayoutStoreOptions) {
    this.dir = join(options.dataDir, 'osm');
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Called when a layout is fetched or refreshed in the background. */
  onUpdate(listener: (icao: string, layout: LayoutCollection) => void): void {
    this.listeners.add(listener);
  }

  /**
   * The layout if it is cached (memory, then disk). A missing or week-old layout is fetched in the
   * background; callers get what exists now and are told through `onUpdate` when something newer arrives.
   */
  async get(icao: string): Promise<LayoutCollection | null> {
    let layout = this.memory.get(icao) ?? null;
    if (!layout) {
      layout = await this.readDisk(icao);
      if (layout) this.memory.set(icao, layout);
    }
    if (!layout || this.now() - layout.fetchedAt > WEEK_MS) this.refreshSoon(icao);
    return layout;
  }

  /** Fetches now, through the queue. Resolves with the new layout, or null when every attempt failed. */
  refresh(icao: string): Promise<LayoutCollection | null> {
    const run = this.queue.then(() => this.fetchWithRetry(icao));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private refreshSoon(icao: string): void {
    const last = this.attemptedAt.get(icao);
    // After a failed round, leave the server alone for an hour.
    if (last !== undefined && this.now() - last < 3_600_000) return;
    this.attemptedAt.set(icao, this.now());
    void this.refresh(icao);
  }

  private async fetchWithRetry(icao: string): Promise<LayoutCollection | null> {
    const delays = this.options.retryDelaysMs ?? [10_000, 30_000, 90_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const layout = await this.fetchOnce(icao);
        this.memory.set(icao, layout);
        await mkdir(this.dir, { recursive: true });
        const target = join(this.dir, `${icao}.geojson`);
        await writeFile(`${target}.tmp`, JSON.stringify(layout));
        await rename(`${target}.tmp`, target);
        this.options.log?.info(
          { icao, features: layout.features.length },
          'airport layout loaded from OpenStreetMap',
        );
        for (const listener of this.listeners) listener(icao, layout);
        return layout;
      } catch (err) {
        const delay = delays[attempt];
        this.options.log?.warn(
          { icao, err: (err as Error).message, retryInMs: delay ?? null },
          'could not load the airport layout from Overpass',
        );
        if (delay === undefined) return null;
        await this.sleep(delay);
      }
    }
  }

  private async fetchOnce(icao: string): Promise<LayoutCollection> {
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as FetchLike);
    const res = await fetchImpl(this.options.overpassUrl ?? OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.options.userAgent,
        Accept: 'application/json',
      },
      body: new URLSearchParams({ data: buildOverpassQuery(icao) }).toString(),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const layout = overpassToLayout(await res.json(), this.now());
    if (layout.features.length === 0) {
      // Not an error worth retrying: OSM simply has no aerodrome tagged with this code. The empty result is
      // cached like any other, so the question is not asked again until next week.
      this.options.log?.warn(
        { icao },
        `OpenStreetMap has no aerodrome tagged icao=${icao}; no layout to draw`,
      );
    }
    return layout;
  }

  private async readDisk(icao: string): Promise<LayoutCollection | null> {
    try {
      const layout = JSON.parse(
        await readFile(join(this.dir, `${icao}.geojson`), 'utf8'),
      ) as LayoutCollection;
      return layout.type === 'FeatureCollection' && Array.isArray(layout.features) ? layout : null;
    } catch {
      return null;
    }
  }
}
