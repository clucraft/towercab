import { dirname, join } from 'node:path';
import { z } from 'zod';
import { findUp } from '../util/paths';
import type { Secrets } from './schema';

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(blankToUndefined, z.string().trim().optional());

const EnvSchema = z.object({
  NODE_ENV: optionalString,
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65535).default(8790)),
  PUBLIC_URL: z.preprocess(blankToUndefined, z.url().optional()),
  LOG_LEVEL: z.preprocess(
    blankToUndefined,
    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
  ),
  CONFIG_DIR: optionalString,
  DATA_DIR: optionalString,
  /** Directory holding the built web app. Found automatically when unset. */
  WEB_DIST: optionalString,
  TOWERCAB_VERSION: z.preprocess(blankToUndefined, z.string().default('dev')),
  CESIUM_ION_TOKEN: optionalString,
  GOOGLE_MAPS_API_KEY: optionalString,
  ADSBLOL_API_KEY: optionalString,
  OPENSKY_CLIENT_ID: optionalString,
  OPENSKY_CLIENT_SECRET: optionalString,
  YOUTUBE_API_KEY: optionalString,
  WINDY_API_KEY: optionalString,
  ADMIN_TOKEN: optionalString,
});

export interface Env {
  production: boolean;
  port: number;
  publicUrl: string | undefined;
  logLevel: string;
  configDir: string;
  dataDir: string;
  webDist: string | undefined;
  version: string;
  /** Secrets present in the environment. They override the same keys in the config file. */
  secrets: Secrets;
}

/**
 * Where config and data live when `CONFIG_DIR` / `DATA_DIR` are not set: the container volumes in
 * production, and a gitignored `.local/` folder at the repo root during development.
 */
function defaultDir(kind: 'config' | 'data', production: boolean): string {
  if (!production) {
    const workspaceFile = findUp('pnpm-workspace.yaml');
    if (workspaceFile) return join(dirname(workspaceFile), '.local', kind);
  }
  return `/${kind}`;
}

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const e = EnvSchema.parse(source);
  const production = e.NODE_ENV === 'production';
  const secrets: Secrets = {
    cesiumIonToken: e.CESIUM_ION_TOKEN,
    googleMapsApiKey: e.GOOGLE_MAPS_API_KEY,
    adsblolApiKey: e.ADSBLOL_API_KEY,
    openskyClientId: e.OPENSKY_CLIENT_ID,
    openskyClientSecret: e.OPENSKY_CLIENT_SECRET,
    youtubeApiKey: e.YOUTUBE_API_KEY,
    windyApiKey: e.WINDY_API_KEY,
    adminToken: e.ADMIN_TOKEN,
  };
  return {
    production,
    port: e.PORT,
    publicUrl: e.PUBLIC_URL?.replace(/\/+$/, ''),
    logLevel: e.LOG_LEVEL,
    configDir: e.CONFIG_DIR ?? defaultDir('config', production),
    dataDir: e.DATA_DIR ?? defaultDir('data', production),
    webDist: e.WEB_DIST,
    version: e.TOWERCAB_VERSION,
    secrets,
  };
}
