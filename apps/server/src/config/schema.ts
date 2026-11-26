import {
  AirportEntrySchema,
  type AudioStation,
  CameraConfigSchema,
  isLiveAtcUrl,
  parseYouTubeSource,
} from '@towercab/shared';
import { z } from 'zod';
import { type HostRule, matchRule, parseHostRule } from '../cameras/allowlist';

const priority = z.number().int().min(0).max(99);

/** A public aggregator API. The URL, rate limit and quota are built in; config can only tighten them. */
function publicProvider(defaultPriority: number, defaultEnabled: boolean) {
  return z
    .object({
      enabled: z.boolean().default(defaultEnabled),
      priority: priority.default(defaultPriority),
      /** Use a different base URL, for a self-hosted mirror. */
      baseUrl: z.url().optional(),
      /**
       * Gap between requests to this provider across all airports. Can be raised freely; it can be lowered
       * only as far as the provider's published limit (adsb.fi: 1.1 s) or safe floor (adsb.lol: 3 s).
       */
      minIntervalMs: z.number().int().min(250).optional(),
      /** Requests per day to budget for, when your key or agreement differs from the built-in assumption. */
      dailyQuota: z.number().int().positive().optional(),
      /** Extra request headers, for services that grant access through a header of their own. */
      headers: z.record(z.string(), z.string()).optional(),
    })
    .prefault({});
}

export const ProvidersSchema = z
  .object({
    readsb: z
      .object({
        enabled: z.boolean().default(false),
        priority: priority.default(0),
        /** tar1090 / ultrafeeder `aircraft.json` URL. */
        url: z.url().default('http://ultrafeeder/data/aircraft.json'),
        /** Optional readsb JSON position stream (`--net-json-port`, 30047 by default). Lower latency than polling. */
        stream: z
          .object({
            host: z.string().min(1),
            port: z.number().int().min(1).max(65535).default(30047),
          })
          .optional(),
      })
      .prefault({}),
    // Order and defaults follow what the live services allow; see docs/DECISIONS.md D-010 to D-012.
    adsbfi: publicProvider(1, true),
    adsblol: publicProvider(2, true),
    airplaneslive: publicProvider(3, false),
    opensky: z
      .object({
        enabled: z.boolean().default(false),
        priority: priority.default(9),
      })
      .prefault({}),
  })
  .prefault({});
export type ProvidersConfig = z.infer<typeof ProvidersSchema>;
export type ProviderId = keyof ProvidersConfig;

export const PollingSchema = z
  .object({
    /** Poll interval while at least one browser is watching the airport. */
    activeIntervalMs: z.number().int().min(1000).default(2000),
    /** Poll interval after the last viewer leaves. */
    idleIntervalMs: z.number().int().min(5000).default(60_000),
    /** How long to keep idling before polling stops completely. */
    pauseWhenNoViewersAfterMs: z.number().int().min(0).default(300_000),
    /** The preferred public source is polled every cycle; the others every Nth cycle. */
    secondaryEveryN: z.number().int().min(1).max(60).default(3),
  })
  .prefault({});
export type PollingConfig = z.infer<typeof PollingSchema>;

/** Secrets may be written in the config file, but environment variables always win. */
export const SecretsSchema = z
  .object({
    cesiumIonToken: z.string().optional(),
    googleMapsApiKey: z.string().optional(),
    adsblolApiKey: z.string().optional(),
    openskyClientId: z.string().optional(),
    openskyClientSecret: z.string().optional(),
    youtubeApiKey: z.string().optional(),
    windyApiKey: z.string().optional(),
    adminToken: z.string().optional(),
  })
  .prefault({});
export type Secrets = z.infer<typeof SecretsSchema>;

