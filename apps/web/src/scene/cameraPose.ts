import type { CameraPose } from '@towercab/shared';

const RAD = Math.PI / 180;

/** Aspect ratio assumed for a camera whose picture size is not known (a YouTube player, a page in a frame). */
export const DEFAULT_ASPECT = 16 / 9;
/** How far a view cone is drawn from the camera, metres. */
export const CONE_RANGE_M = 450;

export interface Enu {
  east: number;
  north: number;
  up: number;
}

/** Vertical field of view that goes with a horizontal one at a given picture shape. */
export function verticalFovDeg(hfovDeg: number, aspect: number): number {
  return (2 * Math.atan(Math.tan((hfovDeg * RAD) / 2) / aspect)) / RAD;
}

/** Unit vectors of a camera's axes in the local east-north-up frame: where it looks, its right, its up. */
export function cameraAxes(headingDeg: number, pitchDeg: number): { forward: Enu; right: Enu; up: Enu } {
  const h = headingDeg * RAD;
  const p = pitchDeg * RAD;
  const forward = { east: Math.sin(h) * Math.cos(p), north: Math.cos(h) * Math.cos(p), up: Math.sin(p) };
  const right = { east: Math.cos(h), north: -Math.sin(h), up: 0 };
  // up = right x forward
  const up = {
    east: right.north * forward.up - right.up * forward.north,
    north: right.up * forward.east - right.east * forward.up,
    up: right.east * forward.north - right.north * forward.east,
  };
  return { forward, right, up };
}

/**
 * The four far corners of a camera's view, as offsets from the lens in metres (east, north, up), in the
 * order top-left, top-right, bottom-right, bottom-left as the camera sees them. `range` is measured along
 * the optical axis.
 */
export function frustumCorners(
  pose: Pick<CameraPose, 'headingDeg' | 'pitchDeg' | 'hfovDeg'>,
  aspect = DEFAULT_ASPECT,
  range = CONE_RANGE_M,
): Enu[] {
  const { forward, right, up } = cameraAxes(pose.headingDeg, pose.pitchDeg);
  const halfWidth = Math.tan((pose.hfovDeg * RAD) / 2) * range;
  const halfHeight = halfWidth / aspect;
  const corner = (x: number, y: number): Enu => ({
    east: forward.east * range + right.east * x * halfWidth + up.east * y * halfHeight,
    north: forward.north * range + right.north * x * halfWidth + up.north * y * halfHeight,
    up: forward.up * range + right.up * x * halfWidth + up.up * y * halfHeight,
  });
  return [corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)];
}

/** The rectangle a picture of shape `aspect` takes when fitted whole into a stage, centred. */
export function containRect(
  stageWidth: number,
  stageHeight: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  if (stageWidth <= 0 || stageHeight <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  if (stageWidth / stageHeight >= aspect) {
    const width = stageHeight * aspect;
    return { x: (stageWidth - width) / 2, y: 0, width, height: stageHeight };
  }
  const height = stageWidth / aspect;
  return { x: 0, y: (stageHeight - height) / 2, width: stageWidth, height };
}

/**
 * The field of view to give the 3D camera so that a camera's picture, fitted whole into the stage, lines up
 * with the scene behind it.
 *
 * Cesium's `fov` is the angle across the longer side of the canvas. The camera's `hfovDeg` is the angle
 * across its own picture, which covers the whole stage width only when the stage is at least as tall as
 * the picture's shape asks for; otherwise the stage shows more to the left and right than the camera does.
 * Returns radians.
 */
export function sceneFovRad(
  hfovDeg: number,
  stageWidth: number,
  stageHeight: number,
  pictureAspect: number | null,
): number {
  if (stageWidth <= 0 || stageHeight <= 0) return hfovDeg * RAD;
  const halfPicture = Math.tan((hfovDeg * RAD) / 2);
  const picture = pictureAspect ? containRect(stageWidth, stageHeight, pictureAspect) : null;
  // Tangent of half the angle across the full stage width.
  const halfStageWidth =
    picture && picture.width > 0 ? (halfPicture * stageWidth) / picture.width : halfPicture;
  const across = stageWidth >= stageHeight ? halfStageWidth : (halfStageWidth * stageHeight) / stageWidth;
  return 2 * Math.atan(across);
}

/** Compass bearing from one point to another, degrees, for points a short distance apart. */
export function bearingDeg(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
  const north = toLat - fromLat;
  const east = (toLon - fromLon) * Math.cos(fromLat * RAD);
  return (((Math.atan2(east, north) / RAD) % 360) + 360) % 360;
}

/** Smallest signed difference between two bearings, degrees, in -180..180. */
export function angleDiffDeg(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}
