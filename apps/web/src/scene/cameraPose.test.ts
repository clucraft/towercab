import { describe, expect, it } from 'vitest';
import {
  angleDiffDeg,
  bearingDeg,
  cameraAxes,
  containRect,
  frustumCorners,
  sceneFovRad,
  verticalFovDeg,
} from './cameraPose';

const DEG = 180 / Math.PI;
const length = (v: { east: number; north: number; up: number }) => Math.hypot(v.east, v.north, v.up);
const dot = (
  a: { east: number; north: number; up: number },
  b: { east: number; north: number; up: number },
) => a.east * b.east + a.north * b.north + a.up * b.up;

describe('camera axes', () => {
  it('looks north, level, with east to the right and up overhead', () => {
    const { forward, right, up } = cameraAxes(0, 0);
    expect(forward).toMatchObject({
      east: expect.closeTo(0),
      north: expect.closeTo(1),
      up: expect.closeTo(0),
    });
    expect(right).toMatchObject({ east: expect.closeTo(1), north: expect.closeTo(0), up: 0 });
    expect(up).toMatchObject({ east: expect.closeTo(0), north: expect.closeTo(0), up: expect.closeTo(1) });
  });

  it('looks east at heading 090, with south to the right', () => {
    const { forward, right } = cameraAxes(90, 0);
    expect(forward.east).toBeCloseTo(1);
    expect(right.north).toBeCloseTo(-1);
  });

  it('tips forward and down with a negative pitch, and stays square', () => {
    const { forward, right, up } = cameraAxes(230, -20);
    expect(forward.up).toBeCloseTo(Math.sin(-20 / DEG));
    for (const axis of [forward, right, up]) expect(length(axis)).toBeCloseTo(1);
    expect(dot(forward, right)).toBeCloseTo(0);
    expect(dot(forward, up)).toBeCloseTo(0);
    expect(dot(right, up)).toBeCloseTo(0);
    // Tilted down, the picture's "up" still has an upward part.
    expect(up.up).toBeGreaterThan(0.9);
  });
});

describe('view cone', () => {
  it('spans the horizontal field of view at the far end', () => {
    const [topLeft, topRight, bottomRight, bottomLeft] = frustumCorners(
      { headingDeg: 0, pitchDeg: 0, hfovDeg: 60 },
      16 / 9,
      100,
    );
    // 100 m out, 60 degrees across: 2 * 100 * tan(30) = 115.5 m wide, 65 m tall.
    expect((topRight?.east ?? 0) - (topLeft?.east ?? 0)).toBeCloseTo(115.47, 1);
    expect((topLeft?.up ?? 0) - (bottomLeft?.up ?? 0)).toBeCloseTo(64.95, 1);
    for (const corner of [topLeft, topRight, bottomRight, bottomLeft]) expect(corner?.north).toBeCloseTo(100);
    expect(topLeft?.east).toBeLessThan(0);
    expect(bottomRight?.up).toBeLessThan(0);
  });

  it('turns with the heading', () => {
    const corners = frustumCorners({ headingDeg: 90, pitchDeg: 0, hfovDeg: 40 }, 16 / 9, 200);
    for (const corner of corners) expect(corner.east).toBeCloseTo(200);
    // Looking east, the left edge of the picture is to the north.
    expect(corners[0]?.north).toBeGreaterThan(0);
    expect(corners[1]?.north).toBeLessThan(0);
  });

  it('works out the vertical field of view from the picture shape', () => {
    expect(verticalFovDeg(90, 1)).toBeCloseTo(90);
    expect(verticalFovDeg(60, 16 / 9)).toBeCloseTo(35.98, 1);
  });
});

describe('fitting a picture into the stage', () => {
  it('leaves bars at the sides of a wide stage and above and below in a tall one', () => {
    expect(containRect(1600, 600, 16 / 9)).toEqual({
      x: expect.closeTo(266.67, 1),
      y: 0,
      width: expect.closeTo(1066.67, 1),
      height: 600,
    });
    expect(containRect(800, 900, 16 / 9)).toEqual({ x: 0, y: 225, width: 800, height: 450 });
    expect(containRect(1600, 900, 16 / 9)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    expect(containRect(0, 0, 16 / 9).width).toBe(0);
  });
});

describe('field of view for matching a camera', () => {
  it('is the camera’s own when the picture fills the stage width', () => {
    expect(sceneFovRad(60, 1600, 900, 16 / 9) * DEG).toBeCloseTo(60);
    // A taller stage: the picture still spans the full width.
    expect(sceneFovRad(60, 1600, 1200, 16 / 9) * DEG).toBeCloseTo(60);
    // No picture to line up with: the angle is simply applied across the stage.
    expect(sceneFovRad(60, 1600, 900, null) * DEG).toBeCloseTo(60);
  });

  it('widens when the stage is wider than the picture', () => {
    // The picture takes two thirds of the width, so the stage sees 1.5 times as far to each side.
    const fov = sceneFovRad(60, 1600, 600, 16 / 9);
    expect(Math.tan(fov / 2)).toBeCloseTo(Math.tan(30 / DEG) * 1.5);
    expect(fov * DEG).toBeGreaterThan(60);
  });

  it('gives the vertical angle for a stage that is taller than wide, as Cesium wants', () => {
    // 800 x 1000: the picture spans the 800 px width at 60 degrees; the angle across the 1000 px height
    // is what Cesium takes as "fov".
    const fov = sceneFovRad(60, 800, 1000, 16 / 9);
    expect(Math.tan(fov / 2)).toBeCloseTo((Math.tan(30 / DEG) * 1000) / 800);
  });
});

describe('bearings', () => {
  it('points the right way', () => {
    expect(bearingDeg(40, -86, 40.01, -86)).toBeCloseTo(0);
    expect(bearingDeg(40, -86, 40, -85.99)).toBeCloseTo(90);
    expect(bearingDeg(40, -86, 39.99, -86)).toBeCloseTo(180);
    expect(bearingDeg(40, -86, 40, -86.01)).toBeCloseTo(270);
    // North-east on the ground, not on the map: a degree of longitude is shorter than one of latitude.
    expect(bearingDeg(40, -86, 40.01, -86 + 0.01 / Math.cos(40 / DEG))).toBeCloseTo(45);
  });

  it('measures the short way round', () => {
    expect(angleDiffDeg(10, 350)).toBe(20);
    expect(angleDiffDeg(350, 10)).toBe(-20);
    expect(angleDiffDeg(180, 0)).toBe(-180);
    expect(angleDiffDeg(725, 5)).toBe(0);
  });
});
