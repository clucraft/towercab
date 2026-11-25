/**
 * Height of the surface under a point, in scene height (metres).
 *
 * Aircraft on the ground are placed on whatever is drawn there: Google's 3D tiles in Photoreal, Cesium World
 * Terrain in Schematic with an ion token, a flat plane otherwise. Sampling is asynchronous and far from
 * free, so results are kept on a grid, in memory, for this session only. Nothing sampled from the tiles is
 * ever written to disk or sent anywhere (Google's Map Tiles policy forbids storing derived data).
 */
export interface GroundSampler {
  /** The surface height at a point, or undefined while it is not known yet. Asking starts the lookup. */
  heightAt(lon: number, lat: number): number | undefined;
  /** The surface height if it is already known. Never starts a lookup. */
  peek(lon: number, lat: number): number | undefined;
  dispose(): void;
}

/** A flat scene: the ground is at height zero everywhere. */
export class FlatGround implements GroundSampler {
  heightAt(): number {
    return 0;
  }
  peek(): number {
    return 0;
  }
  dispose(): void {}
}

export interface SampledGroundOptions {
  /** Looks up many points at once. Resolves to one height per point, undefined where there is no surface. */
  sampleBatch: (points: { lon: number; lat: number }[]) => Promise<(number | undefined)[]>;
  /** Grid size in degrees of latitude. The default is about 10 m. */
  cellDeg?: number;
  /**
   * Take the median over the cell and its eight neighbours instead of the cell alone. Photogrammetry has
   * lumps where an aircraft or a vehicle stood when the pictures were taken; the median ignores them, and
   * unlike a minimum it does not drop an aircraft through a taxiway bridge either.
   */
  smooth?: boolean;
  /** Points per lookup, and the pause between lookups. Together they cap what sampling may cost. */
  maxBatch?: number;
  pauseMs?: number;
  /** Lookups waiting beyond this are dropped, oldest first: by then the aircraft has moved on. */
  maxPending?: number;
  maxCells?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A surface that has to be sampled (terrain or 3D tiles), with a session-only cache. */
export class SampledGround implements GroundSampler {
  private readonly cache = new Map<string, number>();
  private readonly pending = new Map<string, { lon: number; lat: number }>();
  private readonly failed = new Map<string, number>();
  private timer: unknown = null;
  private busy = false;
  private disposed = false;
  private readonly cellDeg: number;
  private readonly smooth: boolean;
  private readonly maxBatch: number;
  private readonly pauseMs: number;
  private readonly maxPending: number;
  private readonly maxCells: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: SampledGroundOptions) {
    this.cellDeg = options.cellDeg ?? 0.00009;
    this.smooth = options.smooth ?? false;
    this.maxBatch = options.maxBatch ?? 16;
    this.pauseMs = options.pauseMs ?? 200;
    this.maxPending = options.maxPending ?? 400;
    this.maxCells = options.maxCells ?? 40_000;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Cells sampled so far. */
  get size(): number {
    return this.cache.size;
  }

  /** Lookups waiting to be made. */
  get waiting(): number {
    return this.pending.size;
  }

  heightAt(lon: number, lat: number): number | undefined {
    return this.resolve(lon, lat, true);
  }

  peek(lon: number, lat: number): number | undefined {
    return this.resolve(lon, lat, false);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.cache.clear();
    this.pending.clear();
    this.failed.clear();
  }

  private resolve(lon: number, lat: number, request: boolean): number | undefined {
    const row = Math.round(lat / this.cellDeg);
    // Cells are kept roughly square: a degree of longitude is shorter than a degree of latitude.
    const lonCell = this.cellDeg / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const column = Math.round(lon / lonCell);
    const centre = this.cell(row, column, lonCell, request);
    if (!this.smooth) return centre;

    const values: number[] = [];
    for (let dr = -1; dr <= 1; dr += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        const value = dr === 0 && dc === 0 ? centre : this.cell(row + dr, column + dc, lonCell, request);
        if (value !== undefined) values.push(value);
      }
    }
    if (centre === undefined) return undefined;
    // With most of the neighbourhood known, the median; until then the cell itself.
    if (values.length < 5) return centre;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  private cell(row: number, column: number, lonCell: number, request: boolean): number | undefined {
    const key = `${row}:${column}`;
    const known = this.cache.get(key);
    if (known !== undefined || !request) return known;
    if (!this.pending.has(key) && (this.failed.get(key) ?? 0) < 3) {
      // Sample the centre of the cell, so every point in the cell gets the same answer.
      this.pending.set(key, { lat: row * this.cellDeg, lon: column * lonCell });
      if (this.pending.size > this.maxPending) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
      this.schedule();
    }
    return undefined;
  }

  private schedule(): void {
    if (this.timer !== null || this.busy || this.disposed) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.pauseMs);
  }

  private async flush(): Promise<void> {
    if (this.busy || this.disposed || this.pending.size === 0) return;
    this.busy = true;
    // Newest first: those are where aircraft are now.
    const batch = [...this.pending].slice(-this.maxBatch);
    for (const [key] of batch) this.pending.delete(key);
    try {
      const heights = await this.options.sampleBatch(batch.map(([, p]) => ({ lon: p.lon, lat: p.lat })));
      if (this.disposed) return;
      if (this.cache.size + batch.length > this.maxCells) this.cache.clear();
      batch.forEach(([key], i) => {
        const h = heights[i];
        if (typeof h === 'number' && Number.isFinite(h)) this.cache.set(key, h);
        else this.failed.set(key, (this.failed.get(key) ?? 0) + 1);
      });
    } catch {
      for (const [key] of batch) this.failed.set(key, (this.failed.get(key) ?? 0) + 1);
    } finally {
      this.busy = false;
      if (this.pending.size > 0) this.schedule();
    }
  }
}

