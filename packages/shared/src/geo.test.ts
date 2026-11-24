import { describe, expect, it } from 'vitest';
import {
  angleDiffDeg,
  bearingDeg,
  destinationPoint,
  distanceM,
  distanceNm,
  normalizeDeg,
  positionOnSegment,
  toLocalEnu,
} from './geo';

// KLAF runway 10/28 ends from OurAirports.
const RWY10 = { lat: 40.41400146484375, lon: -86.95089721679688 };
const RWY28 = { lat: 40.41109848022461, lon: -86.92749786376953 };

describe('angles', () => {
  it('normalises into [0, 360)', () => {
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(370)).toBe(10);
    expect(normalizeDeg(360)).toBe(0);
  });

  it('finds the signed shortest rotation', () => {
    expect(angleDiffDeg(350, 10)).toBe(20);
    expect(angleDiffDeg(10, 350)).toBe(-20);
    expect(angleDiffDeg(0, 180)).toBe(180);
    expect(angleDiffDeg(90, 90)).toBe(0);
  });
});

describe('distance and bearing', () => {
  it('measures the KLAF 10/28 runway at its published 6,600 ft', () => {
    const lengthFt = distanceM(RWY10.lat, RWY10.lon, RWY28.lat, RWY28.lon) / 0.3048;
    expect(lengthFt).toBeGreaterThan(6540);
    expect(lengthFt).toBeLessThan(6660);
  });

  it('gives the runway heading as the bearing between its ends', () => {
    expect(bearingDeg(RWY10.lat, RWY10.lon, RWY28.lat, RWY28.lon)).toBeCloseTo(99.3, 0);
    expect(bearingDeg(RWY28.lat, RWY28.lon, RWY10.lat, RWY10.lon)).toBeCloseTo(279.3, 0);
  });

  it('one minute of latitude is one nautical mile', () => {
    expect(distanceNm(40, -86, 40 + 1 / 60, -86)).toBeCloseTo(1, 2);
  });

  it('destinationPoint is the inverse of distance and bearing', () => {
    const p = destinationPoint(40.4, -86.9, 47, 5000);
    expect(distanceM(40.4, -86.9, p.lat, p.lon)).toBeCloseTo(5000, 0);
    expect(bearingDeg(40.4, -86.9, p.lat, p.lon)).toBeCloseTo(47, 1);
  });
});

describe('local coordinates', () => {
  it('agrees with great-circle distance over airport-sized areas', () => {
    const enu = toLocalEnu(RWY10.lat, RWY10.lon, RWY28.lat, RWY28.lon);
    const direct = distanceM(RWY10.lat, RWY10.lon, RWY28.lat, RWY28.lon);
    expect(Math.hypot(enu.east, enu.north)).toBeCloseTo(direct, 0);
    expect(enu.east).toBeGreaterThan(0);
    expect(enu.north).toBeLessThan(0);
  });

  it('places a point along and beside a segment', () => {
    const mid = { lat: (RWY10.lat + RWY28.lat) / 2, lon: (RWY10.lon + RWY28.lon) / 2 };
    const onCentreline = positionOnSegment(mid.lat, mid.lon, RWY10.lat, RWY10.lon, RWY28.lat, RWY28.lon);
    expect(onCentreline.alongM).toBeCloseTo(onCentreline.lengthM / 2, 0);
    expect(Math.abs(onCentreline.crossM)).toBeLessThan(0.5);

    // 100 m south of the midpoint of a runway heading roughly east: that is to the right of travel.
    const south = destinationPoint(mid.lat, mid.lon, 180, 100);
    const beside = positionOnSegment(south.lat, south.lon, RWY10.lat, RWY10.lon, RWY28.lat, RWY28.lon);
    expect(beside.crossM).toBeGreaterThan(95);
    expect(beside.crossM).toBeLessThan(101);

    // One mile out on the approach to runway 10 is before the start of the segment.
    const final = destinationPoint(RWY10.lat, RWY10.lon, 279.3, 1852);
    expect(
      positionOnSegment(final.lat, final.lon, RWY10.lat, RWY10.lon, RWY28.lat, RWY28.lon).alongM,
    ).toBeCloseTo(-1852, -1);
  });
});
