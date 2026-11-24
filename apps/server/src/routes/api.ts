import { type ClientConfig, IcaoSchema } from '@towercab/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Services } from '../services';
import { renderMetrics } from './metrics';

const HEX = /^~?[0-9a-f]{6}$/i;

/** Credit lines for the data sources that are switched on. Imagery credits come from Cesium itself. */
export function buildAttributions(services: Services): ClientConfig['attributions'] {
  const { providers, photos } = services.config.current;
  const list: ClientConfig['attributions'] = [];
  if (providers.adsbfi.enabled) list.push({ name: 'adsb.fi', url: 'https://adsb.fi', note: 'open data' });
  if (providers.adsblol.enabled) list.push({ name: 'adsb.lol', url: 'https://adsb.lol', note: 'ODbL' });
  if (providers.airplaneslive.enabled) list.push({ name: 'airplanes.live', url: 'https://airplanes.live' });
  if (providers.opensky.enabled)
    list.push({ name: 'The OpenSky Network', url: 'https://opensky-network.org' });
  list.push({
    name: 'OpenStreetMap contributors',
    url: 'https://www.openstreetmap.org/copyright',
    note: 'ODbL',
  });
  list.push({ name: 'OurAirports', url: 'https://ourairports.com/data/' });
  list.push({ name: 'aviationweather.gov', url: 'https://aviationweather.gov' });
  if (photos.enabled) list.push({ name: 'planespotters.net', url: 'https://www.planespotters.net' });
  // Camera providers are credited when one of their cameras is actually shown.
  const shown = services.cameras.registry.providersInUse();
  if (shown.has('windy'))
    list.push({ name: 'Windy.com', url: 'https://www.windy.com/webcams', note: 'webcams' });
  if (shown.has('youtube')) list.push({ name: 'YouTube', url: 'https://www.youtube.com' });
  return list;
}

export function registerApiRoutes(app: FastifyInstance, services: Services): void {
  const { airports, live, metar, config, env } = services;

  /** Resolves the `:icao` parameter to a configured airport code, or answers 404 and returns null. */
  const airportParam = (raw: string, reply: FastifyReply): string | null => {
    const parsed = IcaoSchema.safeParse(raw);
    if (!parsed.success || !airports.isConfigured(parsed.data)) {
      void reply.code(404).send({ error: 'unknown_airport', message: `${raw} is not a configured airport` });
      return null;
    }
    return parsed.data;
  };

  app.get('/api/airports', async () => airports.list());

  app.get<{ Params: { icao: string } }>('/api/airports/:icao', async (request, reply) => {
    const icao = airportParam(request.params.icao, reply);
    if (!icao) return reply;
    const detail = await airports.detail(icao);
    if (!detail) {
      return reply.code(503).send({
        error: 'airport_unavailable',
        message: `Reference data for ${icao} could not be loaded. Check the server log.`,
      });
    }
    return detail;
  });

  app.get('/api/client-config', async (_request, reply): Promise<ClientConfig> => {
    const current = config.current;
    const { secrets } = current;
    void reply.header('Cache-Control', 'no-store');
    return {
      version: env.version,
      cesiumIonToken: secrets.cesiumIonToken ?? null,
      googleMapsApiKey: secrets.googleMapsApiKey ?? null,
      features: {
        photoreal: Boolean(secrets.cesiumIonToken || secrets.googleMapsApiKey),
        terrain: Boolean(secrets.cesiumIonToken),
        cameras: services.cameras.registry.any(),
        admin: Boolean(secrets.adminToken),
        photos: current.photos.enabled,
      },
      renderDelayMs: current.client.renderDelayMs,
      attributions: buildAttributions(services),
    };
  });

  app.get<{ Params: { icao: string } }>('/api/metar/:icao', async (request, reply) => {
    const icao = airportParam(request.params.icao, reply);
    if (!icao) return reply;
    return { metar: await metar.get(icao) };
  });

  app.get<{ Params: { icao: string } }>('/api/status/:icao', async (request, reply) => {
    const icao = airportParam(request.params.icao, reply);
    if (!icao) return reply;
    return live.status(icao);
  });

  app.get<{ Params: { hex: string } }>('/api/photos/:hex', async (request, reply) => {
    if (!config.current.photos.enabled) return reply.code(404).send({ error: 'photos_disabled' });
    const hex = request.params.hex;
    // TIS-B track files (`~` addresses) are not real airframes; there is nothing to look up.
    if (!HEX.test(hex) || hex.startsWith('~')) return { photo: null };
    void reply.header('Cache-Control', 'public, max-age=3600');
    return { photo: await services.photos.get(hex) };
  });

  app.get('/metrics', async (_request, reply) => {
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderMetrics(services));
  });
}
