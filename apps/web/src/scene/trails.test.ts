import type { Aircraft, Phase } from '@towercab/shared';
import { Cartesian3, type Material, type Polyline, type PolylineCollection, type Scene } from 'cesium';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AircraftLayer, DrawnAircraft } from './aircraftLayer';
import { TrailLayer } from './trails';

const T0 = 1_000_000;

function aircraft(hex: string, at: number, step: number, phase: Phase = 'pattern'): Aircraft {
  return {
    hex,
    addrType: 'adsb_icao',
    lat: 40.4 + step * 0.001,
    lon: -86.9,
    posTime: at,
    seenTime: at,
    heightM: 400,
    altSource: 'geom',
    onGround: false,
    phase,
    source: 'adsbfi',
  } as Aircraft;
}

/** A scene with nothing but a list of primitives, and a layer that has the aircraft it is told about. */
function setUp() {
  let lines: PolylineCollection | null = null;
  const scene = {
    primitives: {
      add: (p: PolylineCollection) => {
        lines = p;
        return p;
      },
      remove: (p: PolylineCollection) => p.destroy(),
    },
  } as unknown as Scene;
  const trails = new TrailLayer(scene);
  const present = new Map<string, Aircraft>();
  const layer = {
    get: (hex: string) => {
      const data = present.get(hex);
      if (!data) return undefined;
      const position = Cartesian3.fromDegrees(data.lon, data.lat, 400);
      return { hex, data, position, visible: true } as unknown as DrawnAircraft;
    },
  } as AircraftLayer;
  const report = (a: Aircraft) => {
    present.set(a.hex, a);
    trails.append(a);
  };
  const drawn = (): Polyline[] => {
    const all = lines as PolylineCollection | null;
    return all ? Array.from({ length: all.length }, (_, i) => all.get(i)) : [];
  };
  return { trails, layer, present, report, drawn };
}

// Cesium's materials ask whether a value is a canvas or an image, which Node has no names for.
beforeAll(() => {
  for (const name of ['HTMLCanvasElement', 'HTMLImageElement', 'ImageBitmap', 'OffscreenCanvas']) {
    if (!(name in globalThis)) vi.stubGlobal(name, class {});
  }
});

describe('trails', () => {
  it('do not share a material: an aircraft that leaves must not take the others down with it', () => {
    const { trails, layer, present, report, drawn } = setUp();
    for (const hex of ['aaaaa1', 'aaaaa2']) {
      report(aircraft(hex, T0, 0));
      report(aircraft(hex, T0 + 2000, 1));
    }
    trails.update(T0 + 3000, layer);
    expect(drawn()).toHaveLength(2);

    // Cesium destroys a line's material along with the line.
    const leaving = drawn()[0]?.material as Material;
    present.delete('aaaaa1');
    trails.update(T0 + 3200, layer);
    expect(leaving.isDestroyed()).toBe(true);
    expect(drawn()).toHaveLength(1);
    expect(drawn()[0]?.material.isDestroyed()).toBe(false);

    // The next aircraft in the same phase gets a material that is alive, too.
    report(aircraft('aaaaa3', T0 + 3000, 0));
    report(aircraft('aaaaa3', T0 + 5000, 1));
    trails.update(T0 + 6000, layer);
    expect(drawn()).toHaveLength(2);
    expect(drawn().every((line) => !line.material.isDestroyed())).toBe(true);

    // So does one that changes phase.
    report(aircraft('aaaaa2', T0 + 6000, 3, 'landing_roll'));
    trails.update(T0 + 6200, layer);
    present.clear();
    trails.update(T0 + 6400, layer);
    expect(drawn()).toHaveLength(0);
    expect(() => trails.destroy()).not.toThrow();
  });

  it('end at the aircraft as drawn, and show nothing newer than that', () => {
    const { trails, layer, report, drawn } = setUp();
    report(aircraft('aaaaa1', T0, 0));
    report(aircraft('aaaaa1', T0 + 2000, 1));
    report(aircraft('aaaaa1', T0 + 4000, 2));
    trails.update(T0 + 2500, layer);
    // Two points of history (the third is in the future) and the aircraft itself.
    expect(drawn()[0]?.positions).toHaveLength(3);
  });
});
