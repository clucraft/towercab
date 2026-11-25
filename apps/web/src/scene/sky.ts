/**
 * What the sky and the light look like for a height of the sun. Plain arithmetic with no Cesium in it.
 *
 * Cesium can light its own sky by the sun, but its model only knows light that has been scattered once: with the sun
 * on the horizon it is brown and the stars are out, and half an hour later it is black. So the colours are picked
 * here, from pictures of clear evenings, and blended in between.
 */

/** 0 to 1, as displayed. */
export type Rgb = readonly [number, number, number];

export interface SkyLook {
  /** Straight up. */
  zenith: Rgb;
  /** Along the horizon, away from the sun. */
  horizon: Rgb;
  /** Along the horizon, below the sun. */
  sunward: Rgb;
  /** Added around the sun. */
  glow: Rgb;
  /** The sun itself. */
  disc: Rgb;
  /** 1 hides the stars; at night a little of them shows through. */
  opacity: number;
  /** What the brightness of the ground is multiplied by in Photoreal, where it is a picture taken by day. */
  ground: Rgb;
  /** How much of the ground's colour is lost. Eyes see little of it in the dark. */
  groundGrey: number;
  /** The light on the aircraft. */
  light: Rgb;
  lightIntensity: number;
}

interface Key extends SkyLook {
  /** Height of the sun, degrees. */
  at: number;
}

