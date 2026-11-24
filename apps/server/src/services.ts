import type { FastifyBaseLogger } from 'fastify';
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
  /** Stops polling, closes sockets and file watchers. */
  close(): void;
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
  const hub = new WsHub({ live, airports, version: env.version, log: logger });

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
    close() {
      config.off('change', onConfigChange);
      hub.close();
      live.stop();
      providers.close();
    },
  };
}
