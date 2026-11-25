import type { Aircraft, Phase } from '@towercab/shared';
import {
  Cartesian3,
  Cartographic,
  type Material,
  type Polyline,
  type PolylineCollection,
  type Scene,
} from 'cesium';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AircraftLayer, DrawnAircraft } from './aircraftLayer';
import type { GroundSampler } from './ground';
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
    // Straight above the first point.
    camera: { positionWC: Cartesian3.fromDegrees(-86.9, 40.4, 150) },
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
  return {
    trails,
    layer,
    present,
    report,
    drawn,
    scene: scene as unknown as { camera: { positionWC: Cartesian3 } },
  };
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

  describe('on the ground', () => {
    const FIELD = 150;

    /** The heights of a taxiing aircraft's trail, for a surface known at some of the points. */
    function taxi(known: (step: number) => number | undefined, cameraHeight = FIELD): number[] {
      const { trails, layer, report, drawn, scene } = setUp();
      scene.camera.positionWC = Cartesian3.fromDegrees(-86.9, 40.4, cameraHeight);
      const ground = {
        backgroundHeightAt: (_lon: number, lat: number) => known(Math.round((lat - 40.4) * 10_000)),
      } as GroundSampler;
      trails.setGround(ground, (h) => h, FIELD);
      for (let step = 0; step < 6; step += 1) {
        const a = aircraft('aaaaa1', T0 + step * 2000, step / 10, 'taxiing');
        report({ ...a, onGround: true, heightM: undefined });
      }
      trails.update(T0 + 10_000, layer);
      // Without the aircraft itself at the end.
      return (drawn()[0]?.positions ?? []).slice(0, -1).map((p) => Cartographic.fromCartesian(p).height);
    }

    /** Within the clearance that lines have, which grows a little with the distance from the camera. */
    const expectOn = (heights: number[], surface: number[]) => {
      expect(heights).toHaveLength(surface.length);
      heights.forEach((h, i) => {
        expect(h - (surface[i] as number)).toBeGreaterThan(0.39);
        expect(h - (surface[i] as number)).toBeLessThan(0.45);
      });
    };

    it('lie on the surface, a little above it', () => {
      expectOn(
        taxi(() => 147),
        [147, 147, 147, 147, 147, 147],
      );
    });

    it('do not go up on the roof of a building beside the taxiway', () => {
      expectOn(
        taxi((step) => (step === 2 || step === 5 ? 156 : 147)),
        [147, 147, 147, 147, 147, 147],
      );
    });

    it('where the surface is not known, take that of the nearest point rather than the official elevation', () => {
      expectOn(
        taxi((step) => (step === 1 ? 147 : undefined)),
        [147, 147, 147, 147, 147, 147],
      );
      expectOn(
        taxi((step) => (step < 3 ? undefined : 148)),
        [148, 148, 148, 148, 148, 148],
      );
    });

    it('use the official elevation when nothing at all is known', () => {
      expectOn(
        taxi(() => undefined),
        [150, 150, 150, 150, 150, 150],
      );
    });

    it('are lifted by less than a pixel when seen from far away, where the surface is drawn with less detail', () => {
      const [height = 0] = taxi(() => 147, 147 + 4000);
      expect(height - 147).toBeCloseTo(2.4, 1);
      // A pixel, 4 km away, on a screen 1600 pixels wide with Cesium's 60 degrees.
      const pixel = (4000 * 2 * Math.tan(Math.PI / 6)) / 1600;
      expect(height - 147).toBeLessThan(pixel);
    });
  });
});
