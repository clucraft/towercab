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
   * youtube: the video ID of the live stream, or its YouTube address;
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

/**
 * What a YouTube address or id names. Only a video can be played: a live stream has a video id like any
 * other video. A channel is recognised so that the config can explain why it is not accepted.
 */
export type YouTubeSource = { type: 'video'; videoId: string } | { type: 'channel'; channelId: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/**
 * Reads a `youtube` camera's `source`: a video id, `channel:UC…`, or one of the usual YouTube addresses for
 * either. Returns null for anything else, including `@handle` addresses, which do not contain the channel id.
 */
export function parseYouTubeSource(source: string): YouTubeSource | null {
  const text = source.trim();
  if (VIDEO_ID.test(text)) return { type: 'video', videoId: text };
  const bare = text.startsWith('channel:') ? text.slice('channel:'.length) : text;
  if (CHANNEL_ID.test(bare)) return { type: 'channel', channelId: bare };

  // An address: scheme, one of YouTube's own hosts and nothing else, then path and query. (Taken apart by
  // hand because this package runs in the browser and in Node alike and leans on neither.)
  const address =
    /^https?:\/\/(?:www\.|m\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be)(?::\d+)?(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(
      text,
    );
  if (!address) return null;
  const host = (address[1] as string).toLowerCase();
  const parts = (address[2] ?? '').split('/').filter(Boolean);
  const query = (name: string): string | undefined =>
    (address[3] ?? '')
      .split('&')
      .map((pair) => pair.split('='))
      .find(([key]) => key === name)?.[1];
  const video = (id: string | undefined): YouTubeSource | null =>
    id && VIDEO_ID.test(id) ? { type: 'video', videoId: id } : null;
  const channel = (id: string | undefined): YouTubeSource | null =>
    id && CHANNEL_ID.test(id) ? { type: 'channel', channelId: id } : null;

  if (host === 'youtu.be') return video(parts[0]);
  if (parts[0] === 'watch') return video(query('v'));
  if (parts[0] === 'channel') return channel(parts[1]);
  if (parts[0] === 'embed' && parts[1] === 'live_stream') return channel(query('channel'));
  if (parts[0] === 'live' || parts[0] === 'embed' || parts[0] === 'shorts') return video(parts[1]);
  return null;
}

/** Where a camera entry came from: the config file, or the discovery queue after approval. */
export type CameraOrigin = 'config' | 'discovery';
export type CameraProvider = 'youtube' | 'windy';

/** A camera as a viewer's browser gets it from `/api/cameras/:icao`. */
export interface PublicCamera {
  id: string;
  airport: string;
  name: string;
  kind: CameraKind;
  /**
   * What the player loads. youtube: a video id. hls, mjpeg, snapshot and iframe: a URL,
   * either the camera's own or a path on this server when the camera is proxied. webrtc: a go2rtc stream name.
   */
  src: string;
  attribution?: string;
  /** The page to send people to: the camera's own site, or its page on YouTube or Windy. */
  link?: string;
  pose?: CameraPose;
  /** Snapshot cameras: seconds between reloads. */
  refreshSeconds: number;
  provider?: CameraProvider;
  /** iframe cameras: the site does not allow itself to be framed, so only the link is offered. */
  frameBlocked?: boolean;
  /** Why this camera cannot be shown, when something about its entry is wrong. */
  problem?: string;
}

export interface CamerasResponse {
  cameras: PublicCamera[];
  /** A go2rtc address is configured, so `webrtc` cameras can play. */
  go2rtc: boolean;
}

export type CameraStatus = 'pending' | 'approved' | 'rejected';

/** A camera as the admin page sees it: everything, including what viewers are not shown. */
export interface AdminCamera {
  id: string;
  airport: string;
  name: string;
  kind: CameraKind;
  source: string;
  attribution?: string;
  link?: string;
  pose?: CameraPose;
  /** Where the pose comes from: the config file, or the admin page (which wins). */
  poseFrom?: 'config' | 'admin';
  enabled: boolean;
  origin: CameraOrigin;
  provider?: CameraProvider;
  /** Config cameras are always `approved`; discovered ones start `pending`. */
  status: CameraStatus;
  thumbnail?: string;
  /** What discovery knew about it: the channel, how far from the field, which search found it. */
  detail?: { channel?: string; description?: string; distanceKm?: number; foundBy?: string };
  foundAt?: number;
  lastSeenAt?: number;
}

export interface DiscoveryRun {
  airport: string;
  provider: CameraProvider;
  ranAt: number;
  ok: boolean;
  /** Cameras the run returned, new or already known. */
  found: number;
  message?: string;
}

export interface AdminState {
  version: string;
  airports: { icao: string; name: string }[];
  discovery: {
    enabled: boolean;
    intervalHours: number;
    /** Which providers have a key. */
    youtube: boolean;
    windy: boolean;
  };
  cameras: AdminCamera[];
  runs: DiscoveryRun[];
  proxyAllowlist: string[];
  go2rtc: boolean;
}

/** What the admin page may change about a camera. Config cameras accept `pose` only. */
export const AdminCameraPatchSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    /** `null` removes the pose (for a config camera: goes back to the pose in the config file). */
    pose: CameraPoseSchema.nullable().optional(),
  })
  .strict();
export type AdminCameraPatch = z.infer<typeof AdminCameraPatchSchema>;
