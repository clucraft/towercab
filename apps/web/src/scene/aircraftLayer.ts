import {
  type Aircraft,
  type ModelClass,
  type ResolvedAircraftType,
  resolveAircraftType,
  type TrailPoint,
} from '@towercab/shared';
import {
  CallbackPositionProperty,
  CallbackProperty,
  Cartesian3,
  Math as CesiumMath,
  Color,
  ColorBlendMode,
  CustomDataSource,
  type Entity,
  HeadingPitchRoll,
  Quaternion,
  ShadowMode,
  Transforms,
  type Viewer,
} from 'cesium';
import type { GroundSampler } from './ground';
import {
  bankFromTurnRate,
  MotionBuffer,
  type MotionSample,
  type MotionState,
  pitchFromVerticalRate,
  turnTowards,
} from './motion';

/** What the rest of the scene (labels, trails, follow camera, selection) can read about a drawn aircraft. */
export interface DrawnAircraft {
  readonly hex: string;
  /** The latest data from the server. */
  readonly data: Aircraft;
  readonly type: ResolvedAircraftType;
  /** Where it is drawn right now, in world coordinates. Mutated in place every frame. */
  readonly position: Cartesian3;
  /** Position on the globe as drawn. */
  readonly lat: number;
  readonly lon: number;
  /** Scene height in metres. */
  readonly height: number;
  /** Compass heading as drawn, degrees. */
  readonly heading: number;
  readonly onGround: boolean;
  /** 0 to 1. Below 1 while fading in or out. */
  readonly alpha: number;
  readonly visible: boolean;
}

/**
 * The aircraft part of the scene. The interface is what the controller depends on; the implementation below
 * uses Cesium's Entity API and could be swapped for one built on primitives without touching anything else.
 */
export interface AircraftLayer {
  /** Replaces everything with a snapshot from the server. Trails seed the motion so aircraft move at once. */
  reset(aircraft: readonly Aircraft[], trails: Record<string, TrailPoint[]>): void;
  upsert(aircraft: Aircraft): void;
  remove(hex: string): void;
  /** Advances every aircraft to `renderTime` (server clock, ms). Called once per frame. */
  update(renderTime: number, frameSeconds: number): void;
  setGround(
    ground: GroundSampler,
    toSceneHeight: (ellipsoidM: number) => number,
    fallbackGroundHeight: number,
  ): void;
  setSelected(hex: string | null): void;
  get(hex: string): DrawnAircraft | undefined;
  list(): Iterable<DrawnAircraft>;
  readonly count: number;
  /** The hex of the aircraft a picked Cesium object belongs to, if any. */
  hexOfPicked(picked: unknown): string | null;
  /** Objects to leave out when sampling the surface, so an aircraft never lands on another aircraft. */
  sampleExclusions(): object[];
  destroy(): void;
}

export const modelUrl = (modelClass: ModelClass): string => `/models/${modelClass}.glb`;

/** How quickly the drawn height follows the target height. A short lag hides steps in sampled terrain. */
const HEIGHT_FOLLOW_S = 0.25;
const ATTITUDE_FOLLOW_S = 0.6;
/** Fastest the nose is turned, degrees per second: taxiing aircraft pivot quickly, flying ones do not. */
const MAX_TURN_GROUND = 70;
const MAX_TURN_AIR = 30;
/**
 * An aircraft that is airborne at both ends of an interval only needs the surface for the "never below
 * ground" clamp. That matters close to the ground only, so higher up the lookup is skipped.
 */
const SURFACE_LOOKUP_BELOW_M = 25;
const REMOVE_FADE_MS = 500;
const SELECTED_OUTLINE = Color.fromCssColorString('#3fd0ff');

interface Record_ extends DrawnAircraft {
  data: Aircraft;
  type: ResolvedAircraftType;
  buffer: MotionBuffer;
  entity: Entity;
  orientation: Quaternion;
  color: Color;
  lat: number;
  lon: number;
  height: number;
  heading: number;
  pitch: number;
  bank: number;
  turnRate: number;
  onGround: boolean;
  alpha: number;
  visible: boolean;
  placed: boolean;
  /** The surface height last found under this aircraft, used while the next one is being looked up. */
  lastSurface: number | null;
  selected: boolean;
  /** Set when the server says the aircraft is gone; it fades out and is then dropped. */
  removedAt: number | null;
}

