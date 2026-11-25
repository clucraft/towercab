import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlatGround, ProbedGround, SampledGround, type SurfaceReading } from './ground';

const CELL = 0.00009;

describe('FlatGround', () => {
  it('is at height zero everywhere', () => {
    const ground = new FlatGround();
    expect(ground.heightAt()).toBe(0);
    expect(ground.peek()).toBe(0);
    expect(ground.backgroundHeightAt()).toBe(0);
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

  it('peek never starts a lookup, and neither does a trail', async () => {
    const { ground, batches } = make(() => 10);
    expect(ground.peek(-86.94, 40.41)).toBeUndefined();
    expect(ground.backgroundHeightAt(-86.94, 40.41)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(batches).toHaveLength(0);
    ground.heightAt(-86.94, 40.41);
    await vi.advanceTimersByTimeAsync(250);
    expect(ground.peek(-86.94, 40.41)).toBe(10);
    expect(ground.backgroundHeightAt(-86.94, 40.41)).toBe(10);
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
  /** A bare number stands for a surface read from tiles as fine as they come. */
  const make = (surface: (lon: number, lat: number) => number | SurfaceReading | undefined, extra = {}) => {
    clock = 0;
    const probe = (lon: number, lat: number): SurfaceReading | undefined => {
      const found = surface(lon, lat);
      return typeof found === 'number' ? { height: found, errorM: 2 } : found;
    };
    return new ProbedGround({ probe, cellDeg: CELL, now: () => clock, ...extra });
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

  it('spends no more than its share of the time on reads, however slow they are', () => {
    // A device on which one read takes 20 ms, at 30 frames a second.
    const ground = make(
      () => {
        clock += 20;
        return 200;
      },
      { probesPerFrame: 6, share: 0.06 },
    );
    const ask = () => {
      for (let i = 0; i < 40; i += 1) ground.heightAt(-86.29 + i * 0.001, 39.71);
    };
    // The first read has credit to draw on; it uses it all up.
    ask();
    expect(ground.probeCount).toBe(1);
    for (let frame = 0; frame < 300; frame += 1) {
      ground.beginFrame(33);
      ask();
    }
    // Ten seconds at 6 percent is 600 ms: about thirty reads, where the cap alone would allow 1800.
    expect(ground.probeCount).toBeGreaterThan(20);
    expect(ground.probeCount).toBeLessThan(40);
  });

  it('reads again when told that the surface has changed, and serves the old answer until then', () => {
    let height = 214;
    const ground = make(() => height, { probesPerFrame: 2 });
    expect(ground.heightAt(-86.29, 39.71)).toBe(214);
    ground.heightAt(-86.29, 39.72);
    height = 208;
    ground.refresh();
    expect(ground.peek(-86.29, 39.71)).toBe(214);
    // No allowance left in this frame.
    expect(ground.heightAt(-86.29, 39.71)).toBe(214);
    ground.beginFrame();
    expect(ground.heightAt(-86.29, 39.71)).toBe(208);
  });

  it('reads places it has never seen before it reads old ones again', () => {
    const asked: number[] = [];
    const ground = make(
      (lon) => {
        asked.push(Math.round((lon + 86.29) * 1000));
        return 200;
      },
      { probesPerFrame: 4 },
    );
    for (let i = 0; i < 4; i += 1) ground.heightAt(-86.29 + i * 0.001, 39.71);
    ground.beginFrame();
    ground.refresh();
    asked.length = 0;
    // Four old places ask first, then two new ones: half of the allowance was kept for those.
    for (const i of [0, 1, 2, 3, 10, 11]) ground.heightAt(-86.29 + i * 0.001, 39.71);
    expect(asked).toEqual([0, 1, 10, 11]);
  });

  it('keeps a good reading when only rougher tiles are there, and lets a finer one replace a rough one', () => {
    let now: SurfaceReading | undefined = { height: 149.6, errorM: 128 };
    const ground = make(() => now, { ttlMs: 20_000 });
    const readAgain = (next: SurfaceReading | undefined) => {
      now = next;
      ground.refresh();
      ground.beginFrame();
      return ground.heightAt(-86.94, 40.41);
    };
    expect(ground.heightAt(-86.94, 40.41)).toBe(149.6);
    expect(readAgain({ height: 148.1, errorM: 64 })).toBe(148.1);
    expect(readAgain({ height: 147.4, errorM: 8 })).toBe(147.4);
    // Zooming out, and tiles that arrive a moment before the finer ones do.
    expect(readAgain({ height: 149.6, errorM: 128 })).toBe(147.4);
    expect(readAgain({ height: 151.9, errorM: 32 })).toBe(147.4);
    expect(readAgain(undefined)).toBe(147.4);
    // As long as it is drawn well, the aircraft stands on the surface as it is drawn.
    expect(readAgain({ height: 147.7, errorM: 16 })).toBe(147.7);
    expect(readAgain({ height: 147.5, errorM: 4 })).toBe(147.5);
  });

  it('comes back to a rough reading soon while more is loading, and to a good one when its time is up', () => {
    let calls = 0;
    let settled = true;
    let now: SurfaceReading = { height: 149.6, errorM: 64 };
    const ground = make(
      () => {
        calls += 1;
        return now;
      },
      { ttlMs: 60_000, settled: () => settled },
    );
    const at = (ms: number) => {
      clock = ms;
      ground.beginFrame();
      return ground.heightAt(-86.94, 40.41);
    };
    expect(at(0)).toBe(149.6);
    // Seen from far off this is as good as it gets.
    expect(at(20_000)).toBe(149.6);
    expect(calls).toBe(1);
    // Zooming in: once a second until it is good.
    settled = false;
    for (let ms = 20_000; ms < 23_000; ms += 100) at(ms);
    expect(calls).toBe(4);
    now = { height: 147.4, errorM: 8 };
    expect(at(23_000)).toBe(147.4);
    expect(at(40_000)).toBe(147.4);
    expect(calls).toBe(5);
  });

  it('looks up the points of a trail once, and only where they are not known well', () => {
    const asked: number[] = [];
    let rough = true;
    const ground = make(
      (lon) => {
        const i = Math.round((lon + 86.29) * 1000);
        asked.push(i);
        return i === 1 && rough ? { height: 210, errorM: 128 } : 200;
      },
      { probesPerFrame: 10 },
    );
    const trail = () => [0, 1, 2].map((i) => ground.backgroundHeightAt(-86.29 + i * 0.001, 39.71));
    expect(trail()).toEqual([200, 210, 200]);
    expect(asked).toEqual([0, 1, 2]);
    // A minute later the good ones have not been read again: what is under a trail does not move.
    asked.length = 0;
    rough = false;
    clock = 60_000;
    ground.beginFrame();
    expect(trail()).toEqual([200, 200, 200]);
    expect(asked).toEqual([1]);
    ground.beginFrame();
    trail();
    expect(asked).toEqual([1]);
  });

  it('does not keep asking for the points of a trail that nothing is loaded under', () => {
    let calls = 0;
    const ground = make(() => {
      calls += 1;
      return undefined;
    });
    for (clock = 0; clock < 10_000; clock += 200) {
      ground.beginFrame();
      expect(ground.backgroundHeightAt(-86.29, 39.71)).toBeUndefined();
    }
    expect(calls).toBe(3);
    // When the view has loaded, at once.
    ground.refresh();
    ground.beginFrame();
    ground.backgroundHeightAt(-86.29, 39.71);
    expect(calls).toBe(4);
  });

  it('leaves the allowance to the aircraft: a trail gets what is over', () => {
    const asked: number[] = [];
    const ground = make(
      (lon) => {
        asked.push(Math.round((lon + 86.29) * 1000));
        clock += 3;
        return 200;
      },
      { probesPerFrame: 4, share: 0.1 },
    );
    // Two aircraft have used half of the credit of 12 ms.
    ground.heightAt(-86.29, 39.71);
    ground.heightAt(-86.289, 39.71);
    expect(ground.backgroundHeightAt(-86.28, 39.71)).toBe(200);
    expect(ground.backgroundHeightAt(-86.279, 39.71)).toBeUndefined();
    expect(asked).toEqual([0, 1, 10]);
    // The next aircraft is not kept waiting.
    expect(ground.heightAt(-86.288, 39.71)).toBe(200);
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
