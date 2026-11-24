import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bearingDeg, normalizeDeg, type Runway, type RunwayEnd } from '@towercab/shared';
import type { FetchLike } from '../providers/http';

/**
 * OurAirports open data (public domain): https://ourairports.com/data/
 * `airports.csv` gives the reference point and field elevation, `runways.csv` both ends of every runway.
 */
export const OURAIRPORTS_BASE_URL = 'https://davidmegginson.github.io/ourairports-data';
const FILES = ['airports.csv', 'runways.csv'] as const;
type FileName = (typeof FILES)[number];
const WEEK_MS = 7 * 86_400_000;

export interface AirportRecord {
  ident: string;
  type: string;
  name: string;
  lat: number;
  lon: number;
  elevationFt: number | null;
  municipality: string | null;
}

/**
 * Minimal RFC 4180 reader: quoted fields may contain commas, doubled quotes and line breaks.
 * Calls `onRow` for every record; return false from it to stop early.
 */
export function parseCsv(text: string, onRow: (row: string[]) => boolean | undefined): void {
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c === 34 /* " */) {
        if (text.charCodeAt(i + 1) === 34) {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      // Copy the run up to the next quote in one go.
      const next = text.indexOf('"', i);
      const end = next === -1 ? n : next;
      field += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === 34) {
      quoted = true;
      i += 1;
    } else if (c === 44 /* , */) {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === 10 /* \n */ || c === 13 /* \r */) {
      if (c === 13 && text.charCodeAt(i + 1) === 10) i += 1;
      i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') {
        if (onRow(row) === false) return;
      }
      row = [];
    } else {
      let end = i + 1;
      while (end < n) {
        const d = text.charCodeAt(end);
        if (d === 44 || d === 10 || d === 13 || d === 34) break;
        end += 1;
      }
      field += text.slice(i, end);
      i = end;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    onRow(row);
  }
}

function columnIndex(header: string[], names: string[]): Record<string, number> {
  const index: Record<string, number> = {};
  for (const name of names) {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`OurAirports CSV has no "${name}" column`);
    index[name] = i;
  }
  return index;
}

const number = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Finds the requested airports. An airport matches on `ident`, `gps_code` or `icao_code`. */
export function findAirports(csv: string, icaos: Iterable<string>): Map<string, AirportRecord> {
  const wanted = new Set([...icaos].map((s) => s.toUpperCase()));
  const found = new Map<string, AirportRecord>();
  let col: Record<string, number> | null = null;
  parseCsv(csv, (row) => {
    if (!col) {
      col = columnIndex(row, [
        'ident',
        'type',
        'name',
        'latitude_deg',
        'longitude_deg',
        'elevation_ft',
        'municipality',
        'icao_code',
        'gps_code',
      ]);
      return true;
    }
    const cell = (name: string) => row[(col as Record<string, number>)[name] as number];
    const ident = (cell('ident') ?? '').toUpperCase();
    const keys = [ident, (cell('gps_code') ?? '').toUpperCase(), (cell('icao_code') ?? '').toUpperCase()];
    const match = keys.find((k) => k !== '' && wanted.has(k));
    if (!match) return true;
    const lat = number(cell('latitude_deg'));
    const lon = number(cell('longitude_deg'));
    if (lat == null || lon == null) return true;
    // A row whose own ident is the code beats one that merely lists it as a GPS code.
    if (found.has(match) && ident !== match) return true;
    found.set(match, {
      ident,
      type: cell('type') ?? '',
      name: cell('name') ?? match,
      lat,
      lon,
      elevationFt: number(cell('elevation_ft')),
      municipality: cell('municipality')?.trim() || null,
    });
    return true;
  });
  return found;
}