function toSample(a: Aircraft): MotionSample {
  return {
    t: a.posTime,
    lat: a.lat,
    lon: a.lon,
    heightM: a.onGround ? null : (a.heightM ?? null),
    onGround: a.onGround,
    headingDeg: a.headingDeg ?? null,
    trackDeg: a.trackDeg ?? a.headingDeg ?? null,
    gsKt: a.gsKt ?? null,
    vertRateFpm: a.vertRateFpm ?? null,
  };
}

export class EntityAircraftLayer implements AircraftLayer {
  private readonly records = new Map<string, Record_>();
  private readonly source = new CustomDataSource('aircraft');
  private readonly hpr = new HeadingPitchRoll();
  private ground: GroundSampler | null = null;
  private toSceneHeight: (ellipsoidM: number) => number = (h) => h;
  private fallbackGround = 0;
  private selectedHex: string | null = null;
  private exclusions: object[] | null = null;
  /** The aircraft in a fixed order for the frame loop; rebuilt when one is added or removed. */
  private order: Record_[] | null = null;
  private turn = 0;
  private lastRenderTime = 0;

  constructor(private readonly viewer: Viewer) {
    void viewer.dataSources.add(this.source);
  }

  get count(): number {
    return this.records.size;
  }

  setGround(
    ground: GroundSampler,
    toSceneHeight: (ellipsoidM: number) => number,
    fallbackGroundHeight: number,
  ): void {
    this.ground = ground;
    this.toSceneHeight = toSceneHeight;
    this.fallbackGround = fallbackGroundHeight;
    // Heights mean something else now; drop the smoothing state so nothing glides between the two.
    for (const record of this.records.values()) {
      record.placed = false;
      record.lastSurface = null;
    }
  }

  reset(aircraft: readonly Aircraft[], trails: Record<string, TrailPoint[]>): void {
    const keep = new Set(aircraft.map((a) => a.hex));
    for (const hex of [...this.records.keys()]) if (!keep.has(hex)) this.drop(hex);
    for (const a of aircraft) {
      const existing = this.records.get(a.hex);
      if (existing) {
        this.upsert(a);
        continue;
      }
      const record = this.create(a);
      // Recent trail points become motion samples, so the aircraft is already moving on the first frame.
      const trail = (trails[a.hex] ?? []).filter((p) => p[0] < a.posTime).slice(-6);
      trail.forEach((point, i) => {
        const next = trail[i + 1] ?? [a.posTime, a.lat, a.lon, a.heightM ?? null];
        const seconds = (next[0] - point[0]) / 1000;
        const north = (next[1] - point[1]) * 111_320;
        const east = (next[2] - point[2]) * 111_320 * Math.cos((point[1] * Math.PI) / 180);
        const distance = Math.hypot(east, north);
        const moving = distance > 3 && seconds > 0;
        const track = moving ? ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360 : null;
        record.buffer.push({
          t: point[0],
          lat: point[1],
          lon: point[2],
          heightM: point[3],
          onGround: point[3] === null,
          headingDeg: track ?? a.headingDeg ?? null,
          trackDeg: track,
          gsKt: moving ? distance / seconds / 0.514444 : 0,
          vertRateFpm: null,
        });
      });
      record.buffer.push(toSample(a));
      record.buffer.settle();
    }
  }

  upsert(aircraft: Aircraft): void {
    let record = this.records.get(aircraft.hex);
    if (!record) {
      record = this.create(aircraft);
      record.buffer.push(toSample(aircraft));
      return;
    }
    const typeChanged =
      record.data.typeCode !== aircraft.typeCode || record.data.category !== aircraft.category;
    record.data = aircraft;
    record.removedAt = null;
    record.buffer.push(toSample(aircraft));
    if (typeChanged) {
      // The type arrived after the position (sources differ in what they know): swap to the right model.
      const type = resolveAircraftType(aircraft.typeCode, aircraft.category);
      if (type.class !== record.type.class || type.wingspanM !== record.type.wingspanM) {
        record.type = type;
        const model = record.entity.model;
        if (model) {
          model.uri = modelUrl(type.class) as never;
          model.scale = type.wingspanM as never;
        }
      }
    }
  }

