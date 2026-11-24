import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type CameraKind,
  type CameraPose,
  CameraPoseSchema,
  type CameraProvider,
  type CameraStatus,
  type DiscoveryRun,
} from '@towercab/shared';
import Database from 'better-sqlite3';

/** A camera found by discovery, as it is kept in the queue. */
export interface DiscoveredCamera {
  id: string;
  airport: string;
  provider: CameraProvider;
  /** The provider's own id: a YouTube video id or a Windy webcam id. */
  externalId: string;
  name: string;
  kind: CameraKind;
  source: string;
  attribution?: string;
  link?: string;
  thumbnail?: string;
  detail?: { channel?: string; description?: string; distanceKm?: number; foundBy?: string };
  status: CameraStatus;
  enabled: boolean;
  foundAt: number;
  lastSeenAt: number;
}

/** What discovery hands over for each result. Status and times are the store's business. */
export type DiscoveryResult = Omit<DiscoveredCamera, 'status' | 'enabled' | 'foundAt' | 'lastSeenAt'>;

interface CameraRow {
  id: string;
  airport: string;
  provider: string;
  external_id: string;
  name: string;
  kind: string;
  source: string;
  attribution: string | null;
  link: string | null;
  thumbnail: string | null;
  detail: string | null;
  status: string;
  enabled: number;
  found_at: number;
  last_seen_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS discovered_cameras (
  id TEXT PRIMARY KEY,
  airport TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  attribution TEXT,
  link TEXT,
  thumbnail TEXT,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  enabled INTEGER NOT NULL DEFAULT 1,
  found_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS discovered_cameras_airport ON discovered_cameras (airport, status);
CREATE TABLE IF NOT EXISTS camera_poses (
  camera_id TEXT PRIMARY KEY,
  pose TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS discovery_runs (
  airport TEXT NOT NULL,
  provider TEXT NOT NULL,
  ran_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  found INTEGER NOT NULL,
  message TEXT,
  PRIMARY KEY (airport, provider)
);
`;

function fromRow(row: CameraRow): DiscoveredCamera {
  return {
    id: row.id,
    airport: row.airport,
    provider: row.provider as CameraProvider,
    externalId: row.external_id,
    name: row.name,
    kind: row.kind as CameraKind,
    source: row.source,
    attribution: row.attribution ?? undefined,
    link: row.link ?? undefined,
    thumbnail: row.thumbnail ?? undefined,
    detail: row.detail ? (JSON.parse(row.detail) as DiscoveredCamera['detail']) : undefined,
    status: row.status as CameraStatus,
    enabled: row.enabled === 1,
    foundAt: row.found_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * The camera queue: what discovery found and what the admin decided about it, the poses set in the admin
 * page, and when each search last ran. A small SQLite file in the data folder; nothing else is stored in it.
 */
export class CameraStore {
  private readonly db: Database.Database;

  /** `file` is a path, or `:memory:` for tests. */
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Stores what a discovery run returned. New cameras enter as `pending`. Known ones keep the admin's
   * decision and name; only what the provider reports about them is refreshed.
   */
  recordResults(results: readonly DiscoveryResult[], now: number): { added: number; seenAgain: number } {
    const insert = this.db.prepare(
      `INSERT INTO discovered_cameras
         (id, airport, provider, external_id, name, kind, source, attribution, link, thumbnail, detail, found_at, last_seen_at)
       VALUES (@id, @airport, @provider, @externalId, @name, @kind, @source, @attribution, @link, @thumbnail, @detail, @now, @now)
       ON CONFLICT (id) DO UPDATE SET
         link = excluded.link, thumbnail = excluded.thumbnail, detail = excluded.detail, last_seen_at = excluded.last_seen_at`,
    );
    const exists = this.db.prepare('SELECT 1 FROM discovered_cameras WHERE id = ?');
    let added = 0;
    let seenAgain = 0;
    this.db.transaction(() => {
      for (const r of results) {
        if (exists.get(r.id)) seenAgain += 1;
        else added += 1;
        insert.run({
          id: r.id,
          airport: r.airport,
          provider: r.provider,
          externalId: r.externalId,
          name: r.name,
          kind: r.kind,
          source: r.source,
          attribution: r.attribution ?? null,
          link: r.link ?? null,
          thumbnail: r.thumbnail ?? null,
          detail: r.detail ? JSON.stringify(r.detail) : null,
          now,
        });
      }
    })();
    return { added, seenAgain };
  }

  list(filter: { airport?: string; status?: CameraStatus } = {}): DiscoveredCamera[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.airport) {
      where.push('airport = ?');
      params.push(filter.airport);
    }
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    const sql = `SELECT * FROM discovered_cameras ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY found_at DESC, id`;
    return (this.db.prepare(sql).all(...params) as CameraRow[]).map(fromRow);
  }

  get(id: string): DiscoveredCamera | null {
    const row = this.db.prepare('SELECT * FROM discovered_cameras WHERE id = ?').get(id) as
      | CameraRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  /** Applies an admin decision. Returns false when there is no such camera. */
  update(id: string, change: { status?: CameraStatus; enabled?: boolean; name?: string }): boolean {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (change.status !== undefined) {
      sets.push('status = ?');
      params.push(change.status);
    }
    if (change.enabled !== undefined) {
      sets.push('enabled = ?');
      params.push(change.enabled ? 1 : 0);
    }
    if (change.name !== undefined) {
      sets.push('name = ?');
      params.push(change.name);
    }
    if (sets.length === 0) return this.get(id) !== null;
    const result = this.db
      .prepare(`UPDATE discovered_cameras SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
    return result.changes > 0;
  }

  /** Poses set in the admin page, by camera id. They apply to config cameras and discovered ones alike. */
  poses(): Map<string, CameraPose> {
    const out = new Map<string, CameraPose>();
    const rows = this.db.prepare('SELECT camera_id, pose FROM camera_poses').all() as {
      camera_id: string;
      pose: string;
    }[];
    for (const row of rows) {
      // A pose written by an older version that no longer validates is ignored rather than trusted.
      const parsed = CameraPoseSchema.safeParse(JSON.parse(row.pose));
      if (parsed.success) out.set(row.camera_id, parsed.data);
    }
    return out;
  }

  setPose(cameraId: string, pose: CameraPose | null, now: number): void {
    if (pose === null) {
      this.db.prepare('DELETE FROM camera_poses WHERE camera_id = ?').run(cameraId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO camera_poses (camera_id, pose, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (camera_id) DO UPDATE SET pose = excluded.pose, updated_at = excluded.updated_at`,
      )
      .run(cameraId, JSON.stringify(pose), now);
  }

  recordRun(run: DiscoveryRun): void {
    this.db
      .prepare(
        `INSERT INTO discovery_runs (airport, provider, ran_at, ok, found, message)
         VALUES (@airport, @provider, @ranAt, @ok, @found, @message)
         ON CONFLICT (airport, provider) DO UPDATE SET
           ran_at = excluded.ran_at, ok = excluded.ok, found = excluded.found, message = excluded.message`,
      )
      .run({ ...run, ok: run.ok ? 1 : 0, message: run.message ?? null });
  }

  runs(): DiscoveryRun[] {
    const rows = this.db.prepare('SELECT * FROM discovery_runs ORDER BY airport, provider').all() as {
      airport: string;
      provider: string;
      ran_at: number;
      ok: number;
      found: number;
      message: string | null;
    }[];
    return rows.map((r) => ({
      airport: r.airport,
      provider: r.provider as CameraProvider,
      ranAt: r.ran_at,
      ok: r.ok === 1,
      found: r.found,
      message: r.message ?? undefined,
    }));
  }

  lastRun(airport: string, provider: CameraProvider): DiscoveryRun | null {
    return this.runs().find((r) => r.airport === airport && r.provider === provider) ?? null;
  }
}
