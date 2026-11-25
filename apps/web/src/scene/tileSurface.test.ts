import * as Cesium from 'cesium';
import { Cartesian3, Cesium3DTileset, Matrix3, Ray } from 'cesium';
import { describe, expect, it } from 'vitest';
import { finestHit, ROUGHEST_M, type SurfaceTile } from './tileSurface';

/** Straight down at x = y = 0, from 1000 m. */
const down = new Ray(new Cartesian3(0, 0, 1000), new Cartesian3(0, 0, -1));

const box = (x: number, y: number, half: number, z = 150) => ({
  center: new Cartesian3(x, y, z),
  halfAxes: Matrix3.fromScale(new Cartesian3(half, half, 200)),
});

/** A tile with a flat surface at `height`, which counts how often it is looked into. */
function tile(geometricError: number, height: number | null, volume: unknown = box(0, 0, 1000)) {
  const looked = { times: 0 };
  const made: SurfaceTile = {
    geometricError,
    content: {
      pick: (_ray, _frame, result) => {
        looked.times += 1;
        return height === null ? undefined : Cartesian3.fromElements(0, 0, height, result);
      },
    },
    contentBoundingVolume: { boundingVolume: volume },
  };
  return Object.assign(made, { looked });
}

const read = (tiles: SurfaceTile[]) => {
  const hit = finestHit(tiles, down, {}, new Cartesian3());
  return hit && { height: hit.point.z, errorM: hit.errorM };
};

describe('finestHit', () => {
  it('reads the finest tile at a point, which is the one that is drawn, in whatever order they come', () => {
    // As found at KLAF while the view moved: the answer used to be 253, 103 m above the taxiway.
    const tiles = [tile(128, 149.5), tile(2055, 253), tile(16, 147.6), tile(514, 152)];
    expect(read(tiles)).toEqual({ height: 147.6, errorM: 16 });
    expect(read([...tiles].reverse())).toEqual({ height: 147.6, errorM: 16 });
  });

  it('has no answer when only tiles too rough to say where the ground is are loaded', () => {
    expect(read([tile(2055, 253), tile(4109, 192), tile(257, 156)])).toBeUndefined();
    expect(read([tile(ROUGHEST_M, 150)])).toEqual({ height: 150, errorM: ROUGHEST_M });
    expect(read([])).toBeUndefined();
  });

  it('goes on to the next finest where the finest has a hole', () => {
    expect(read([tile(8, null), tile(32, 148)])).toEqual({ height: 148, errorM: 32 });
  });

  it('does not look into tiles the point is not in, and stops at the first that answers', () => {
    const here = tile(8, 147, box(0, 0, 60));
    const beside = tile(4, 150, box(100, 0, 60));
    const parent = tile(64, 149);
    expect(read([parent, beside, here])).toEqual({ height: 147, errorM: 8 });
    expect(beside.looked.times).toBe(0);
    expect(here.looked.times).toBe(1);
    expect(parent.looked.times).toBe(0);
  });

  it('finds the edge of a surface that reaches a little past its box', () => {
    expect(read([tile(64, 147, box(100.05, 0, 100))])?.height).toBe(147);
    expect(read([tile(64, 147, box(110, 0, 100))])).toBeUndefined();
  });

  it('copes with a box that is turned, and with any other kind of volume', () => {
    const turn = Matrix3.fromRotationZ(Math.PI / 4);
    const halfAxes = Matrix3.multiply(turn, Matrix3.fromScale(new Cartesian3(100, 10, 200)), new Matrix3());
    // A long narrow box lying at 45 degrees: the ray is on its long axis, then beside it.
    expect(read([tile(8, 1, { center: new Cartesian3(50, 50, 150), halfAxes })])?.height).toBe(1);
    expect(read([tile(8, 1, { center: new Cartesian3(50, -50, 150), halfAxes })])).toBeUndefined();
    expect(read([tile(8, 2, { center: new Cartesian3(0, 0, 0), radius: 5 })])?.height).toBe(2);
    expect(read([tile(8, 3, undefined)])?.height).toBe(3);
  });

  it('skips tiles whose content is not there', () => {
    expect(read([{ geometricError: 4 }, { geometricError: 8, content: {} }, tile(16, 5)])?.height).toBe(5);
  });
});

describe('what is used of Cesium without being public', () => {
  it('is there in this version', () => {
    const tileset = new Cesium3DTileset({}) as unknown as { _selectedTiles?: unknown };
    expect(Array.isArray(tileset._selectedTiles)).toBe(true);
    const classes = Cesium as unknown as Record<string, { prototype: Record<string, unknown> } | undefined>;
    expect(typeof classes.Model3DTileContent?.prototype.pick).toBe('function');
    const obb = classes.TileOrientedBoundingBox?.prototype as object;
    expect(Object.getOwnPropertyDescriptor(obb, 'boundingVolume')?.get).toBeTypeOf('function');
    const tile = classes.Cesium3DTile?.prototype as object;
    expect(Object.getOwnPropertyDescriptor(tile, 'contentBoundingVolume')?.get).toBeTypeOf('function');
    expect(Object.getOwnPropertyDescriptor(tile, 'content')?.get).toBeTypeOf('function');
    const scene = classes.Scene?.prototype as object;
    expect(Object.getOwnPropertyDescriptor(scene, 'frameState')?.get).toBeTypeOf('function');
  });
});