  remove(hex: string): void {
    const record = this.records.get(hex);
    if (record && record.removedAt === null) record.removedAt = this.lastRenderTime;
  }

  setSelected(hex: string | null): void {
    if (this.selectedHex) {
      const previous = this.records.get(this.selectedHex);
      if (previous) previous.selected = false;
    }
    this.selectedHex = hex;
    const record = hex ? this.records.get(hex) : undefined;
    if (record) record.selected = true;
  }

  get(hex: string): DrawnAircraft | undefined {
    return this.records.get(hex);
  }

  list(): Iterable<DrawnAircraft> {
    return this.records.values();
  }

  hexOfPicked(picked: unknown): string | null {
    const id = (picked as { id?: { id?: unknown } } | undefined)?.id?.id;
    return typeof id === 'string' && id.startsWith('ac:') ? id.slice(3) : null;
  }

  sampleExclusions(): object[] {
    this.exclusions ??= [...this.records.values()].map((r) => r.entity);
    return this.exclusions;
  }

  update(renderTime: number, frameSeconds: number): void {
    this.lastRenderTime = renderTime;
    const dt = Math.min(Math.max(frameSeconds, 0.001), 0.25);
    // Surface lookups are rationed per frame. Starting each frame at a different aircraft shares them
    // out; always starting with the same one would leave the aircraft at the end of the list waiting.
    this.order ??= [...this.records.values()];
    const order = this.order;
    const count = order.length;
    this.turn = count > 0 ? (this.turn + 7) % count : 0;
    for (let i = 0; i < count; i += 1) {
      const record = order[(this.turn + i) % count] as Record_;
      const state = record.buffer.sample(renderTime);
      if (!state) {
        if (record.visible) {
          record.visible = false;
          record.entity.show = false;
        }
        continue;
      }
      this.place(record, state, dt);

      let alpha = state.alpha;
      if (record.removedAt !== null) {
        alpha *= Math.max(0, 1 - (renderTime - record.removedAt) / REMOVE_FADE_MS);
        if (alpha <= 0) {
          this.drop(record.hex);
          continue;
        }
      }
      record.alpha = alpha;
      const visible = alpha > 0.02;
      if (visible !== record.visible) {
        record.visible = visible;
        record.entity.show = visible;
      }
      // Fully opaque models stay in the fast opaque pass; only fading ones are blended. A new Color object
      // is handed over on each change so that Cesium sees the change.
      const wanted = alpha >= 0.99 ? 1 : Math.round(alpha * 50) / 50;
      if (wanted !== record.color.alpha) record.color = new Color(1, 1, 1, wanted);
    }
  }

  destroy(): void {
    this.records.clear();
    this.viewer.dataSources.remove(this.source, true);
  }

