/**
 * How much the 3D scene may cost on this device.
 *
 * Photoreal is the expensive part. Cesium's defaults for Google's tiles assume a desktop: a cache of 1.5 GB (and
 * another 1 GB on top), 4x antialiasing, 60 frames a second. A phone has neither the memory nor the processor for
 * that. So the scene starts from a profile that suits the device, and steps further down if it is still slow.
 */
export type Quality = 'high' | 'lite';

export const QUALITIES: readonly Quality[] = ['high', 'lite'];

/** What the browser says about the device. Everything is optional: browsers differ in what they tell. */
export interface DeviceHints {
  /** The main pointer is a finger. */
  coarsePointer?: boolean;
  /** Memory in GB, rounded by the browser. Chromium only. */
  memoryGb?: number;
  /** Processor threads. */
  cores?: number;
}

export interface QualityProfile {
  readonly quality: Quality;
  /** Samples per pixel for antialiasing. Every extra one costs memory bandwidth, which phones are short of. */
  readonly msaaSamples: number;
  /** Cesium's order-independent transparency: extra full-screen passes. Without it things are sorted instead. */
  readonly orderIndependentTranslucency: boolean;
  /** Frame rate limit in Photoreal, or undefined for the display's own. Saves a phone from overheating. */
  readonly photorealFrameRate: number | undefined;
  /** Tiles requested at once. Each one that arrives takes time on the main thread. */
  readonly maximumRequests: number;
  readonly tiles: {
    readonly cacheBytes: number;
    readonly maximumCacheOverflowBytes: number;
    readonly preloadFlightDestinations: boolean;
  };
  /**
   * From best to coarsest. `error` is Cesium's maximum screen-space error: the larger, the fewer tiles.
   * `resolution` scales the drawing buffer, 1 being one pixel per CSS pixel.
   */
  readonly steps: readonly { readonly error: number; readonly resolution: number }[];
  /** The step to start with. A better one, if there is one, is tried when the scene runs well at this one. */
  readonly start: number;
  /** Surface lookups: see `ProbedGroundOptions`. */
  readonly probes: { readonly perFrame: number; readonly share: number; readonly ttlMs: number };
}

const MB = 1024 * 1024;

export const PROFILES: Record<Quality, QualityProfile> = {
  high: {
    quality: 'high',
    msaaSamples: 4,
    orderIndependentTranslucency: true,
    photorealFrameRate: undefined,
    maximumRequests: 50,
    tiles: {
      cacheBytes: 512 * MB,
      maximumCacheOverflowBytes: 512 * MB,
      preloadFlightDestinations: true,
    },
    steps: [
      { error: 16, resolution: 1 },
      { error: 22, resolution: 1 },
      { error: 30, resolution: 1 },
    ],
    start: 0,
    probes: { perFrame: 6, share: 0.12, ttlMs: 20_000 },
  },
  lite: {
    quality: 'lite',
    msaaSamples: 1,
    orderIndependentTranslucency: false,
    // A little over 30, so that two ticks of a 60 Hz display always count as a frame.
    photorealFrameRate: 31,
    maximumRequests: 12,
    tiles: {
      cacheBytes: 160 * MB,
      maximumCacheOverflowBytes: 64 * MB,
      preloadFlightDestinations: false,
    },
    steps: [
      { error: 24, resolution: 1.5 },
      { error: 24, resolution: 1 },
      { error: 32, resolution: 1 },
      { error: 42, resolution: 0.85 },
      { error: 56, resolution: 0.7 },
    ],
    start: 1,
    probes: { perFrame: 2, share: 0.06, ttlMs: 60_000 },
  },
};

/** Picks a profile: what was asked for (`?quality=`), else one that suits the device. */
export function chooseQuality(hints: DeviceHints, wanted: string | null = null): Quality {
  if (wanted === 'high' || wanted === 'lite') return wanted;
  if (hints.coarsePointer) return 'lite';
  if (hints.memoryGb !== undefined && hints.memoryGb <= 4) return 'lite';
  if (hints.cores !== undefined && hints.cores <= 2) return 'lite';
  return 'high';
}

/** Reads the hints from the browser. */
export function readDeviceHints(): DeviceHints {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    memoryGb: nav.deviceMemory,
    cores: nav.hardwareConcurrency,
  };
}

/** Slower than this is slow: 22 frames a second. */
const SLOW_FRAME_MS = 45;
/** Quicker than this is good: about the frame rate limit in `PROFILES`. */
const GOOD_FRAME_MS = 36;
/** Frames longer than this are pauses (a background tab, a debugger), not slowness. */
const PAUSE_MS = 1000;
/** How long it has to stay slow before the next step, and how long a step gets to take effect. */
const SLOW_FOR_MS = 4000;
const SETTLE_MS = 5000;
/** How long it has to run well before the better step is tried. */
const GOOD_FOR_MS = 10_000;
/** On the last step and still slow for this long: say so. */
const GIVE_UP_MS = 10_000;

/**
 * Finds the tile detail a device can draw. It steps down while the scene is slow. A better step than the one it
 * starts with is tried once, when the scene has run well for a while; after any step down it never goes up
 * again, because detail that comes and goes is worse than detail that is a little too low. Switching the base
 * map starts over.
 */
export class DetailGovernor {
  private step: number;
  private slowMs = 0;
  private goodMs = 0;
  private sinceStepMs = 0;
  private given = false;
  private mayRise: boolean;

  constructor(
    private readonly steps: number,
    private readonly start = 0,
  ) {
    this.step = start;
    this.mayRise = start > 0;
  }

  /** The step in force, 0 being the best. */
  get current(): number {
    return this.step;
  }

  reset(): void {
    this.move(this.start);
    this.given = false;
    this.mayRise = this.start > 0;
  }

  /**
   * Call once per frame with how long it took, and whether tiles are still arriving: that makes frames slow for
   * a while on any device, and says less about what it can draw. Answers `step` when the detail should change
   * to `current`, `struggling` once when there is nothing left to give, and null otherwise.
   */
  frame(elapsedMs: number, loading = false): 'step' | 'struggling' | null {
    if (elapsedMs > PAUSE_MS) {
      this.slowMs = 0;
      this.goodMs = 0;
      return null;
    }
    this.sinceStepMs += elapsedMs;
    // Slow frames count up and quick ones count down, so a few of either change nothing.
    // A better step has to earn its keep: there, anything short of running well counts as slow.
    const slow = elapsedMs > (this.step < this.start ? GOOD_FRAME_MS : SLOW_FRAME_MS);
    this.slowMs = Math.max(0, this.slowMs + (slow ? elapsedMs * (loading ? 0.5 : 1) : -elapsedMs));
    this.goodMs = Math.max(0, this.goodMs + (elapsedMs <= GOOD_FRAME_MS ? elapsedMs : -4 * elapsedMs));
    const settled = this.sinceStepMs >= SETTLE_MS;
    const last = this.step >= this.steps - 1;

    if (!last && settled && this.slowMs >= SLOW_FOR_MS) {
      this.move(this.step + 1);
      this.mayRise = false;
      return 'step';
    }
    if (last && settled && !this.given && this.slowMs >= GIVE_UP_MS) {
      this.given = true;
      return 'struggling';
    }
    if (this.mayRise && !loading && this.goodMs >= GOOD_FOR_MS) {
      this.move(this.step - 1);
      this.mayRise = false;
      return 'step';
    }
    return null;
  }

  private move(step: number): void {
    this.step = step;
    this.slowMs = 0;
    this.goodMs = 0;
    this.sinceStepMs = 0;
  }
}
