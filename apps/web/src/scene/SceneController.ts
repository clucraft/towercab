import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Aircraft, AirportDetail, CameraPose, ClientConfig, PublicCamera } from '@towercab/shared';
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  type Cesium3DTileset,
  Math as CesiumMath,
  Color,
  CustomDataSource,
  createGooglePhotorealistic3DTileset,
  createWorldTerrainAsync,
  DirectionalLight,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  Ion,
  JulianDate,
  LabelStyle,
  Matrix4,
  PerspectiveFrustum,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  sampleTerrainMostDetailed,
  type TerrainProvider,
  Transforms,
  Viewer,
} from 'cesium';
import type { LiveStore } from '../live/store';
import { type AircraftLayer, type DrawnAircraft, EntityAircraftLayer } from './aircraftLayer';
import { CameraConeLayer } from './cameraCones';
import { angleDiffDeg, bearingDeg, DEFAULT_ASPECT, sceneFovRad } from './cameraPose';
import { FlatGround, type GroundSampler, ProbedGround, SampledGround } from './ground';
import { LabelOverlay } from './labelOverlay';
import { LayoutLayer } from './layoutLayer';
import { SCHEMATIC } from './palette';
import { TrailLayer } from './trails';
import { buildViewPresets, resolveView, type ViewPreset } from './views';

export type SceneMode = 'photoreal' | 'schematic';

export interface SceneCallbacks {
  onSelect?(hex: string | null): void;
  /** The mode changed, either because it was asked for or because Photoreal failed. */
  onMode?(mode: SceneMode): void;
  onView?(viewId: string): void;
  /** A short message for the user, such as the reason for falling back to Schematic. */
  onNotice?(text: string): void;
  /** A camera's view cone was clicked. */
  onCameraPick?(id: string): void;
}

export interface SceneOptions {
  container: HTMLElement;
  airport: AirportDetail;
  config: ClientConfig;
  store: LiveStore;
  mode: SceneMode;
  view: string | null;
  callbacks?: SceneCallbacks;
}

export interface SceneStats {
  fps: number;
  frameMs: number;
  /** Time our own code takes per frame (moving aircraft, trails, labels), milliseconds. */
  scriptMs: number;
  aircraft: number;
  mode: SceneMode;
}

/**
 * Give up on Photoreal when the first tiles have not arrived after this much rendering time. Time during
 * which the page is not being drawn (a background tab) does not count: no tiles are loaded then either.
 */
const TILES_TIMEOUT_MS = 25_000;
/** ...or when this many tiles have failed within the window below. */
const TILE_FAILURES_LIMIT = 12;
const TILE_FAILURE_WINDOW_MS = 20_000;
const TRAIL_UPDATE_MS = 200;
/**
 * A sampled surface height further than this from the field elevation is not believed. Far from the camera
 * only coarse tiles are loaded, and those can be hundreds of metres out.
 */
const SURFACE_SANITY_M = 120;
const FLY_SECONDS = 1.2;
/** How often view cones are rebuilt while a camera's ground height is still being looked up. */
const CONE_RETRY_MS = 1500;
/** Distance from a camera at which its pose handles are drawn in the pose editor, metres. */
const HANDLE_RANGE_M = 260;

/** What the 3D view is doing when it looks through a camera. */
interface Matched {
  id: string;
  /** Drawn over the camera's picture: the view is locked and sized to the picture. */
  overlay: boolean;
  /** Shape of the camera's picture, when known. */
  aspect: number | null;
}

/** A pose being edited in the admin page. */
export interface PoseEdit {
  pose: CameraPose;
  onChange(pose: CameraPose): void;
}

/**
 * Cesium fetches the Google tileset through one shared resource and refuses a second request while the
 * first is in flight, so requests are made one after another even when two scenes start at once.
 */
let tilesetRequests: Promise<unknown> = Promise.resolve();

/**
 * Owns the Cesium viewer and everything drawn in it. React talks to the scene only through this class; no
 * Cesium object leaves it.
 */
export class SceneController {
  readonly presets: ViewPreset[];

  private readonly viewer: Viewer;
  private readonly layer: AircraftLayer;
  private readonly trails: TrailLayer;
  private readonly labels: LabelOverlay;
  private readonly layout: LayoutLayer;
  private readonly cones: CameraConeLayer;
  private readonly handles = new CustomDataSource('pose-handles');
  private readonly input: ScreenSpaceEventHandler;
  private readonly callbacks: SceneCallbacks;
  private readonly unlisten: () => void;
  private readonly resizeObserver: ResizeObserver;

