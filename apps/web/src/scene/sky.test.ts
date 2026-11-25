import { describe, expect, it } from 'vitest';
import { parseSky, type Rgb, skyAt } from './sky';

const bright = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe('skyAt', () => {
  it('is the same at any hour of full day, and at any of full night', () => {
    expect(skyAt(90)).toEqual(skyAt(25));
    expect(skyAt(-18)).toEqual(skyAt(-80));
    expect(skyAt(60).ground).toEqual([1, 1, 1]);
    expect(skyAt(60).opacity).toBe(1);
  });

  it('gets darker all the way down, overhead and on the ground', () => {
    for (let elevation = 25; elevation > -18; elevation -= 0.25) {
      const now = skyAt(elevation);
      const later = skyAt(elevation - 0.25);
      expect(bright(later.zenith)).toBeLessThanOrEqual(bright(now.zenith) + 1e-9);
      expect(bright(later.ground)).toBeLessThanOrEqual(bright(now.ground) + 1e-9);
      expect(later.lightIntensity).toBeLessThanOrEqual(now.lightIntensity + 1e-9);
      expect(later.opacity).toBeLessThanOrEqual(now.opacity + 1e-9);
    }
  });

  it('never jumps: the sun takes a quarter of a minute for a twentieth of a degree', () => {
    for (let elevation = 30; elevation > -20; elevation -= 0.05) {
      const now = skyAt(elevation);
      const later = skyAt(elevation - 0.05);
      for (const key of ['zenith', 'horizon', 'sunward', 'glow', 'disc', 'ground', 'light'] as const) {
        for (let i = 0; i < 3; i += 1) {
          expect(Math.abs((later[key][i] as number) - (now[key][i] as number))).toBeLessThan(0.02);
        }
      }
    }
  });

  it('is warm below a setting sun and blue overhead', () => {
    const { sunward, zenith, horizon } = skyAt(0);
    expect(sunward[0]).toBeGreaterThan(sunward[2] * 1.8);
    expect(zenith[2]).toBeGreaterThan(zenith[0] * 1.8);
    expect(horizon[2]).toBeGreaterThan(horizon[0]);
  });

  it('keeps the stars in until well after sunset', () => {
    expect(skyAt(0).opacity).toBe(1);
    expect(skyAt(-5).opacity).toBeGreaterThan(0.95);
    expect(skyAt(-18).opacity).toBeLessThan(0.7);
  });

  it('leaves enough light to see the airfield and the aircraft at night', () => {
    const night = skyAt(-40);
    expect(bright(night.ground)).toBeGreaterThan(0.3);
    expect(bright(night.ground)).toBeLessThan(0.5);
    expect(night.lightIntensity).toBeGreaterThan(0.5);
  });
});

describe('parseSky', () => {
  it('reads what can be asked for in the address', () => {
    expect(parseSky('day')).toBe('day');
    expect(parseSky('real')).toBe('real');
    expect(parseSky('2026-11-25T22:20Z')).toBe(Date.UTC(2026, 10, 25, 22, 20));
    expect(parseSky('2026-11-25T17:20:30-05:00')).toBe(Date.UTC(2026, 10, 25, 22, 20, 30));
    // A plus sign in an address arrives as a space.
    expect(parseSky('2026-11-25T22:20 01:00')).toBe(Date.UTC(2026, 10, 25, 21, 20));
  });

  it('takes nothing that is not clear, such as a time without a zone', () => {
    for (const value of [null, '', 'night', '17:20', '2026-11-25', '2026-11-25T17:20', '2026-13-45T22:20Z']) {
      expect(parseSky(value), String(value)).toBeNull();
    }
  });
});
