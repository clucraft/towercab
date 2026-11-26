/**
 * The loudness of a moment of audio, from an analyser's time-domain bytes (128 is silence), as 0 to 1. Scaled so
 * that speech on an airband receiver fills most of the meter: radio audio peaks well below full scale.
 */
export function levelFromSamples(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = ((samples[i] as number) - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, rms * 3);
}

/** How many of `bars` meter bars are lit for a level. */
export function litBars(level: number, bars: number): number {
  if (!(level > 0)) return 0;
  return Math.max(1, Math.min(bars, Math.round(level * bars)));
}

const VOLUME_KEY = 'towercab.radio.volume';
const DEFAULT_VOLUME = 0.8;

/** The volume this browser last used, or the default. */
export function savedVolume(storage: Pick<Storage, 'getItem'> | null = safeStorage()): number {
  try {
    const value = Number(storage?.getItem(VOLUME_KEY));
    return storage?.getItem(VOLUME_KEY) != null && Number.isFinite(value) && value >= 0 && value <= 1
      ? value
      : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

export function saveVolume(volume: number, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(VOLUME_KEY, String(Math.round(volume * 100) / 100));
  } catch {
    // Private windows and blocked storage: the volume is simply not remembered.
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
