import { AirportEntrySchema, CameraConfigSchema } from '@towercab/shared';
import { z } from 'zod';

const priority = z.number().int().min(0).max(99);

/** A public aggregator API. `baseUrl` exists so a self-hosted mirror can be used; the default is built in. */
function publicProvider(defaultPriority: number, defaultEnabled: boolean) {
  return z
    .object({
      enabled: z.boolean().default(defaultEnabled),
      priority: priority.default(defaultPriority),
      baseUrl: z.url().optional(),
      /** Minimum gap between requests to this provider across all airports. Raises, never lowers, the built-in limit. */
      minIntervalMs: z.number().int().min(250).optional(),
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
    adsblol: publicProvider(1, true),
    airplaneslive: publicProvider(2, true),
    adsbfi: publicProvider(3, true),
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
    /** The highest-priority public source is polled every cycle; the others every Nth cycle. */
    secondaryEveryN: z.number().int().min(1).max(60).default(3),
  })
  .prefault({});
export type PollingConfig = z.infer<typeof PollingSchema>;

/** Secrets may be written in the config file, but environment variables always win. */
export const SecretsSchema = z
  .object({
    cesiumIonToken: z.string().optional(),
    googleMapsApiKey: z.string().optional(),
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
        /** Hostnames the camera proxy may fetch from. Empty means the proxy is off. */
        allowlist: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
    discovery: z
      .object({
        enabled: z.boolean().default(false),
        /** Minimum hours between discovery runs per airport. YouTube searches cost 100 quota units each. */
        intervalHours: z.number().min(6).default(6),
      })
      .prefault({}),
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
    const ids = new Set<string>();
    cfg.cameras.forEach((c, i) => {
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

/** The config file with environment overrides applied. This is what the rest of the server reads. */
export type AppConfig = ConfigFile;
