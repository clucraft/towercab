import type { Aircraft, Phase, TrailPoint } from '@towercab/shared';
import {
  Cartesian3,
  Color,
  Ellipsoid,
  Material,
  type Polyline,
  PolylineCollection,
  type Scene,
} from 'cesium';
import type { AircraftLayer, DrawnAircraft } from './aircraftLayer';
import type { GroundSampler } from './ground';
import { PHASE_COLORS } from './palette';

/** How much history a trail shows. */
export const TRAIL_MS = 180_000;
/** Ground points sit a little above the surface so the line is not buried in it. */
const GROUND_CLEARANCE_M = 0.4;
/**
 * From far away the surface is drawn with less detail, up to a few metres above where it was read close by. The line
 * is lifted with the distance to stay on top of that, by less than a pixel.
 */
const CLEARANCE_PER_M = 0.0005;
/** Points on either side that a surface height is compared with. */
const NEIGHBOURS = 2;
const MIN_SPACING_MS = 900;

interface Trail {
  points: TrailPoint[];
  line: Polyline | null;
  phase: Phase | null;
}

/**
 * The path each aircraft has flown over the last three minutes. A trail ends at the aircraft as drawn, not at
 * the newest report: the scene runs a couple of seconds behind the data, and a trail running ahead of its
 * aircraft would give the future away.
 */
export class TrailLayer {
  private readonly lines: PolylineCollection;
  private readonly trails = new Map<string, Trail>();
  private ground: GroundSampler | null = null;
  private toSceneHeight: (ellipsoidM: number) => number = (h) => h;
  private fallbackGround = 0;
  private enabled = true;
  private turn = 0;

  constructor(private readonly scene: Scene) {
    this.lines = scene.primitives.add(new PolylineCollection());
  }

  setGround(
    ground: GroundSampler,
    toSceneHeight: (ellipsoidM: number) => number,
    fallbackGroundHeight: number,
  ): void {
    this.ground = ground;
    this.toSceneHeight = toSceneHeight;
    this.fallbackGround = fallbackGroundHeight;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.lines.show = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Replaces all history with what came in a snapshot. */
  reset(aircraft: readonly Aircraft[], trails: Record<string, TrailPoint[]>): void {
    for (const trail of this.trails.values()) if (trail.line) this.lines.remove(trail.line);
    this.trails.clear();
    for (const a of aircraft) {
      const points = [...(trails[a.hex] ?? [])];
      this.trails.set(a.hex, { points, line: null, phase: null });
      this.append(a);
    }
  }

  /** Adds an aircraft's newest position to its history. */
  append(a: Aircraft): void {
    let trail = this.trails.get(a.hex);
    if (!trail) {
      trail = { points: [], line: null, phase: null };
      this.trails.set(a.hex, trail);
    }
    const last = trail.points[trail.points.length - 1];
    if (last && a.posTime - last[0] < MIN_SPACING_MS) return;
    if (last && last[1] === a.lat && last[2] === a.lon) return;
    trail.points.push([a.posTime, a.lat, a.lon, a.onGround ? null : (a.heightM ?? null)]);
  }

  remove(hex: string): void {
    const trail = this.trails.get(hex);
    if (trail?.line) this.lines.remove(trail.line);
    this.trails.delete(hex);
  }

  /** Rebuilds the lines. Called a few times a second, not every frame. */
  update(renderTime: number, layer: AircraftLayer): void {
    if (!this.enabled) return;
    const oldest = renderTime - TRAIL_MS;
    // Heights are looked up with what little the aircraft leave over. Starting with a different trail each time
    // shares that out.
    const all = [...this.trails];
    const first = this.turn;
    this.turn += 1;
    for (let n = 0; n < all.length; n += 1) {
      const [hex, trail] = all[(first + n) % all.length] as [string, Trail];
      const drawn = layer.get(hex);
      if (!drawn) {
        this.remove(hex);
        continue;
      }
      // Drop what has aged out.
      let drop = 0;
      while (drop < trail.points.length && (trail.points[drop] as TrailPoint)[0] < oldest) drop += 1;
      if (drop > 0) trail.points.splice(0, drop);

      const positions: Cartesian3[] = [];
      const surface = this.surfaceAlong(trail.points, renderTime, drawn);
      trail.points.forEach(([t, lat, lon, heightM], i) => {
        if (t > renderTime) return;
        if (heightM === null) positions.push(this.onSurface(lon, lat, surface[i] as number));
        else positions.push(Cartesian3.fromDegrees(lon, lat, this.toSceneHeight(heightM)));
      });
      if (drawn.visible) positions.push(Cartesian3.clone(drawn.position));

      if (positions.length < 2 || !drawn.visible) {
        if (trail.line) trail.line.show = false;
        continue;
      }
      if (!trail.line) {
        trail.line = this.lines.add({ positions, width: 2, material: lineMaterial(drawn.data.phase) });
        trail.phase = drawn.data.phase;
      } else {
        trail.line.positions = positions;
        trail.line.show = true;
        if (trail.phase !== drawn.data.phase) {
          trail.line.material = lineMaterial(drawn.data.phase);
          trail.phase = drawn.data.phase;
        }
      }
    }
  }

  destroy(): void {
    this.trails.clear();
    this.scene.primitives.remove(this.lines);
  }

  /**
   * The surface under each point that is on the ground. The median of a few points in a row is used, so that one
   * beside a building does not go up on the roof. Where nothing is known (no tiles there, or not looked up yet) it is
   * taken to be that of the nearest point before, or else after: airfields are flat, and the official elevation can
   * be many metres off.
   */
  private surfaceAlong(points: readonly TrailPoint[], renderTime: number, drawn: DrawnAircraft): number[] {
    const found = points.map(([t, lat, lon, heightM]) =>
      heightM !== null || t > renderTime ? undefined : this.ground?.backgroundHeightAt(lon, lat),
    );
    let nearest =
      found.find((height) => height !== undefined) ?? (drawn.onGround ? drawn.height : this.fallbackGround);
    return found.map((height, i) => {
      if (height === undefined) return nearest;
      const row = found.slice(Math.max(0, i - NEIGHBOURS), i + NEIGHBOURS + 1).filter((h) => h !== undefined);
      row.sort((a, b) => a - b);
      nearest = row[Math.floor((row.length - 1) / 2)] ?? height;
      return nearest;
    });
  }

  /** A point of a line that lies on the ground, as it is seen from where the camera is. */
  private onSurface(lon: number, lat: number, height: number): Cartesian3 {
    const point = Cartesian3.fromDegrees(lon, lat, height);
    const distance = Cartesian3.distance(point, this.scene.camera.positionWC);
    const up = Ellipsoid.WGS84.geodeticSurfaceNormal(point, scratchUp);
    if (!up) return point;
    Cartesian3.multiplyByScalar(up, GROUND_CLEARANCE_M + distance * CLEARANCE_PER_M, up);
    return Cartesian3.add(point, up, point);
  }
}

const scratchUp = new Cartesian3();

/**
 * A material for one line. Never share one between lines: removing a line from a PolylineCollection destroys
 * its material, and any other line still using it stops the whole scene with "This object was destroyed".
 * Lines that look the same are drawn together all the same; Cesium groups them by colour, not by object.
 */
function lineMaterial(phase: Phase): Material {
  return Material.fromType('Color', {
    color: Color.fromCssColorString(PHASE_COLORS[phase]).withAlpha(0.75),
  });
}