  private airport: AirportDetail;
  private currentMode: SceneMode = 'schematic';
  private currentView = 'overhead';
  private tileset: Cesium3DTileset | null = null;
  private terrain: TerrainProvider | null = null;
  private ground: GroundSampler = new FlatGround();
  /** Subtracted from ellipsoid heights to get scene heights. Non-zero only on the flat plane. */
  private heightOffset = 0;
  private selectedHex: string | null = null;
  private followHex: string | null = null;
  private followStarted = false;
  private followLastHeading = 0;
  private lastFrameAt = performance.now();
  private lastTrailAt = 0;
  private frameTimes: number[] = [];
  private scriptTimes: number[] = [];
  private scriptThisFrame = 0;
  private tileFailures: number[] = [];
  /** Rendering time spent waiting for the first tiles, or null when not waiting. */
  private tilesWaitMs: number | null = null;
  private destroyed = false;
  private modeToken = 0;
  private cameras: PublicCamera[] = [];
  private matched: Matched | null = null;
  private defaultFov = CesiumMath.toRadians(60);
  private lastConeCheckAt = 0;
  private poseEdit: PoseEdit | null = null;
  private dragging: 'aim' | 'fov' | null = null;

  private constructor(private readonly options: SceneOptions) {
    const { container, airport, config } = options;
    this.airport = airport;
    this.callbacks = options.callbacks ?? {};
    this.presets = buildViewPresets(airport);
    if (config.cesiumIonToken) Ion.defaultAccessToken = config.cesiumIonToken;

    this.viewer = new Viewer(container, {
      animation: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      navigationHelpButton: false,
      // No default imagery: it would need an ion token, and Schematic has to work without one.
      baseLayer: false,
      scene3DOnly: true,
      shadows: false,
      msaaSamples: 4,
      // Render at CSS resolution: a 4K laptop screen would otherwise cost four times the fill rate.
      useBrowserRecommendedResolution: true,
    });
    const { scene } = this.viewer;
    scene.globe.baseColor = Color.fromCssColorString(SCHEMATIC.ground);
    scene.globe.depthTestAgainstTerrain = true;
    scene.fog.enabled = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.screenSpaceCameraController.minimumZoomDistance = 4;
    scene.screenSpaceCameraController.maximumZoomDistance = 120_000;
    // A fixed light from high in the south-west, so aircraft look the same at any hour.
    const frame = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(airport.lon, airport.lat, 0));
    const direction = Matrix4.multiplyByPointAsVector(
      frame,
      new Cartesian3(0.35, 0.3, -0.89),
      new Cartesian3(),
    );
    scene.light = new DirectionalLight({
      direction: Cartesian3.normalize(direction, direction),
      intensity: 2.6,
    });

    this.layout = new LayoutLayer(this.viewer, () => this.terrain === null);
    this.layer = new EntityAircraftLayer(this.viewer);
    this.trails = new TrailLayer(scene);
    this.labels = new LabelOverlay(scene, container);
    this.cones = new CameraConeLayer(
      this.viewer,
      (lon, lat) => this.ground.heightAt(lon, lat),
      () => this.fieldSceneHeight(),
    );
    void this.viewer.dataSources.add(this.handles);
    const frustum = this.viewer.camera.frustum;
    if (frustum instanceof PerspectiveFrustum && frustum.fov) this.defaultFov = frustum.fov;

    this.input = new ScreenSpaceEventHandler(scene.canvas);
    this.input.setInputAction(
      (event: { position: Cartesian2 }) => this.onClick(event.position),
      ScreenSpaceEventType.LEFT_CLICK,
    );
    this.input.setInputAction(
      (event: { position: Cartesian2 }) => this.onPointerDown(event.position),
      ScreenSpaceEventType.LEFT_DOWN,
    );
    this.input.setInputAction(() => this.onPointerUp(), ScreenSpaceEventType.LEFT_UP);
    this.input.setInputAction((event: { endPosition: Cartesian2 }) => {
      if (this.dragging) {
        this.onHandleDrag(event.endPosition);
        return;
      }
      const hex = this.labels.hitTest(event.endPosition.x, event.endPosition.y);
      this.labels.setHover(hex);
      scene.canvas.style.cursor = hex ? 'pointer' : '';
    }, ScreenSpaceEventType.MOUSE_MOVE);

    scene.preUpdate.addEventListener(this.onFrame);
    scene.postRender.addEventListener(this.onRendered);