const DIAGONALS: [number, number][] = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

export interface ProbedGroundOptions {
  /** Reads the surface height at a point from what is loaded right now. Undefined where nothing is loaded. */
  probe: (lon: number, lat: number) => number | undefined;
  /** Grid size in degrees of latitude. The default is about 10 m. */
  cellDeg?: number;
  /** Median over the cell and its four diagonal neighbours; see `SampledGroundOptions.smooth`. */
  smooth?: boolean;
  /**
   * How long an answer is trusted. The loaded tiles change as the camera moves (finer nearby, coarser far
   * away); re-reading keeps aircraft on the surface as it is drawn now.
   */
  ttlMs?: number;
  /** A point with nothing loaded under it is not asked again for this long. */
  retryMs?: number;
  /** Probes allowed between two calls of `beginFrame`: a cap on what a single frame may cost. */
  probesPerFrame?: number;
  /**
   * The share of all time that probes may take, 0 to 1. A probe reads tile geometry back from the graphics
   * processor and waits for it: nothing on a desktop, much of a frame on a phone. Where probes are slow there
   * are simply fewer of them. No limit when left out.
   */
  share?: number;
  maxCells?: number;
  now?: () => number;
}

/** The part of a frame's probes that only places never read before may use. */
const NEW_CELLS_SHARE = 0.5;
/** Probe time that may be saved up, so that a few aircraft appearing at once are placed without delay. */
const MAX_CREDIT_MS = 12;

/**
 * A surface that can be read synchronously from what is currently loaded (3D tiles). Reading is cheap but
 * not free, so answers are kept on a grid for a few seconds and the number of reads per frame is capped.
 */
export class ProbedGround implements GroundSampler {
  private readonly cache = new Map<string, { height: number | undefined; until: number }>();
  private readonly cellDeg: number;
  private readonly smooth: boolean;
  private readonly ttlMs: number;
  private readonly retryMs: number;
  private readonly probesPerFrame: number;
  private readonly maxCells: number;
  private readonly now: () => number;
  private readonly share: number;
  private budget: number;
  private credit = MAX_CREDIT_MS;
  private probes = 0;

  constructor(private readonly options: ProbedGroundOptions) {
    this.share = options.share ?? Number.POSITIVE_INFINITY;
    this.cellDeg = options.cellDeg ?? 0.00009;
    this.smooth = options.smooth ?? false;
    this.ttlMs = options.ttlMs ?? 20_000;
    this.retryMs = options.retryMs ?? 700;
    this.probesPerFrame = options.probesPerFrame ?? 6;
    this.maxCells = options.maxCells ?? 40_000;
    this.now = options.now ?? (() => performance.now());
    this.budget = this.probesPerFrame;
  }

  /** Cells currently remembered. */
  get size(): number {
    return this.cache.size;
  }

  /** Probes made so far, for tests and diagnostics. */
  get probeCount(): number {
    return this.probes;
  }

  /** Call once per frame, with the time since the last one: renews the allowance of probes. */
  beginFrame(elapsedMs = 16): void {
    this.budget = this.probesPerFrame;
    this.credit = Math.min(MAX_CREDIT_MS, this.credit + Math.min(elapsedMs, 250) * this.share);
  }

  /** The surface has changed: read every height again when it is next asked for. The old ones serve until then. */
  refresh(): void {
    for (const entry of this.cache.values()) entry.until = 0;
  }

  heightAt(lon: number, lat: number): number | undefined {
    return this.resolve(lon, lat, true);
  }

  peek(lon: number, lat: number): number | undefined {
    return this.resolve(lon, lat, false);
  }

  dispose(): void {
    this.cache.clear();
  }

  private resolve(lon: number, lat: number, refresh: boolean): number | undefined {
    const row = Math.round(lat / this.cellDeg);
    const lonCell = this.cellDeg / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const column = Math.round(lon / lonCell);
    const centre = this.cell(row, column, lonCell, refresh);
    if (!this.smooth || centre === undefined) return centre;

    // The cell and its four diagonal neighbours: five reads cover a 30 m square.
    const values: number[] = [centre];
    for (const [dr, dc] of DIAGONALS) {
      const value = this.cell(row + dr, column + dc, lonCell, refresh);
      if (value !== undefined) values.push(value);
    }
    if (values.length < 4) return centre;
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  }

  private cell(row: number, column: number, lonCell: number, refresh: boolean): number | undefined {
    const key = `${row}:${column}`;
    const entry = this.cache.get(key);
    if (!refresh) return entry?.height;
    const now = this.now();
    if (entry && now < entry.until) return entry.height;
    // Out of allowance for this frame: keep using the old answer, and ask again next frame.
    if (this.budget <= 0 || this.credit <= 0) return entry?.height;
    // Part of the allowance is kept for places never read before: an aircraft rolling out needs those now,
    // while an old answer is still a good one.
    if (entry && this.budget <= this.probesPerFrame * NEW_CELLS_SHARE) return entry.height;
    this.budget -= 1;
    this.probes += 1;
    const height = this.options.probe(column * lonCell, row * this.cellDeg);
    this.credit -= this.now() - now;
    const valid = typeof height === 'number' && Number.isFinite(height);
    if (!entry && this.cache.size >= this.maxCells) this.cache.clear();
    // Spread the expiry a little, so a row of parked aircraft is not re-read in the same frame.
    const life = valid ? this.ttlMs * (0.75 + ((row * 31 + column * 17) & 15) / 32) : this.retryMs;
    // While nothing is loaded at a point, the last known height is better than none.
    this.cache.set(key, { height: valid ? height : entry?.height, until: now + life });
    return valid ? height : entry?.height;
  }
}