  private place(record: Record_, state: MotionState, dt: number): void {
    record.lat = state.lat;
    record.lon = state.lon;
    record.onGround = state.onGround;

    // Height. An endpoint that is on the ground takes the surface height; the two are blended across the
    // interval, which is what lowers an aircraft onto the runway as it lands and lifts it off on take-off.
    const fromAir = state.from.heightM === null ? null : this.toSceneHeight(state.from.heightM);
    const toAir = state.to.heightM === null ? null : this.toSceneHeight(state.to.heightM);
    const nearSurface =
      fromAir === null ||
      toAir === null ||
      Math.min(fromAir, toAir) < this.fallbackGround + SURFACE_LOOKUP_BELOW_M;
    let target: number;
    if (nearSurface) {
      // Where the surface is not known yet, the aircraft keeps the height it last stood on rather
      // than jumping to the field elevation, which can be many metres off at a large airport.
      const found = this.ground?.heightAt(state.lon, state.lat);
      if (found !== undefined) record.lastSurface = found;
      const surface = found ?? record.lastSurface ?? this.fallbackGround;
      const a = fromAir ?? surface;
      const b = toAir ?? surface;
      // Never below the surface, whatever the reported altitude says.
      target = Math.max(surface, a + (b - a) * state.u + state.extraHeightM);
    } else {
      target = (fromAir as number) + ((toAir as number) - (fromAir as number)) * state.u + state.extraHeightM;
    }

    // Attitude targets.
    const targetHeading = state.headingDeg ?? record.heading;
    const targetPitch = pitchFromVerticalRate(state.vertRateFpm, state.speedMps, state.onGround);

    if (!record.placed) {
      record.placed = true;
      record.height = target;
      record.heading = targetHeading;
      record.pitch = targetPitch;
      record.bank = 0;
      record.turnRate = 0;
    } else {
      record.height += (target - record.height) * (1 - Math.exp(-dt / HEIGHT_FOLLOW_S));
      const before = record.heading;
      record.heading = turnTowards(
        before,
        targetHeading,
        (state.onGround ? MAX_TURN_GROUND : MAX_TURN_AIR) * dt,
      );
      const turned = ((((record.heading - before) % 360) + 540) % 360) - 180;
      const follow = 1 - Math.exp(-dt / ATTITUDE_FOLLOW_S);
      record.turnRate += (turned / dt - record.turnRate) * follow;
      record.bank +=
        (bankFromTurnRate(record.turnRate, state.speedMps, state.onGround) - record.bank) * follow;
      record.pitch += (targetPitch - record.pitch) * follow;
    }

    Cartesian3.fromDegrees(record.lon, record.lat, record.height, undefined, record.position);
    // The models point their nose along +X in Cesium's local frame, which is east at heading zero.
    this.hpr.heading = CesiumMath.toRadians(record.heading - 90);
    this.hpr.pitch = CesiumMath.toRadians(record.pitch);
    this.hpr.roll = CesiumMath.toRadians(record.bank);
    Transforms.headingPitchRollQuaternion(
      record.position,
      this.hpr,
      undefined,
      undefined,
      record.orientation,
    );
  }

  private create(aircraft: Aircraft): Record_ {
    const type = resolveAircraftType(aircraft.typeCode, aircraft.category);
    const record = {
      hex: aircraft.hex,
      data: aircraft,
      type,
      buffer: new MotionBuffer(),
      position: new Cartesian3(),
      orientation: new Quaternion(0, 0, 0, 1),
      color: Color.WHITE.clone(),
      lat: aircraft.lat,
      lon: aircraft.lon,
      height: 0,
      heading: aircraft.headingDeg ?? aircraft.trackDeg ?? 0,
      pitch: 0,
      bank: 0,
      turnRate: 0,
      onGround: aircraft.onGround,
      alpha: 0,
      visible: false,
      placed: false,
      lastSurface: null,
      selected: aircraft.hex === this.selectedHex,
      removedAt: null,
    } as Record_;

    record.entity = this.source.entities.add({
      id: `ac:${aircraft.hex}`,
      show: false,
      position: new CallbackPositionProperty(() => record.position, false),
      orientation: new CallbackProperty(() => record.orientation, false),
      model: {
        uri: modelUrl(type.class),
        // The models are one wingspan wide, so this draws the aircraft at its real size.
        scale: type.wingspanM,
        minimumPixelSize: 0,
        shadows: ShadowMode.DISABLED,
        color: new CallbackProperty(() => record.color, false),
        colorBlendMode: ColorBlendMode.MIX,
        colorBlendAmount: 0,
        silhouetteColor: SELECTED_OUTLINE,
        silhouetteSize: new CallbackProperty(() => (record.selected ? 2.5 : 0), false),
        // Cesium would otherwise compute an environment map per model from the sky, and redo it as each
        // one moves. With 150 aircraft that costs more than everything else in the frame together.
        environmentMapOptions: { enabled: false },
      },
    });
    this.records.set(aircraft.hex, record);
    this.exclusions = null;
    this.order = null;
    return record;
  }

  private drop(hex: string): void {
    const record = this.records.get(hex);
    if (!record) return;
    this.source.entities.remove(record.entity);
    this.records.delete(hex);
    this.exclusions = null;
    this.order = null;
    if (this.selectedHex === hex) this.selectedHex = null;
  }
}