    this.unlisten = options.store.listen({
      onSnapshot: (message) => {
        this.layer.reset(message.aircraft, message.trails);
        this.trails.reset(message.aircraft, message.trails);
      },
      onDelta: (message) => {
        for (const aircraft of message.upserts) {
          this.layer.upsert(aircraft);
          this.trails.append(aircraft);
        }
        for (const hex of message.removed) {
          this.layer.remove(hex);
          if (hex === this.selectedHex) this.select(null);
        }
      },
    });
    // Anything that arrived before the scene existed.
    const existing = [...options.store.aircraft.values()];
    if (existing.length > 0) {
      this.layer.reset(existing, options.store.trails);
      this.trails.reset(existing, options.store.trails);
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.viewer.resize();
      this.applyFov();
      scene.requestRender();
    });
    this.resizeObserver.observe(container);
  }

  /** Builds the scene and brings it to the requested mode and view. */
  static async create(options: SceneOptions): Promise<SceneController> {
    const controller = new SceneController(options);
    await controller.prepareTerrain();
    controller.layout.load(options.airport);
    await controller.setMode(options.mode, { silent: true });
    controller.setView(resolveView(controller.presets, options.view).id, { animate: false });
    return controller;
  }

  get mode(): SceneMode {
    return this.currentMode;
  }

  get view(): string {
    return this.currentView;
  }

  get photorealAvailable(): boolean {
    return this.options.config.features.photoreal;
  }

  /** Switches the base map. Falls back to Schematic by itself when Photoreal cannot be shown. */
  async setMode(mode: SceneMode, flags: { silent?: boolean } = {}): Promise<void> {
    if (this.destroyed) return;
    const token = ++this.modeToken;
    if (mode === 'photoreal') {
      if (!this.photorealAvailable) {
        this.callbacks.onNotice?.(
          'Photoreal needs a Cesium ion token or a Google Maps key. Showing Schematic.',
        );
        mode = 'schematic';
      } else {
        try {
          await this.ensureTileset();
        } catch (err) {
          if (token !== this.modeToken) return;
          this.callbacks.onNotice?.(`Photoreal is not available (${describe(err)}). Showing Schematic.`);
          mode = 'schematic';
        }
      }
    }
    if (token !== this.modeToken || this.destroyed) return;

    const previousOffset = this.heightOffset;
    const { scene } = this.viewer;
    this.currentMode = mode;
    const photoreal = mode === 'photoreal';
    if (this.tileset) this.tileset.show = photoreal;
    scene.globe.show = !photoreal;
    this.layout.show = !photoreal;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = photoreal;
    if (scene.skyBox) scene.skyBox.show = photoreal;
    scene.globe.showGroundAtmosphere = false;
    scene.backgroundColor = Color.fromCssColorString(SCHEMATIC.sky);

    this.applyGround();
    this.cones.rebuild();
    // Flat Schematic measures heights from the field; the others from the ellipsoid. Move the camera by the
    // difference so the view does not jump when switching.
    const shift = previousOffset - this.heightOffset;
    if (shift !== 0 && !flags.silent) this.shiftCamera(shift);
    // A view through a camera is placed by that camera's pose, whatever the base map.
    if (this.matched) this.placeAtCamera(this.matched.id, false);
    scene.requestRender();
    this.callbacks.onMode?.(mode);
  }

  /** Moves the camera to a preset. */
  setView(id: string, flags: { animate?: boolean } = {}): void {
    const preset = this.presets.find((p) => p.id === id);
    if (!preset || this.destroyed) return;
    const duration = flags.animate === false ? 0 : FLY_SECONDS;
    const camera = this.viewer.camera;

    if (preset.kind === 'follow') {
      const hex = this.selectedHex;
      if (!hex || !this.layer.get(hex)) {
        this.callbacks.onNotice?.('Select an aircraft to follow.');
        return;
      }
      this.clearMatch();
      this.followHex = hex;
      this.followStarted = false;
      this.currentView = 'follow';
      this.callbacks.onView?.('follow');
      return;
    }
    if (!preset.available) {
      if (preset.note) this.callbacks.onNotice?.(preset.note);
      return;
    }

    this.followHex = null;
    this.clearMatch();
    camera.cancelFlight();
    camera.lookAtTransform(Matrix4.IDENTITY);
    const groundHeight = this.fieldSceneHeight();

    if (preset.kind === 'pose' && preset.pose) {
      const { lat, lon, heightAglM, headingDeg, pitchDeg } = preset.pose;
      camera.flyTo({
        destination: Cartesian3.fromDegrees(lon, lat, groundHeight + heightAglM),
        orientation: {
          heading: CesiumMath.toRadians(headingDeg),
          pitch: CesiumMath.toRadians(pitchDeg),
          roll: 0,
        },
        duration,
      });
    } else if (preset.target) {
      const { lat, lon, rangeM, headingDeg, pitchDeg } = preset.target;
      const centre = Cartesian3.fromDegrees(lon, lat, groundHeight);
      const offset = new HeadingPitchRange(
        CesiumMath.toRadians(headingDeg),
        CesiumMath.toRadians(pitchDeg),
        rangeM,
      );
      if (preset.kind === 'orbit') {
        // Leave the camera locked on the airport centre, so dragging orbits around it.
        camera.flyToBoundingSphere(new BoundingSphere(centre, 1), {
          offset,
          duration,
          complete: () => {
            if (this.currentView === 'orbit' && !this.destroyed) camera.lookAt(centre, offset);
          },
        });
      } else {
        camera.flyToBoundingSphere(new BoundingSphere(centre, 1), { offset, duration });
      }
    }
    this.currentView = preset.id;
    this.callbacks.onView?.(preset.id);
  }

  /** Selects an aircraft (or none). */
  select(hex: string | null): void {
    if (hex === this.selectedHex) return;
    this.selectedHex = hex;
    this.layer.setSelected(hex);
    this.labels.setSelected(hex);
    if (!hex && this.followHex) this.stopFollowing();
    this.viewer.scene.requestRender();
    this.callbacks.onSelect?.(hex);
  }

  /** Starts the chase camera behind an aircraft. */
  follow(hex: string): void {
    this.select(hex);
    this.setView('follow');
  }

  setTrails(enabled: boolean): void {
    this.trails.setEnabled(enabled);
    this.viewer.scene.requestRender();
  }

  setLabels(enabled: boolean): void {
    this.labels.setEnabled(enabled);
    this.viewer.scene.requestRender();
  }

  /** Reloads the layout, for when it arrives after the scene was built. */
  setAirport(airport: AirportDetail): void {
    this.airport = airport;
    this.layout.load(airport);
    this.viewer.scene.requestRender();
  }

  // ---- cameras -------------------------------------------------------------------------------------

  /** The airport's cameras. Those with a pose are drawn as view cones. */
  setCameras(cameras: readonly PublicCamera[]): void {
    this.cameras = [...cameras];
    this.cones.set(this.cameras.flatMap((c) => (c.pose ? [{ id: c.id, name: c.name, pose: c.pose }] : [])));
    if (this.matched && !this.cameras.some((c) => c.id === this.matched?.id && c.pose)) this.endMatch();
  }

  /** Marks the camera whose picture is on show. */
  setActiveCamera(id: string | null): void {
    this.cones.setActive(id);
  }

  setConesVisible(visible: boolean): void {
    this.cones.show = visible;
    this.viewer.scene.requestRender();
  }

  /** The camera the 3D view is looking through, if any. */
  get matchedCamera(): string | null {
    return this.matched?.id ?? null;
  }

  /**
   * Puts the 3D camera where a real camera is, pointing the same way with the same field of view. With
   * `overlay` the view is locked there and sized to the camera's picture (`aspect`), so that the scene
   * and its labels line up with the picture drawn over it. False when the camera has no pose.
   */
  matchCamera(
    id: string,
    options: { overlay?: boolean; aspect?: number | null; animate?: boolean } = {},
  ): boolean {
    const camera = this.cameras.find((c) => c.id === id);
    if (!camera?.pose || this.destroyed) return false;
    this.followHex = null;
    this.matched = { id, overlay: options.overlay ?? false, aspect: options.aspect ?? null };
    this.placeAtCamera(id, !this.matched.overlay && options.animate !== false);
    this.cones.setHidden(id);
    this.viewer.scene.screenSpaceCameraController.enableInputs = !this.matched.overlay;
    this.currentView = `cam:${id}`;
    this.callbacks.onView?.(this.currentView);
    return true;
  }

  /** Gives the 3D camera back: its usual field of view, and the mouse. */
  endMatch(): void {
    if (!this.matched) return;
    this.clearMatch();
    if (this.currentView.startsWith('cam:')) {
      this.currentView = 'free';
      this.callbacks.onView?.('free');
    }
  }

  private clearMatch(): void {
    if (!this.matched) return;
    this.matched = null;
    this.applyFov();
    this.cones.setHidden(null);
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
    this.viewer.scene.requestRender();
  }

  private placeAtCamera(id: string, animate: boolean): void {
    const pose = this.cameras.find((c) => c.id === id)?.pose;
    if (!pose) return;
    const camera = this.viewer.camera;
    camera.cancelFlight();
    camera.lookAtTransform(Matrix4.IDENTITY);
    this.applyFov();
    const view = {
      destination: this.cones.lensPosition(pose).position,
      orientation: {
        heading: CesiumMath.toRadians(pose.headingDeg),
        pitch: CesiumMath.toRadians(pose.pitchDeg),
        roll: 0,
      },
    };
    if (animate) camera.flyTo({ ...view, duration: FLY_SECONDS });
    else camera.setView(view);
    this.viewer.scene.requestRender();
  }

  /** The field of view for what the 3D camera is doing now: its own, or the matched camera's. */
  private applyFov(): void {
    const frustum = this.viewer.camera.frustum;
    if (!(frustum instanceof PerspectiveFrustum)) return;
    const pose = this.matched ? this.cameras.find((c) => c.id === this.matched?.id)?.pose : undefined;
    if (!this.matched || !pose) {
      frustum.fov = this.defaultFov;
      return;
    }
    const canvas = this.viewer.scene.canvas;
    frustum.fov = sceneFovRad(
      pose.hfovDeg,
      canvas.clientWidth,
      canvas.clientHeight,
      this.matched.overlay ? (this.matched.aspect ?? DEFAULT_ASPECT) : null,
    );
  }

  // ---- pose editor (admin page) ---------------------------------------------------------------------

  /**
   * Starts, updates or ends editing a camera pose in the scene. While editing, a click on the ground moves
   * the camera there, and two handles can be dragged: one turns the camera, the other widens or narrows
   * its field of view. Every change is reported; the caller passes the new pose back in.
   */
  editPose(edit: PoseEdit | null): void {
    this.poseEdit = edit;
    this.handles.entities.removeAll();
    if (!edit) {
      this.dragging = null;
      this.viewer.scene.screenSpaceCameraController.enableInputs = true;
      this.viewer.scene.requestRender();
      return;
    }
    const { pose } = edit;
    const at = (bearing: number) => destination(pose.lat, pose.lon, bearing, HANDLE_RANGE_M);
    const handle = (id: string, bearing: number, colour: string, text: string) => {
      const point = at(bearing);
      const surface = this.ground.heightAt(point.lon, point.lat) ?? this.fieldSceneHeight();
      this.handles.entities.add({
        id: `handle:${id}`,
        position: Cartesian3.fromDegrees(point.lon, point.lat, surface + 1),
        point: {
          pixelSize: 16,
          color: Color.fromCssColorString(colour),
          outlineColor: Color.BLACK,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text,
          font: '12px system-ui, sans-serif',
          fillColor: Color.WHITE,
          outlineColor: Color.BLACK,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(0, -18),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    };
    handle('aim', pose.headingDeg, '#fbbf24', 'direction');
    handle('fov', pose.headingDeg - pose.hfovDeg / 2, '#3fd0ff', 'field of view');
    this.viewer.scene.requestRender();
  }

  /** Where a camera's lens is on screen, in pixels from the scene's top left corner. For tests. */
  cameraLensAt(id: string): { x: number; y: number } | null {
    const pose = this.cameras.find((c) => c.id === id)?.pose;
    if (!pose) return null;
    const { position } = this.cones.lensPosition(pose);
    const at = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, position);
    return at ? { x: at.x, y: at.y } : null;
  }

  /** Where a pose handle is on screen, in pixels from the scene's top left corner. For tests. */
  poseHandleAt(which: 'aim' | 'fov'): { x: number; y: number } | null {
    const position = this.handles.entities.getById(`handle:${which}`)?.position?.getValue(JulianDate.now());
    const at = position ? SceneTransforms.worldToWindowCoordinates(this.viewer.scene, position) : undefined;
    return at ? { x: at.x, y: at.y } : null;
  }

  private onPointerDown(position: Cartesian2): void {
    if (!this.poseEdit) return;
    const id = (this.viewer.scene.pick(position) as { id?: { id?: unknown } } | undefined)?.id?.id;
    if (id !== 'handle:aim' && id !== 'handle:fov') return;
    this.dragging = id === 'handle:aim' ? 'aim' : 'fov';
    // The drag turns the camera pose, not the 3D view.
    this.viewer.scene.screenSpaceCameraController.enableInputs = false;
  }

  private onPointerUp(): void {
    if (!this.dragging) return;
    this.dragging = null;
    this.viewer.scene.screenSpaceCameraController.enableInputs = true;
  }

  private onHandleDrag(position: Cartesian2): void {
    const edit = this.poseEdit;
    const ground = this.groundAt(position);
    if (!edit || !ground) return;
    const { pose } = edit;
    const bearing = bearingDeg(pose.lat, pose.lon, ground.lat, ground.lon);
    if (this.dragging === 'aim') {
      edit.onChange({ ...pose, headingDeg: Math.round(bearing * 10) / 10 });
    } else {
      // The handle marks one edge of the picture, so the field of view is twice its angle off the axis.
      const half = Math.abs(angleDiffDeg(bearing, pose.headingDeg));
      edit.onChange({ ...pose, hfovDeg: Math.round(Math.min(170, Math.max(5, half * 2))) });
    }
  }

  /** The point on the ground under a screen position. */
  private groundAt(position: Cartesian2): { lat: number; lon: number } | null {
    const { scene, camera } = this.viewer;
    let point: Cartesian3 | undefined;
    if (this.currentMode === 'photoreal' && scene.pickPositionSupported) point = scene.pickPosition(position);
    if (!point) {
      const ray = camera.getPickRay(position);
      point = ray ? scene.globe.pick(ray, scene) : undefined;
    }
    point ??= camera.pickEllipsoid(position);
    if (!point) return null;
    const where = Cartographic.fromCartesian(point);
    return { lat: CesiumMath.toDegrees(where.latitude), lon: CesiumMath.toDegrees(where.longitude) };
  }

  stats(): SceneStats {
    const frames = this.frameTimes;
    const average = frames.length ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
    const scripts = this.scriptTimes;
    return {
      fps: average > 0 ? 1000 / average : 0,
      frameMs: average,
      scriptMs: scripts.length ? scripts.reduce((a, b) => a + b, 0) / scripts.length : 0,
      aircraft: this.layer.count,
      mode: this.currentMode,
    };
  }

  /** The aircraft as drawn, for tests and debugging. */
  drawn(hex: string): DrawnAircraft | undefined {
    return this.layer.get(hex);
  }

  /** Height of the surface under a point relative to the scene, when it is known. For tests. */
  surfaceHeightAt(lon: number, lat: number): number | undefined {
    return this.ground.heightAt(lon, lat);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.tilesWaitMs = null;
    // A scene can be discarded while parts of it are still loading; no step may stop the others.
    const steps: (() => void)[] = [
      () => this.unlisten(),
      () => this.resizeObserver.disconnect(),
      () => this.input.destroy(),
      () => this.viewer.scene.preUpdate.removeEventListener(this.onFrame),
      () => this.viewer.scene.postRender.removeEventListener(this.onRendered),
      () => this.ground.dispose(),
      () => this.labels.destroy(),
      () => this.trails.destroy(),
      () => this.layer.destroy(),
      () => this.cones.destroy(),
      () => this.layout.destroy(),
      () => this.viewer.destroy(),
    ];
    for (const step of steps) {
      try {
        step();
      } catch (err) {
        console.debug('TowerCab: scene tear-down step failed', err);
      }
    }
  }

  // ---- frame loop -----------------------------------------------------------------------------------

  private onFrame = (): void => {
    const now = performance.now();
    const elapsed = now - this.lastFrameAt;
    this.lastFrameAt = now;
    this.frameTimes.push(elapsed);
    if (this.frameTimes.length > 120) this.frameTimes.shift();

    if (this.tilesWaitMs !== null) {
      this.tilesWaitMs += Math.min(elapsed, 250);
      if (this.tilesWaitMs > TILES_TIMEOUT_MS) this.photorealFailed('the tiles did not load');
    }

    if (this.ground instanceof ProbedGround) this.ground.beginFrame();
    const { store, config } = this.options;
    const renderTime = store.serverNow() - (store.renderDelayMs() ?? config.renderDelayMs);
    this.layer.update(renderTime, elapsed / 1000);
    if (this.followHex) this.updateFollow();
    if (now - this.lastTrailAt >= TRAIL_UPDATE_MS) {
      this.lastTrailAt = now;
      this.trails.update(renderTime, this.layer);
    }
    // A camera's ground height may still have been on its way when its cone was drawn.
    if (this.cones.needsHeights && now - this.lastConeCheckAt >= CONE_RETRY_MS) {
      this.lastConeCheckAt = now;
      this.cones.rebuild();
      if (this.matched?.overlay) this.placeAtCamera(this.matched.id, false);
    }
    // With nothing moving there is nothing to redraw until the camera moves.
    this.viewer.scene.requestRenderMode = this.layer.count === 0;
    this.scriptThisFrame = performance.now() - now;
  };

  private onRendered = (): void => {
    const started = performance.now();
    this.labels.draw(this.layer);
    this.scriptTimes.push(this.scriptThisFrame + performance.now() - started);
    if (this.scriptTimes.length > 120) this.scriptTimes.shift();
  };

  private onClick(position: Cartesian2): void {
    const fromLabel = this.labels.hitTest(position.x, position.y);
    if (fromLabel) {
      this.select(fromLabel);
      return;
    }
    const picked = this.viewer.scene.pick(position);
    const hex = this.layer.hexOfPicked(picked);
    const camera = hex ? null : this.cones.idOfPicked(picked);
    if (this.poseEdit && !hex) {
      // In the pose editor a click on the ground puts the camera there.
      const ground = this.groundAt(position);
      if (ground) {
        const { pose } = this.poseEdit;
        this.poseEdit.onChange({
          ...pose,
          lat: Math.round(ground.lat * 1e6) / 1e6,
          lon: Math.round(ground.lon * 1e6) / 1e6,
        });
      }
      return;
    }
    if (camera) {
      this.callbacks.onCameraPick?.(camera);
      return;
    }
    this.select(hex);
  }

  // ---- follow camera --------------------------------------------------------------------------------

  private updateFollow(): void {
    const aircraft = this.followHex ? this.layer.get(this.followHex) : undefined;
    if (!aircraft?.visible) return;
    const camera = this.viewer.camera;
    const frame = Transforms.eastNorthUpToFixedFrame(aircraft.position);

    let heading: number;
    let pitch: number;
    let range: number;
    if (!this.followStarted) {
      this.followStarted = true;
      // Start behind and a little above, far enough back to see the whole aircraft.
      heading = CesiumMath.toRadians(aircraft.heading);
      pitch = CesiumMath.toRadians(-14);
      range = Math.max(60, Math.min(450, aircraft.type.wingspanM * 5.5));
    } else {
      // The user may have orbited or zoomed since the last frame: keep what they chose, and turn with
      // the aircraft so the camera stays where they put it relative to the nose.
      const turned = CesiumMath.toRadians(
        ((((aircraft.heading - this.followLastHeading) % 360) + 540) % 360) - 180,
      );
      heading = camera.heading + turned;
      pitch = camera.pitch;
      range = Math.max(8, Cartesian3.magnitude(camera.position));
    }
    this.followLastHeading = aircraft.heading;
    camera.lookAtTransform(frame, new HeadingPitchRange(heading, pitch, range));
  }

  private stopFollowing(): void {
    this.followHex = null;
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    if (this.currentView === 'follow') {
      this.currentView = 'free';
      this.callbacks.onView?.('free');
    }
  }

  // ---- base maps and ground -------------------------------------------------------------------------

  private async prepareTerrain(): Promise<void> {
    const { config } = this.options;
    if (!config.features.terrain) return;
    try {
      this.terrain = await createWorldTerrainAsync();
      if (!this.destroyed) this.viewer.scene.terrainProvider = this.terrain;
    } catch (err) {
      this.terrain = null;
      this.viewer.scene.terrainProvider = new EllipsoidTerrainProvider();
      this.callbacks.onNotice?.(`Terrain is not available (${describe(err)}). Using a flat surface.`);
    }
  }

  private async ensureTileset(): Promise<void> {
    if (this.tileset) return;
    const { config } = this.options;
    // A Google key talks to the Map Tiles API directly; otherwise the tiles come through Cesium ion.
    const request = tilesetRequests
      .catch(() => undefined)
      .then(() =>
        createGooglePhotorealistic3DTileset(
          { key: config.googleMapsApiKey ?? undefined, onlyUsingWithGoogleGeocoder: true },
          // Google's attribution must stay on screen at all times.
          // `enableCollision` keeps tile geometry available for height queries (and keeps the camera
          // from going under the surface).
          { showCreditsOnScreen: true, maximumScreenSpaceError: 16, enableCollision: true },
        ),
      );
    tilesetRequests = request;
    const tileset = await request;
    if (this.destroyed) {
      tileset.destroy();
      return;
    }
    this.tileset = this.viewer.scene.primitives.add(tileset) as Cesium3DTileset;

    this.tilesWaitMs = 0;
    tileset.initialTilesLoaded.addEventListener(() => {
      this.tilesWaitMs = null;
    });
    tileset.tileFailed.addEventListener((failure: { message?: string }) => {
      const now = performance.now();
      const text = String(failure?.message ?? '');
      // Refusals and quota errors will not get better by waiting.
      if (/\b(401|403|429)\b/.test(text)) {
        this.photorealFailed(
          /429/.test(text) ? 'the tile quota is used up' : 'the tile service refused the request',
        );
        return;
      }
      this.tileFailures = this.tileFailures.filter((t) => now - t < TILE_FAILURE_WINDOW_MS);
      this.tileFailures.push(now);
      if (this.tileFailures.length >= TILE_FAILURES_LIMIT)
        this.photorealFailed('too many tiles failed to load');
    });
  }

  private photorealFailed(reason: string): void {
    this.tilesWaitMs = null;
    if (this.destroyed || this.currentMode !== 'photoreal') return;
    this.tileFailures = [];
    this.callbacks.onNotice?.(`Photoreal stopped working: ${reason}. Showing Schematic.`);
    void this.setMode('schematic');
  }

  /** Picks the ground sampler and height reference that go with the current mode. */
  private applyGround(): void {
    this.ground.dispose();
    const { scene } = this.viewer;
    const fieldEllipsoid = this.airport.elevationEllipsoidM;

    if (this.currentMode === 'photoreal' && this.tileset) {
      const tileset = this.tileset;
      const scratch = new Cartographic();
      this.heightOffset = 0;
      // Read from the tiles that are loaded, which is what is on screen. This is cheap enough for every
      // aircraft on the ground, and an aircraft stands on the surface exactly as it is drawn. (Asking
      // Cesium for the most detailed tiles instead takes seconds per batch.)
      this.ground = new ProbedGround({
        probe: (lon, lat) => {
          const height = tileset.getHeight(Cartographic.fromDegrees(lon, lat, 0, scratch), scene);
          return height !== undefined && Math.abs(height - fieldEllipsoid) <= SURFACE_SANITY_M
            ? height
            : undefined;
        },
        // Photogrammetry has lumps where aircraft stood when it was captured.
        smooth: true,
      });
    } else if (this.terrain) {
      const terrain = this.terrain;
      this.heightOffset = 0;
      this.ground = new SampledGround({
        sampleBatch: async (points) => {
          const sampled = await sampleTerrainMostDetailed(
            terrain,
            points.map((p) => Cartographic.fromDegrees(p.lon, p.lat)),
          );
          return sampled.map((c) =>
            typeof c.height === 'number' && Math.abs(c.height - fieldEllipsoid) <= SURFACE_SANITY_M
              ? c.height
              : undefined,
          );
        },
      });
    } else {
      // No terrain: everything lies on a flat plane at field elevation.
      this.heightOffset = fieldEllipsoid;
      this.ground = new FlatGround();
    }
    const toScene = (ellipsoidM: number) => ellipsoidM - this.heightOffset;
    const fallback = fieldEllipsoid - this.heightOffset;
    this.layer.setGround(this.ground, toScene, fallback);
    this.trails.setGround(this.ground, toScene, fallback);
  }

  /** Scene height of the airfield itself. */
  private fieldSceneHeight(): number {
    return this.airport.elevationEllipsoidM - this.heightOffset;
  }

  private shiftCamera(deltaM: number): void {
    const camera = this.viewer.camera;
    if (this.followHex) return; // the chase camera repositions itself every frame
    const orbiting = this.currentView === 'orbit';
    camera.lookAtTransform(Matrix4.IDENTITY);
    const at = camera.positionCartographic;
    camera.setView({
      destination: Cartesian3.fromRadians(at.longitude, at.latitude, Math.max(2, at.height + deltaM)),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    });
    if (orbiting) this.setView('orbit', { animate: false });
  }
}

/** The point a distance away from another along a compass bearing, for the short distances used here. */
function destination(
  lat: number,
  lon: number,
  bearingDegrees: number,
  metres: number,
): { lat: number; lon: number } {
  const bearing = CesiumMath.toRadians(bearingDegrees);
  const north = (metres * Math.cos(bearing)) / 111_320;
  const east = (metres * Math.sin(bearing)) / (111_320 * Math.cos(CesiumMath.toRadians(lat)));
  return { lat: lat + north, lon: lon + east };
}

function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** Aircraft currently known to a store, for callers that only need the data. */
export function listAircraft(store: LiveStore): Aircraft[] {
  return [...store.aircraft.values()];
}