const hex = (code: string): Rgb => {
  const n = Number.parseInt(code.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/** From high noon to the dead of night. */
const KEYS: readonly Key[] = [
  {
    at: 25,
    zenith: hex('#3f7ecb'),
    horizon: hex('#bcd8f0'),
    sunward: hex('#c6dcf0'),
    glow: hex('#7a776c'),
    disc: hex('#ffffff'),
    opacity: 1,
    ground: [1, 1, 1],
    groundGrey: 0,
    light: [1, 1, 1],
    lightIntensity: 2.6,
  },
  {
    at: 10,
    zenith: hex('#427dc6'),
    horizon: hex('#b9d0e6'),
    sunward: hex('#dcdccf'),
    glow: hex('#b3a27c'),
    disc: hex('#fffef6'),
    opacity: 1,
    ground: [1, 0.97, 0.92],
    groundGrey: 0,
    light: [1, 0.96, 0.9],
    lightIntensity: 2.5,
  },
  {
    at: 4,
    zenith: hex('#4071b3'),
    horizon: hex('#aabcd4'),
    sunward: hex('#f0cf9c'),
    glow: hex('#cf9d55'),
    disc: hex('#fffae2'),
    opacity: 1,
    ground: [0.97, 0.89, 0.79],
    groundGrey: 0.03,
    light: [1, 0.87, 0.7],
    lightIntensity: 2.2,
  },
  {
    at: 0,
    zenith: hex('#335692'),
    horizon: hex('#8794b4'),
    sunward: hex('#f2a463'),
    glow: hex('#d07a35'),
    disc: hex('#ffe3a8'),
    opacity: 1,
    ground: [0.8, 0.73, 0.7],
    groundGrey: 0.1,
    light: [1, 0.76, 0.58],
    lightIntensity: 1.7,
  },
  {
    at: -3,
    zenith: hex('#233f74'),
    horizon: hex('#56668f'),
    sunward: hex('#d97f54'),
    glow: hex('#8a421a'),
    disc: hex('#ffb070'),
    opacity: 1,
    ground: [0.6, 0.59, 0.64],
    groundGrey: 0.2,
    light: [0.9, 0.8, 0.8],
    lightIntensity: 1.3,
  },
  {
    at: -6,
    zenith: hex('#152850'),
    horizon: hex('#2f416c'),
    sunward: hex('#8c5650'),
    glow: hex('#3a1a0c'),
    disc: hex('#000000'),
    opacity: 0.98,
    ground: [0.47, 0.49, 0.57],
    groundGrey: 0.3,
    light: [0.78, 0.83, 0.95],
    lightIntensity: 1.05,
  },
  {
    at: -9,
    zenith: hex('#0c1836'),
    horizon: hex('#1a284a'),
    sunward: hex('#40364f'),
    glow: hex('#140906'),
    disc: hex('#000000'),
    opacity: 0.9,
    ground: [0.39, 0.42, 0.51],
    groundGrey: 0.4,
    light: [0.72, 0.8, 0.98],
    lightIntensity: 0.95,
  },
  {
    at: -12,
    zenith: hex('#081127'),
    horizon: hex('#111c38'),
    sunward: hex('#1a2340'),
    glow: hex('#000000'),
    disc: hex('#000000'),
    opacity: 0.7,
    ground: [0.35, 0.38, 0.48],
    groundGrey: 0.45,
    light: [0.7, 0.78, 1],
    lightIntensity: 0.9,
  },
  {
    at: -18,
    zenith: hex('#060c1d'),
    horizon: hex('#0d162c'),
    sunward: hex('#0e172d'),
    glow: hex('#000000'),
    disc: hex('#000000'),
    opacity: 0.5,
    ground: [0.33, 0.36, 0.46],
    groundGrey: 0.5,
    light: [0.7, 0.78, 1],
    lightIntensity: 0.9,
  },
];

const mix = (a: number, b: number, u: number) => a + (b - a) * u;
const mixRgb = (a: Rgb, b: Rgb, u: number): Rgb => [
  mix(a[0], b[0], u),
  mix(a[1], b[1], u),
  mix(a[2], b[2], u),
];

/** The sky for a height of the sun above the horizon, degrees. */
export function skyAt(elevationDeg: number): SkyLook {
  const first = KEYS[0] as Key;
  const last = KEYS[KEYS.length - 1] as Key;
  if (elevationDeg >= first.at) return first;
  if (elevationDeg <= last.at) return last;
  const i = KEYS.findIndex((key) => key.at < elevationDeg);
  const a = KEYS[i - 1] as Key;
  const b = KEYS[i] as Key;
  const u = (a.at - elevationDeg) / (a.at - b.at);
  return {
    zenith: mixRgb(a.zenith, b.zenith, u),
    horizon: mixRgb(a.horizon, b.horizon, u),
    sunward: mixRgb(a.sunward, b.sunward, u),
    glow: mixRgb(a.glow, b.glow, u),
    disc: mixRgb(a.disc, b.disc, u),
    opacity: mix(a.opacity, b.opacity, u),
    ground: mixRgb(a.ground, b.ground, u),
    groundGrey: mix(a.groundGrey, b.groundGrey, u),
    light: mixRgb(a.light, b.light, u),
    lightIntensity: mix(a.lightIntensity, b.lightIntensity, u),
  };
}

/**
 * What the sky does: follow the sun, stay as by day, or show a fixed moment (epoch ms), for a look at another time.
 */
export type SkySetting = 'real' | 'day' | number;

/** The setting in the address: `?sky=day`, `?sky=2026-11-25T22:20Z`. */
export function parseSky(value: string | null): SkySetting | null {
  if (value === 'real' || value === 'day') return value;
  // A plus sign in an address arrives as a space.
  value = value?.replace(' ', '+') ?? null;
  // A moment without a zone would mean another one for every viewer.
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

const SAVED = 'towercab.sky';

/** The setting kept in this browser. */
export function savedSky(): SkySetting {
  try {
    return localStorage.getItem(SAVED) === 'day' ? 'day' : 'real';
  } catch {
    return 'real';
  }
}

export function saveSky(sky: SkySetting): void {
  try {
    if (sky === 'day') localStorage.setItem(SAVED, sky);
    else localStorage.removeItem(SAVED);
  } catch {
    // Private windows may refuse; the setting then lasts as long as the page.
  }
}

/** Where the sun is when the sky stays as by day: high in the south-west, where the light always used to come from. */
export const DAY_SUN = { elevationDeg: 50, azimuthDeg: 225 };

/** Aircraft are lit from the side the sun is on, but never from so low that their tops are dark. */
export const LOWEST_LIGHT_DEG = 22;
