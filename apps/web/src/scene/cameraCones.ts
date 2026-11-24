import type { CameraPose } from '@towercab/shared';
import {
  Cartesian2,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  CustomDataSource,
  type Entity,
  HeightReference,
  HorizontalOrigin,
  LabelStyle,
  Matrix4,
  PolygonHierarchy,
  Transforms,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import { CONE_RANGE_M, DEFAULT_ASPECT, type Enu, frustumCorners } from './cameraPose';

export interface ConeCamera {
  id: string;
  name: string;
  pose: CameraPose;
}

const CONE = Color.fromCssColorString('#3fd0ff');
const ACTIVE = Color.fromCssColorString('#fbbf24');

/**
 * The cameras that have a pose, in the scene: a marker where each one stands, which opens the camera when
 * clicked, and, while cameras are on show, a see-through view cone for where it points and how much it
 * takes in. Cones are left out the rest of the time; a handful of them would bury a small airfield.
 */
export class CameraConeLayer {
  private readonly source = new CustomDataSource('camera-cones');
  private cameras: ConeCamera[] = [];
  private active: string | null = null;
  /** The camera the 3D view is looking through; its own cone would only be in the way. */
  private hidden: string | null = null;
  private visible = true;
  private withCones = false;
  private readonly unknownHeights = new Set<string>();

  constructor(
    private readonly viewer: Viewer,
    /** Scene height of the surface at a point, when known. */
    private readonly surfaceAt: (lon: number, lat: number) => number | undefined,
    private readonly fallbackHeight: () => number,
  ) {
    void viewer.dataSources.add(this.source);
  }

  set show(value: boolean) {
    this.visible = value;
    this.source.show = value;
  }

  /** Draws the view cones as well as the markers. */
  set cones(value: boolean) {
    if (value === this.withCones) return;
    this.withCones = value;
    this.rebuild();
  }

  /** True while a camera's ground height was not known when its cone was built. */
  get needsHeights(): boolean {
    return this.unknownHeights.size > 0;
  }

  set(cameras: readonly ConeCamera[]): void {
    this.cameras = [...cameras];
    this.rebuild();
  }

  setActive(id: string | null): void {
    if (id === this.active) return;
    this.active = id;
    this.rebuild();
  }

  setHidden(id: string | null): void {
    if (id === this.hidden) return;
    this.hidden = id;
    this.rebuild();
  }

  /** Where a camera's lens is in the scene. */
  lensPosition(pose: CameraPose): { position: Cartesian3; known: boolean } {
    const surface = this.surfaceAt(pose.lon, pose.lat);
    const height = (surface ?? this.fallbackHeight()) + pose.heightM;
    return { position: Cartesian3.fromDegrees(pose.lon, pose.lat, height), known: surface !== undefined };
  }

  /** The id of the camera a picked Cesium object belongs to, if any. */
  idOfPicked(picked: unknown): string | null {
    const id = (picked as { id?: { id?: unknown } } | undefined)?.id?.id;
    return typeof id === 'string' && id.startsWith('cam:') ? (id.split(':')[1] ?? null) : null;
  }

  /** Builds the cones again: after the cameras, the base map or the known surface heights changed. */
  rebuild(): void {
    this.source.entities.removeAll();
    this.unknownHeights.clear();
    for (const camera of this.cameras) {
      if (camera.id === this.hidden) continue;
      const { position: lens, known } = this.lensPosition(camera.pose);
      if (!known) this.unknownHeights.add(camera.id);
      this.addCone(camera, lens);
    }
    this.source.show = this.visible;
    this.viewer.scene.requestRender();
  }

  private addCone(camera: ConeCamera, lens: Cartesian3): void {
    const colour = camera.id === this.active ? ACTIVE : CONE;
    const frame = Transforms.eastNorthUpToFixedFrame(lens);
    const toWorld = (offset: Enu) =>
      Matrix4.multiplyByPoint(frame, new Cartesian3(offset.east, offset.north, offset.up), new Cartesian3());
    const corners = frustumCorners(camera.pose, DEFAULT_ASPECT, CONE_RANGE_M).map(toWorld);
    const add = (suffix: string, options: Entity.ConstructorOptions) =>
      this.source.entities.add({ id: `cam:${camera.id}:${suffix}`, ...options });

    if (this.withCones) this.addFrustum(lens, corners, colour, add);
    add('lens', {
      position: lens,
      point: {
        pixelSize: 9,
        color: colour,
        outlineColor: Color.BLACK.withAlpha(0.7),
        outlineWidth: 1.5,
        heightReference: HeightReference.NONE,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      // The name goes with the cone: while cameras are closed a dot is enough, and stays out of the way.
      label: {
        show: this.withCones,
        text: new ConstantProperty(camera.name),
        font: '12px system-ui, sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.BLACK,
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(8, -6),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private addFrustum(
    lens: Cartesian3,
    corners: Cartesian3[],
    colour: Color,
    add: (suffix: string, options: Entity.ConstructorOptions) => Entity,
  ): void {
    // The four sides, barely there, so the scene stays readable through them.
    corners.forEach((corner, i) => {
      const next = corners[(i + 1) % corners.length] as Cartesian3;
      add(`side${i}`, {
        polygon: {
          hierarchy: new PolygonHierarchy([lens, corner, next]),
          perPositionHeight: true,
          material: new ColorMaterialProperty(colour.withAlpha(0.07)),
        },
      });
    });
    // The edges and the far frame say where the picture ends.
    add('edges', {
      polyline: {
        positions: [lens, corners[0], lens, corners[1], lens, corners[2], lens, corners[3]] as Cartesian3[],
        width: 1.5,
        material: colour.withAlpha(0.55),
      },
    });
    add('frame', {
      polyline: {
        positions: [...corners, corners[0]] as Cartesian3[],
        width: 1.5,
        material: colour.withAlpha(0.55),
      },
    });
  }

  destroy(): void {
    this.viewer.dataSources.remove(this.source, true);
  }
}
