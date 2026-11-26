import { describe, expect, it } from 'vitest';
import { levelFromSamples, litBars, savedVolume, saveVolume } from './level';

describe('radio level', () => {
  it('reads silence as nothing and a loud signal as full scale', () => {
    expect(levelFromSamples(new Uint8Array(256).fill(128))).toBe(0);
    expect(levelFromSamples([])).toBe(0);
    const loud = Uint8Array.from({ length: 256 }, (_, i) => (i % 2 ? 255 : 0));
    expect(levelFromSamples(loud)).toBe(1);
  });

  it('puts speech-like levels in the middle of the meter', () => {
    // A sine wave peaking at a quarter of full scale, as a receiver's audio typically does.
    const speech = Uint8Array.from({ length: 512 }, (_, i) => 128 + Math.round(32 * Math.sin(i / 5)));
    const level = levelFromSamples(speech);
    expect(level).toBeGreaterThan(0.4);
    expect(level).toBeLessThan(0.8);
  });

  it('lights at least one bar for any sound, and never more than there are', () => {
    expect(litBars(0, 12)).toBe(0);
    expect(litBars(Number.NaN, 12)).toBe(0);
    expect(litBars(0.01, 12)).toBe(1);
    expect(litBars(0.5, 12)).toBe(6);
    expect(litBars(3, 12)).toBe(12);
  });
});

describe('radio volume', () => {
  const memory = () => {
    const items = new Map<string, string>();
    return {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => {
        items.set(key, value);
      },
    };
  };

  it('remembers the volume, and starts at 80% when there is nothing to remember', () => {
    const storage = memory();
    expect(savedVolume(storage)).toBe(0.8);
    saveVolume(0.35, storage);
    expect(savedVolume(storage)).toBe(0.35);
    saveVolume(0, storage);
    expect(savedVolume(storage)).toBe(0);
  });

  it('ignores a stored value that is not a volume, and storage that refuses', () => {
    const storage = memory();
    storage.setItem('towercab.radio.volume', 'loud');
    expect(savedVolume(storage)).toBe(0.8);
    storage.setItem('towercab.radio.volume', '7');
    expect(savedVolume(storage)).toBe(0.8);
    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(savedVolume(refusing)).toBe(0.8);
    expect(() => saveVolume(0.5, refusing)).not.toThrow();
    expect(savedVolume(null)).toBe(0.8);
  });
});