/** Runways for the given OurAirports idents. Runways without coordinates for both ends are left out. */
export function findRunways(csv: string, idents: Iterable<string>): Map<string, Runway[]> {
  const wanted = new Set([...idents].map((s) => s.toUpperCase()));
  const found = new Map<string, Runway[]>();
  let col: Record<string, number> | null = null;
  parseCsv(csv, (row) => {
    if (!col) {
      col = columnIndex(row, [
        'airport_ident',
        'length_ft',
        'width_ft',
        'surface',
        'lighted',
        'closed',
        'le_ident',
        'le_latitude_deg',
        'le_longitude_deg',
        'le_elevation_ft',
        'le_heading_degT',
        'le_displaced_threshold_ft',
        'he_ident',
        'he_latitude_deg',
        'he_longitude_deg',
        'he_elevation_ft',
        'he_heading_degT',
        'he_displaced_threshold_ft',
      ]);
      return true;
    }
    const cell = (name: string) => row[(col as Record<string, number>)[name] as number];
    const airport = (cell('airport_ident') ?? '').toUpperCase();
    if (!wanted.has(airport)) return true;

    const leLat = number(cell('le_latitude_deg'));
    const leLon = number(cell('le_longitude_deg'));
    const heLat = number(cell('he_latitude_deg'));
    const heLon = number(cell('he_longitude_deg'));
    if (leLat == null || leLon == null || heLat == null || heLon == null) return true;

    // Headings are sometimes missing; the geometry gives the same answer.
    const leHeading = number(cell('le_heading_degT')) ?? bearingDeg(leLat, leLon, heLat, heLon);
    const heHeading = number(cell('he_heading_degT')) ?? normalizeDeg(leHeading + 180);
    const le: RunwayEnd = {
      ident: cell('le_ident')?.trim() || '?',
      lat: leLat,
      lon: leLon,
      elevationFt: number(cell('le_elevation_ft')),
      headingTrue: normalizeDeg(leHeading),
      displacedThresholdFt: number(cell('le_displaced_threshold_ft')) ?? 0,
    };
    const he: RunwayEnd = {
      ident: cell('he_ident')?.trim() || '?',
      lat: heLat,
      lon: heLon,
      elevationFt: number(cell('he_elevation_ft')),
      headingTrue: normalizeDeg(heHeading),
      displacedThresholdFt: number(cell('he_displaced_threshold_ft')) ?? 0,
    };
    const runway: Runway = {
      id: `${le.ident}/${he.ident}`,
      lengthFt: number(cell('length_ft')) ?? 0,
      widthFt: number(cell('width_ft')) ?? 0,
      surface: cell('surface')?.trim() ?? '',
      lighted: cell('lighted') === '1',
      closed: cell('closed') === '1',
      ends: [le, he],
    };
    const list = found.get(airport);
    if (list) list.push(runway);
    else found.set(airport, [runway]);
    return true;
  });
  return found;
}

export interface OurAirportsOptions {
  dataDir: string;
  userAgent: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

interface Meta {
  fetchedAt: number;
  etags: Partial<Record<FileName, string>>;
}

/** Downloads the two CSV files on first start, keeps them in `/data/ourairports`, refreshes them weekly. */
export class OurAirportsStore {
  private readonly dir: string;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly options: OurAirportsOptions) {
    this.dir = join(options.dataDir, 'ourairports');
    this.baseUrl = (options.baseUrl ?? OURAIRPORTS_BASE_URL).replace(/\/+$/, '');
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  /** Looks the airports up, downloading the data first if there is no cached copy. */
  async lookup(
    icaos: string[],
  ): Promise<{ airports: Map<string, AirportRecord>; runways: Map<string, Runway[]> }> {
    if (!(await this.hasFiles())) await this.refresh();
    else if (await this.isStale()) void this.refresh();

    const empty = { airports: new Map<string, AirportRecord>(), runways: new Map<string, Runway[]>() };
    if (!(await this.hasFiles())) return empty;
    const airports = findAirports(await readFile(join(this.dir, 'airports.csv'), 'utf8'), icaos);
    const byIdent = new Map<string, string>();
    for (const [icao, record] of airports) byIdent.set(record.ident, icao);
    const runwaysByIdent = findRunways(await readFile(join(this.dir, 'runways.csv'), 'utf8'), byIdent.keys());
    const runways = new Map<string, Runway[]>();
    for (const [ident, list] of runwaysByIdent) runways.set(byIdent.get(ident) as string, list);
    return { airports, runways };
  }

  /** True when the cached copy is more than a week old. */
  async isStale(): Promise<boolean> {
    const meta = await this.readMeta();
    return !meta || this.now() - meta.fetchedAt > WEEK_MS;
  }

  /** Downloads both files. Resolves true when the cache changed. Failures are logged, never thrown. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.download().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async download(): Promise<boolean> {
    try {
      await mkdir(this.dir, { recursive: true });
      const meta = (await this.readMeta()) ?? { fetchedAt: 0, etags: {} };
      const haveFiles = await this.hasFiles();
      let changed = false;
      for (const file of FILES) {
        const headers: Record<string, string> = { 'User-Agent': this.options.userAgent };
        const etag = meta.etags[file];
        if (haveFiles && etag) headers['If-None-Match'] = etag;
        const res = await this.fetchImpl(`${this.baseUrl}/${file}`, {
          headers,
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status === 304) continue;
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        const text = await res.text();
        if (!text.startsWith('"id"')) throw new Error(`${file}: unexpected content`);
        // Write next to the target and rename, so a crash never leaves half a file behind.
        const target = join(this.dir, file);
        await writeFile(`${target}.tmp`, text);
        await rename(`${target}.tmp`, target);
        const newTag = res.headers.get('etag');
        if (newTag) meta.etags[file] = newTag;
        changed = true;
      }
      meta.fetchedAt = this.now();
      await writeFile(join(this.dir, 'meta.json'), JSON.stringify(meta));
      this.options.log?.info({ changed }, 'OurAirports data is up to date');
      return changed;
    } catch (err) {
      this.options.log?.warn({ err: (err as Error).message }, 'could not download OurAirports data');
      return false;
    }
  }

  private async hasFiles(): Promise<boolean> {
    for (const file of FILES) {
      try {
        await stat(join(this.dir, file));
      } catch {
        return false;
      }
    }
    return true;
  }

  private async readMeta(): Promise<Meta | null> {
    try {
      return JSON.parse(await readFile(join(this.dir, 'meta.json'), 'utf8')) as Meta;
    } catch {
      return null;
    }
  }
}
