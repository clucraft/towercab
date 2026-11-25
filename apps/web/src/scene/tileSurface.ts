import { Cartesian3, Cartographic, type Cesium3DTileset, Ellipsoid, Ray, type Scene } from 'cesium';
import type { SurfaceReading } from './ground';

/**
 * Reads the height of the surface that is drawn from the 3D tiles that are loaded.
 *
 * `Cesium3DTileset.getHeight` looks like the way to do this and is not. Several tiles can cover the same point at
 * the same time (always so while finer ones arrive, with `skipLevelOfDetail` also afterwards). Cesium draws the
 * finest of them, but `getHeight` answers with the one whose bounding sphere comes up highest, which is the
 * roughest. At KLAF one such tile lies 103 m above the taxiways, and aircraft jumped up to it and back.
 *
 * The tiles in use, and looking for a point in one, are not part of Cesium's public interface. The version is
 * pinned, and `tileSurface.test.ts` fails if an upgrade takes them away.
 */

/** What is used of Cesium's tiles. */
export interface SurfaceTile {
  /** How far, in metres, this tile may be from the truth. Rough tiles have large values. */
  readonly geometricError: number;
  readonly content?: {
    pick?(ray: Ray, frameState: unknown, result: Cartesian3): Cartesian3 | undefined;
  };
  readonly contentBoundingVolume?: { readonly boundingVolume?: unknown };
}

/**
 * Tiles rougher than this say nothing useful about where the ground is. At KLAF and KIND tiles of 64 m were within
 * 3 m of the surface and tiles of 128 m within 6. Rougher ones were off by 10, 15, 40 and 100 m.
 */
export const ROUGHEST_M = 150;

/** Where the ray starts, above the airfield: higher than anything that could be a surface. */
const START_ABOVE_M = 2000;

/** At its edges the surface of a tile reaches a little past the tile's box (0.05 percent was seen). */
const BOX_SLACK = 1.02;

/** The finest of `tiles` that the ray meets, and where. */
export function finestHit(
  tiles: Iterable<SurfaceTile>,
  ray: Ray,
  frameState: unknown,
  result: Cartesian3,
): { point: Cartesian3; errorM: number } | undefined {
  const candidates: SurfaceTile[] = [];
  for (const tile of tiles) {
    if (!(tile.geometricError <= ROUGHEST_M) || !tile.content?.pick) continue;
    // Looking into a tile reads its geometry back from the graphics processor, so first make sure that the
    // point can be in it at all.
    if (mayMeet(ray, tile.contentBoundingVolume?.boundingVolume)) candidates.push(tile);
  }
  candidates.sort((a, b) => a.geometricError - b.geometricError);
  for (const tile of candidates) {
    const point = tile.content?.pick?.(ray, frameState, result);
    if (point) return { point, errorM: tile.geometricError };
  }
  return undefined;
}

/** A probe for `ProbedGround`: the drawn surface at a point, or undefined where no usable tile is loaded. */
export function tileProbe(
  tileset: Cesium3DTileset,
  scene: Scene,
  fieldEllipsoidM: number,
): (lon: number, lat: number) => SurfaceReading | undefined {
  const tiles = tileset as unknown as { _selectedTiles?: SurfaceTile[] };
  const { frameState } = scene as unknown as { frameState: unknown };
  const ellipsoid = Ellipsoid.WGS84;
  const ray = new Ray();
  const at = new Cartographic();
  const scratch = new Cartesian3();
  return (lon, lat) => {
    if (!tiles._selectedTiles) return undefined;
    Cartographic.fromDegrees(lon, lat, fieldEllipsoidM + START_ABOVE_M, at);
    ellipsoid.cartographicToCartesian(at, ray.origin);
    ellipsoid.geodeticSurfaceNormalCartographic(at, ray.direction);
    Cartesian3.negate(ray.direction, ray.direction);
    const hit = finestHit(tiles._selectedTiles, ray, frameState, scratch);
    const height = hit && ellipsoid.cartesianToCartographic(hit.point, at)?.height;
    return height === undefined || !hit ? undefined : { height, errorM: hit.errorM };
  };
}

/** Whether a ray can meet something inside an oriented box. True for any other kind of volume. */
function mayMeet(ray: Ray, volume: unknown): boolean {
  const { center, halfAxes } = (volume ?? {}) as { center?: Cartesian3; halfAxes?: ArrayLike<number> };
  if (!center || !halfAxes) return true;
  const { origin, direction } = ray;
  const dx = origin.x - center.x;
  const dy = origin.y - center.y;
  const dz = origin.z - center.z;
  let near = 0;
  let far = Number.POSITIVE_INFINITY;
  // The columns of `halfAxes` run from the centre to the sides, so in their terms a box goes from -1 to 1.
  for (let column = 0; column < 9; column += 3) {
    const ax = halfAxes[column] as number;
    const ay = halfAxes[column + 1] as number;
    const az = halfAxes[column + 2] as number;
    const square = ax * ax + ay * ay + az * az;
    if (!(square > 0)) return true;
    const start = (dx * ax + dy * ay + dz * az) / square;
    const speed = (direction.x * ax + direction.y * ay + direction.z * az) / square;
    if (Math.abs(speed) < 1e-15) {
      if (Math.abs(start) > BOX_SLACK) return false;
      continue;
    }
    const one = (-BOX_SLACK - start) / speed;
    const two = (BOX_SLACK - start) / speed;
    near = Math.max(near, Math.min(one, two));
    far = Math.min(far, Math.max(one, two));
    if (near > far) return false;
  }
  return true;
}
