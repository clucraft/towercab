import type { Aircraft, Phase, TrailPoint } from '@towercab/shared';
import { Cartesian3, Color, Material, type Polyline, PolylineCollection, type Scene } from 'cesium';
import type { AircraftLayer } from './aircraftLayer';
import type { GroundSampler } from './ground';
import { PHASE_COLORS } from './palette';

/** How much history a trail shows. */
export const TRAIL_MS = 180_000;
/** Ground points sit a little above the surface so the line is not buried in it. */
const GROUND_CLEARANCE_M = 0.4;
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
  private readonly materials = new Map<Phase, Material>();
  private ground: GroundSampler | null = null;
  private toSceneHeight: (ellipsoidM: number) => number = (h) => h;
  private fallbackGround = 0;
  private enabled = true;

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
    for (const [hex, trail] of this.trails) {
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
      for (const [t, lat, lon, heightM] of trail.points) {
        if (t > renderTime) break;
        const height =
          heightM === null
            ? (this.ground?.peek(lon, lat) ?? this.fallbackGround) + GROUND_CLEARANCE_M
            : this.toSceneHeight(heightM);
        positions.push(Cartesian3.fromDegrees(lon, lat, height));
      }
      if (drawn.visible) positions.push(Cartesian3.clone(drawn.position));

      if (positions.length < 2 || !drawn.visible) {
        if (trail.line) trail.line.show = false;
        continue;
      }
      if (!trail.line) {
        trail.line = this.lines.add({ positions, width: 2, material: this.material(drawn.data.phase) });
        trail.phase = drawn.data.phase;
      } else {
        trail.line.positions = positions;
        trail.line.show = true;
        if (trail.phase !== drawn.data.phase) {
          trail.line.material = this.material(drawn.data.phase);
          trail.phase = drawn.data.phase;
        }
      }
    }
  }

  destroy(): void {
    this.trails.clear();
    this.scene.primitives.remove(this.lines);
  }

  private material(phase: Phase): Material {
    let material = this.materials.get(phase);
    if (!material) {
      material = Material.fromType('Color', {
        color: Color.fromCssColorString(PHASE_COLORS[phase]).withAlpha(0.75),
      });
      this.materials.set(phase, material);
    }
    return material;
  }
}