export const ConfigFileSchema = z
  .object({
    airports: z.array(AirportEntrySchema).min(1, 'configure at least one airport'),
    providers: ProvidersSchema,
    polling: PollingSchema,
    cameras: z.array(CameraConfigSchema).default([]),
    proxy: z
      .object({
        /**
         * Hosts the camera proxy may fetch from: `host`, `host:port`, `*.domain.tld` or an address.
         * Empty means the proxy is off. See apps/server/src/cameras/allowlist.ts.
         */
        allowlist: z.array(z.string().min(1)).default([]),
        /**
         * Let a host *name* on the allowlist resolve to an address on a private network. Off by default,
         * so that an outside host cannot point its name at a device on your network. A camera on your own
         * network is better allowed by listing its address.
         */
        allowPrivateAddresses: z.boolean().default(false),
      })
      .prefault({}),
    go2rtc: z
      .object({
        /** Address of a go2rtc instance for `webrtc` cameras, e.g. http://go2rtc:1984. Unset: none. */
        url: z.url().optional(),
      })
      .prefault({}),
    discovery: z
      .object({
        enabled: z.boolean().default(false),
        /** Hours a search result is kept before the same search may be sent again, per airport. */
        intervalHours: z.number().min(6).default(6),
        /** YouTube: how far from the airport's reference point a live video's location may be. */
        youtubeRadiusKm: z.number().min(1).max(100).default(10),
        /** Windy: how far from the airport's reference point a webcam may be. */
        windyRadiusKm: z.number().min(1).max(250).default(15),
      })
      .prefault({}),
    client: z
      .object({
        /** How far behind real time browsers render, so there is always a newer position to move towards. */
        renderDelayMs: z.number().int().min(0).max(15_000).default(2500),
      })
      .prefault({}),
    photos: z
      .object({
        /** Look up an aircraft photo on planespotters.net when an aircraft is selected. */
        enabled: z.boolean().default(true),
        /** When there is none, show a picture of the aircraft's type from Wikimedia Commons instead. */
        types: z.boolean().default(true),
      })
      .prefault({}),
    /** Overpass API endpoint for the airport layout. Point this at your own instance for heavy use. */
    overpassUrl: z.url().optional(),
    /**
     * `User-Agent` sent to every upstream service. Several of them refuse generic agents, so it has to
     * identify the application and give a contact URL. Defaults to the project's own.
     */
    userAgent: z.string().min(8).optional(),
    secrets: SecretsSchema,
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.airports.forEach((a, i) => {
      if (seen.has(a.icao)) {
        ctx.addIssue({
          code: 'custom',
          path: ['airports', i, 'icao'],
          message: `duplicate airport ${a.icao}`,
        });
      }
      seen.add(a.icao);
    });
    const rules: HostRule[] = [];
    cfg.proxy.allowlist.forEach((entry, i) => {
      try {
        rules.push(parseHostRule(entry));
      } catch (err) {
        ctx.addIssue({ code: 'custom', path: ['proxy', 'allowlist', i], message: (err as Error).message });
      }
    });
    cfg.airports.forEach((a, i) => {
      a.audio.forEach((station, j) => {
        const problem = audioStationProblem(a.icao, station, rules);
        if (problem)
          ctx.addIssue({ code: 'custom', path: ['airports', i, 'audio', j, 'url'], message: problem });
      });
    });
    const ids = new Set<string>();
    cfg.cameras.forEach((c, i) => {
      const problem = cameraSourceProblem(c, rules);
      if (problem) ctx.addIssue({ code: 'custom', path: ['cameras', i, 'source'], message: problem });
      if (ids.has(c.id)) {
        ctx.addIssue({ code: 'custom', path: ['cameras', i, 'id'], message: `duplicate camera id ${c.id}` });
      }
      ids.add(c.id);
      if (!seen.has(c.airport)) {
        ctx.addIssue({
          code: 'custom',
          path: ['cameras', i, 'airport'],
          message: `camera ${c.id} refers to ${c.airport}, which is not a configured airport`,
        });
      }
    });
  });
export type ConfigFile = z.infer<typeof ConfigFileSchema>;

/** A Windy webcam as a snapshot source: `windy:<webcam id>`. The server keeps its image address fresh. */
export const WINDY_SOURCE = /^windy:(\d{1,12})$/;

/** What is wrong with a camera's `source` for its `kind`, in words for the person editing the config. */
export function cameraSourceProblem(
  camera: { id: string; kind: string; source: string; proxy?: boolean },
  rules: readonly HostRule[],
): string | null {
  const { kind, source } = camera;
  if (kind === 'youtube') {
    const parsed = parseYouTubeSource(source);
    if (parsed?.type === 'video') return null;
    return parsed?.type === 'channel'
      ? `camera ${camera.id}: a channel cannot be played, only a video. Use the video id of the channel's live stream (the part after "v=" in its address)`
      : `camera ${camera.id}: a youtube source is the video id of the live stream, or its YouTube address`;
  }
  if (kind === 'webrtc') {
    return /^[A-Za-z0-9_.-]{1,64}$/.test(source)
      ? null
      : `camera ${camera.id}: a webrtc source is the name of a go2rtc stream (letters, digits, ".", "_" and "-")`;
  }
  if (kind === 'snapshot' && WINDY_SOURCE.test(source)) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return `camera ${camera.id}: the source of a ${kind} camera must be an http or https address`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `camera ${camera.id}: the source of a ${kind} camera must be an http or https address`;
  }
  if (camera.proxy) {
    if (kind === 'iframe') return `camera ${camera.id}: an iframe camera cannot be proxied`;
    if (!matchRule(url, rules)) {
      return `camera ${camera.id} is proxied, but ${url.host} is not on proxy.allowlist`;
    }
  } else if (url.username || url.password) {
    // Without the proxy the address goes to every viewer's browser as it is.
    return `camera ${camera.id}: the source contains a user name or password; set "proxy: true" so it stays on the server`;
  }
  return null;
}

/** What is wrong with a radio station's address, in words for the person editing the config. */
export function audioStationProblem(
  icao: string,
  station: Pick<AudioStation, 'name' | 'url' | 'proxy'>,
  rules: readonly HostRule[],
): string | null {
  const url = new URL(station.url);
  const which = `${icao} radio station "${station.name}"`;
  if (station.proxy) {
    // LiveATC's terms of use (3.3) forbid making their service available over another network.
    if (isLiveAtcUrl(url)) {
      return `${which}: LiveATC's terms of use do not allow its streams to be passed on through another server. See docs/RADIO.md`;
    }
    if (!matchRule(url, rules)) return `${which} is proxied, but ${url.host} is not on proxy.allowlist`;
  } else if (url.username || url.password) {
    // Without the proxy the address goes to every listener's browser as it is.
    return `${which}: the address contains a user name or password; set "proxy: true" so it stays on the server`;
  }
  return null;
}

/** The config file with environment overrides applied. This is what the rest of the server reads. */
export type AppConfig = ConfigFile;
