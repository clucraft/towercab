import { z } from 'zod';
import { IcaoSchema, LatSchema, LonSchema } from './airport';

export const CameraKindSchema = z.enum(['youtube', 'hls', 'mjpeg', 'snapshot', 'iframe', 'webrtc']);
export type CameraKind = z.infer<typeof CameraKindSchema>;

/**
 * Where a camera is and where it points. With a pose, the camera appears as a view cone in the 3D scene and
 * "Match view" can put the 3D camera in the same place.
 */
export const CameraPoseSchema = z.object({
  lat: LatSchema,
  lon: LonSchema,
  /** Lens height above the ground at the camera position, in metres. */
  heightM: z.number().min(0).max(1000),
  /** Compass direction of the optical axis, degrees true. */
  headingDeg: z.number().min(0).max(360),
  /** Tilt of the optical axis: 0 is level, negative looks down. */
  pitchDeg: z.number().min(-90).max(90).default(0),
  /** Horizontal field of view. */
  hfovDeg: z.number().min(1).max(179).default(60),
});
export type CameraPose = z.infer<typeof CameraPoseSchema>;

export const CameraConfigSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'letters, digits, "-" and "_" only'),
  airport: IcaoSchema,
  name: z.string().min(1),
  kind: CameraKindSchema,
  /**
   * What to play. Depends on `kind`:
   * youtube: a video ID, or `channel:UC…` for a channel's current live stream;
   * hls / mjpeg / snapshot / iframe: an absolute URL;
   * webrtc: a go2rtc stream name.
   */
  source: z.string().min(1),
  attribution: z.string().optional(),
  link: z.url().optional(),
  pose: CameraPoseSchema.optional(),
  enabled: z.boolean().default(true),
  /** Snapshot cameras only: seconds between image reloads. */
  refreshSeconds: z.number().min(2).max(3600).default(30),
  /** Fetch through the server instead of directly. Only works for hosts on `proxy.allowlist`. */
  proxy: z.boolean().default(false),
});
export type CameraConfig = z.infer<typeof CameraConfigSchema>;
export type CameraConfigInput = z.input<typeof CameraConfigSchema>;
