import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlatGround, ProbedGround, SampledGround } from './ground';

const CELL = 0.00009;

describe('FlatGround', () => {
  it('is at height zero everywhere', () => {
    const ground = new FlatGround();
    expect(ground.heightAt()).toBe(0);
    expect(ground.peek()).toBe(0);
  });
});

describe('SampledGround', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A sampler over a made-up surface, recording what it was asked. */
  const make = (surface: (lon: number, lat: number) => number | undefined, extra = {}) => {
    const batches: { lon: number; lat: number }[][] = [];
    const ground = new SampledGround({
      sampleBatch: async (points) => {
        batches.push(points);
        return points.map((p) => surface(p.lon, p.lat));
      },
      cellDeg: CELL,
      ...extra,
    });
    return { ground, batches };
  };

  it('does not know a height until it has been sampled, then answers from memory', async () => {
    const { ground, batches } = make(() => 151.2);
    expect(ground.heightAt(-86.94, 40.41)).toBeUndefined();
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(batches).toHaveLength(1);
    expect(ground.heightAt(-86.94, 40.41)).toBe(151.2);
    // The same cell again costs nothing.
    ground.heightAt(-86.94, 40.41);
    ground.heightAt(-86.940001, 40.410001);
    await vi.advanceTimersByTimeAsync(1000);
    expect(batches).toHaveLength(1);
    expect(ground.size).toBe(1);
  });

  it('peek never starts a lookup', async () => {
    const { ground, batches } = make(() => 10);
    expect(ground.peek(-86.94, 40.41)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(batches).toHaveLength(0);
    ground.heightAt(-86.94, 40.41);
    await vi.advanceTimersByTimeAsync(250);
    expect(ground.peek(-86.94, 40.41)).toBe(10);
  });

  it('asks for many points in one go, a limited number at a time, with a pause between', async () => {
    const { ground, batches } = make(() => 5, { maxBatch: 16, pauseMs: 200 });
    for (let i = 0; i < 40; i += 1) ground.heightAt(-86.94 + i * 0.001, 40.41);
    await vi.advanceTimersByTimeAsync(199);
    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(16);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);
    expect(batches.map((b) => b.length)).toEqual([16, 16, 8]);
    expect(ground.waiting).toBe(0);
  });

  it('serves the newest requests first and drops the oldest when too many are waiting', async () => {
    const { ground, batches } = make(() => 5, { maxBatch: 4, maxPending: 10 });
    for (let i = 0; i < 30; i += 1) ground.heightAt(-86.94 + i * 0.001, 40.41);
    expect(ground.waiting).toBe(10);
    await vi.advanceTimersByTimeAsync(200);
    // The last four asked for, which is where aircraft are now.
    const lons = (batches[0] ?? []).map((p) => Math.round((p.lon + 86.94) / 0.001));
    expect(lons.sort((a, b) => a - b)).toEqual([26, 27, 28, 29]);
  });

  it('gives up on a point that has no surface after three tries', async () => {
    const { ground, batches } = make(() => undefined);
    for (let i = 0; i < 6; i += 1) {
      expect(ground.heightAt(-86.94, 40.41)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
    }
    expect(batches).toHaveLength(3);
  });

  it('survives a failing lookup', async () => {
    let fail = true;
    const ground = new SampledGround({
      sampleBatch: async (points) => {
        if (fail) throw new Error('tiles unavailable');
        return points.map(() => 7);
      },
      cellDeg: CELL,
    });
    ground.heightAt(-86.94, 40.41);
    await vi.advanceTimersByTimeAsync(250);
    expect(ground.heightAt(-86.94, 40.41)).toBeUndefined();
    fail = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(ground.heightAt(-86.94, 40.41)).toBe(7);
  });

  it('with smoothing, ignores a lump where an aircraft stood when the photogrammetry was captured', async () => {
    // Flat apron at 150 m with one 6 m lump exactly where we ask.
    const lumpLat = Math.round(40.41 / CELL) * CELL;
    const { ground } = make((_lon, lat) => (Math.abs(lat - lumpLat) < CELL / 2 ? 156 : 150), {
      smooth: true,
    });
    // Only the row through the lump is 156: three of nine cells.
    ground.heightAt(-86.94, 40.41);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ground.heightAt(-86.94, 40.41)).toBe(150);
    // Without smoothing the aircraft would be standing on the lump.
    const plain = make((_lon, lat) => (Math.abs(lat - lumpLat) < CELL / 2 ? 156 : 150));
    plain.ground.heightAt(-86.94, 40.41);
    await vi.advanceTimersByTimeAsync(1000);
    expect(plain.ground.heightAt(-86.94, 40.41)).toBe(156);
  });

  it('with smoothing, does not drop an aircraft through a bridge: a median, not a minimum', async () => {
    // A taxiway bridge 3 cells wide at 150 m over a road at 143 m. Standing in the middle of it.
    const { ground } = make((lon) => (Math.abs(lon + 86.94) < 0.00025 ? 150 : 143), { smooth: true });
    ground.heightAt(-86.94, 40.41);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ground.heightAt(-86.94, 40.41)).toBe(150);
  });

  it('forgets everything on dispose and makes no further requests', async () => {
    const { ground, batches } = make(() => 5);
    ground.heightAt(-86.94, 40.41);
    ground.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    expect(batches).toHaveLength(0);
    expect(ground.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('ProbedGround', () => {
  let clock = 0;
  const make = (surface: (lon: number, lat: number) => number | undefined, extra = {}) => {
    clock = 0;
    return new ProbedGround({ probe: surface, cellDeg: CELL, now: () => clock, ...extra });
  };

  it('reads the surface at once and remembers it for a few seconds', () => {
    let calls = 0;
    const ground = make(() => {
      calls += 1;
      return 208.4;
    });
    expect(ground.heightAt(-86.29, 39.71)).toBe(208.4);
    expect(ground.heightAt(-86.29, 39.71)).toBe(208.4);
    expect(ground.peek(-86.29, 39.71)).toBe(208.4);
    expect(calls).toBe(1);
  });

  it('reads again after the answer has aged, so aircraft follow the tiles as they refine', () => {
    let height = 210;
    const ground = make(() => height, { ttlMs: 20_000 });
    expect(ground.heightAt(-86.29, 39.71)).toBe(210);
    height = 208.6; // finer tiles have loaded
    clock = 12_000;
    expect(ground.heightAt(-86.29, 39.71)).toBe(210);
    clock = 28_000;
    ground.beginFrame();
    expect(ground.heightAt(-86.29, 39.71)).toBe(208.6);
  });

  it('caps the reads per frame and catches up over the following frames', () => {
    const ground = make(() => 200, { probesPerFrame: 10 });
    const ask = () => {
      let known = 0;
      for (let i = 0; i < 25; i += 1)
        if (ground.heightAt(-86.29 + i * 0.001, 39.71) !== undefined) known += 1;
      return known;
    };
    expect(ask()).toBe(10);
    expect(ground.probeCount).toBe(10);
    ground.beginFrame();
    expect(ask()).toBe(20);
    ground.beginFrame();
    expect(ask()).toBe(25);
    expect(ground.probeCount).toBe(25);
  });

  it('where nothing is loaded yet it waits a little before asking again, and keeps the last known height', () => {
    let loaded = false;
    let calls = 0;
    const ground = make(() => {
      calls += 1;
      return loaded ? 207 : undefined;
    });
    expect(ground.heightAt(-86.29, 39.71)).toBeUndefined();
    clock = 300;
    ground.beginFrame();
    expect(ground.heightAt(-86.29, 39.71)).toBeUndefined();
    expect(calls).toBe(1);
    loaded = true;
    clock = 800;
    ground.beginFrame();
    expect(ground.heightAt(-86.29, 39.71)).toBe(207);
    // The tiles under the point are unloaded again (camera moved away): the aircraft stays where it was.
    loaded = false;
    clock = 30_000;
    ground.beginFrame();
    expect(ground.heightAt(-86.29, 39.71)).toBe(207);
  });

  it('peek never reads', () => {
    let calls = 0;
    const ground = make(() => {
      calls += 1;
      return 1;
    });
    expect(ground.peek(-86.29, 39.71)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('with smoothing, takes the median of the neighbourhood', () => {
    const lumpLat = Math.round(39.71 / CELL) * CELL;
    const ground = make((_lon, lat) => (Math.abs(lat - lumpLat) < CELL / 2 ? 214 : 208), {
      smooth: true,
      probesPerFrame: 100,
    });
    expect(ground.heightAt(-86.29, 39.71)).toBe(208);
    // The cell itself and its four diagonal neighbours.
    expect(ground.probeCount).toBe(5);
  });
});
