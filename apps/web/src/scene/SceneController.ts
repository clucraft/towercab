import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Aircraft, AirportDetail, ClientConfig } from '@towercab/shared';
import {
  BoundingSphere,
  type Cartesian2,
  Cartesian3,
  Cartographic,
  type Cesium3DTileset,
  Math as CesiumMath,
  Color,
  createGooglePhotorealistic3DTileset,
  createWorldTerrainAsync,
  DirectionalLight,
  EllipsoidTerrainProvider,
  HeadingPitchRange,
  Ion,
  Matrix4,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  sampleTerrainMostDetailed,
  type TerrainProvider,
  Transforms,
  Viewer,
} from 'cesium';
import type { LiveStore } from '../live/store';
import { type AircraftLayer, type DrawnAircraft, EntityAircraftLayer } from './aircraftLayer';
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

    this.input = new ScreenSpaceEventHandler(scene.canvas);
    this.input.setInputAction(
      (event: { position: Cartesian2 }) => this.onClick(event.position),
      ScreenSpaceEventType.LEFT_CLICK,
    );
    this.input.setInputAction((event: { endPosition: Cartesian2 }) => {
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
    // Flat Schematic measures heights from the field; the others from the ellipsoid. Move the camera by the
    // difference so the view does not jump when switching.
    const shift = previousOffset - this.heightOffset;
    if (shift !== 0 && !flags.silent) this.shiftCamera(shift);
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
    const renderTime = store.serverNow() - config.renderDelayMs;
    this.layer.update(renderTime, elapsed / 1000);
    if (this.followHex) this.updateFollow();
    if (now - this.lastTrailAt >= TRAIL_UPDATE_MS) {
      this.lastTrailAt = now;
      this.trails.update(renderTime, this.layer);
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
    this.select(this.layer.hexOfPicked(picked));
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

function describe(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

/** Aircraft currently known to a store, for callers that only need the data. */
export function listAircraft(store: LiveStore): Aircraft[] {
  return [...store.aircraft.values()];
}
