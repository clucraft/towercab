import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { WindyImages } from './cameras/discovery';
import { DiscoveryService } from './cameras/discoveryService';
import { FrameChecker } from './cameras/frameCheck';
import { Go2rtcBridge } from './cameras/go2rtc';
import { CameraProxy } from './cameras/proxy';
import { CameraRegistry } from './cameras/registry';
import { CameraStore } from './cameras/store';
import type { Env } from './config/env';
import type { ConfigStore } from './config/loader';
import type { AppConfig } from './config/schema';
import { LiveService } from './live/liveService';
import type { FetchLike } from './providers/http';
import { ProviderRegistry } from './providers/registry';
import { AirportService } from './reference/airportService';
import { MetarService } from './reference/metar';
import { OurAirportsStore } from './reference/ourairports';
import { LayoutStore } from './reference/overpass';
import { PhotoService } from './reference/photos';
import { WsHub } from './ws/hub';

/** Everything the routes and the WebSocket hub work with. */
export interface Services {
  env: Env;
  logger: FastifyBaseLogger;
  config: ConfigStore;
  providers: ProviderRegistry;
  airports: AirportService;
  metar: MetarService;
  photos: PhotoService;
  live: LiveService;
  hub: WsHub;
  cameras: CameraServices;
  /** Stops polling, closes sockets and file watchers. */
  close(): void;
}

/** Everything to do with cameras. */
export interface CameraServices {
  registry: CameraRegistry;
  /** The queue database. Null when it could not be opened; cameras from the config file still work. */
  store: CameraStore | null;
  proxy: CameraProxy;
  windy: WindyImages;
  frames: FrameChecker;
  go2rtc: Go2rtcBridge;
  discovery: DiscoveryService | null;
}

export const PROJECT_URL = 'https://github.com/clucraft/towercab';

/**
 * Upstream services (Overpass, planespotters) refuse requests that do not say who is asking, so every
 * request carries the application name, its version and where to find its maintainers.
 */
export function userAgentFor(config: AppConfig, version: string): string {
  return config.userAgent ?? `TowerCab/${version} (+${PROJECT_URL})`;
}

export interface CreateServicesOptions {
  env: Env;
  logger: FastifyBaseLogger;
  config: ConfigStore;
  /** Replaces `fetch` for every upstream call. Tests use it to stay off the network. */
  fetchImpl?: FetchLike;
}

export async function createServices(options: CreateServicesOptions): Promise<Services> {
  const { env, logger, config, fetchImpl } = options;
  const userAgent = userAgentFor(config.current, env.version);

  const providers = new ProviderRegistry({ userAgent, fetchImpl, log: logger });
  providers.rebuild(config.current);

  const ourAirports = new OurAirportsStore({ dataDir: env.dataDir, userAgent, fetchImpl, log: logger });
  const layouts = new LayoutStore({
    dataDir: env.dataDir,
    userAgent,
    overpassUrl: config.current.overpassUrl,
    fetchImpl,
    log: logger,
  });
  const airports = new AirportService(ourAirports, layouts, logger);
  const metar = new MetarService({ userAgent, fetchImpl, log: logger });
  const photos = new PhotoService({ userAgent, fetchImpl });

  const live = new LiveService({
    airports,
    metar,
    providers: providers.list,
    polling: () => config.current.polling,
    log: logger,
  });
  const cameras = createCameraServices(options, userAgent);
  const hub = new WsHub({
    live,
    airports,
    version: env.version,
    log: logger,
    // The only other WebSocket this server speaks: a camera stream from go2rtc.
    otherUpgrade: (request, socket, head) => cameras.go2rtc.handleUpgrade(request, socket, head),
  });

  airports.on('change', () => live.sync());
  await airports.load(config.current.airports);

  const onConfigChange = (next: AppConfig) => {
    providers.rebuild(next);
    void airports.load(next.airports);
  };
  config.on('change', onConfigChange);

  return {
    env,
    logger,
    config,
    providers,
    airports,
    metar,
    photos,
    live,
    hub,
    cameras,
    close() {
      config.off('change', onConfigChange);
      hub.close();
      cameras.go2rtc.close();
      cameras.store?.close();
      live.stop();
      providers.close();
    },
  };
}

function createCameraServices(options: CreateServicesOptions, userAgent: string): CameraServices {
  const { env, logger, config, fetchImpl } = options;
  let store: CameraStore | null = null;
  try {
    store = new CameraStore(join(env.dataDir, 'towercab.db'));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'the camera database could not be opened; discovery and poses set in the admin page are unavailable',
    );
  }
  const windy = new WindyImages({ userAgent, fetchImpl, apiKey: () => config.current.secrets.windyApiKey });
  const frames = new FrameChecker({ userAgent, fetchImpl, publicUrl: env.publicUrl });
  const registry = new CameraRegistry({
    config: () => config.current,
    store,
    windyAvailable: () => windy.available,
    frameBlocked: (url) => frames.cached(url),
  });
  const proxy = new CameraProxy({
    rules: () => registry.rules(),
    allowPrivateAddresses: () => config.current.proxy.allowPrivateAddresses,
    userAgent,
  });
  const go2rtc = new Go2rtcBridge({
    url: () => config.current.go2rtc.url,
    allowed: (stream) => registry.go2rtcStream(stream),
    userAgent,
    fetchImpl,
    log: logger,
  });
  const discovery = store
    ? new DiscoveryService({ config: () => config.current, store, userAgent, fetchImpl, log: logger })
    : null;
  return { registry, store, proxy, windy, frames, go2rtc, discovery };
}
