import { createHash, timingSafeEqual } from 'node:crypto';
import { AdminCameraPatchSchema, type AdminState, IcaoSchema } from '@towercab/shared';
import type { FastifyInstance } from 'fastify';
import { WINDY_SOURCE } from '../config/schema';
import type { Services } from '../services';

const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;

const digest = (text: string) => createHash('sha256').update(text).digest();
/** Compares two secrets without revealing, through timing, how much of a guess was right. */
const sameSecret = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

/**
 * The admin API behind the `/admin` page: the camera queue, discovery and poses.
 *
 * It exists only while an admin token is set. Without one every path below answers exactly like a path
 * that was never there. With one, each request must carry the token as a bearer token; a browser cannot be
 * made to send that by another site, so there is no cross-site request to defend against.
 */
export function registerAdminRoutes(app: FastifyInstance, services: Services): void {
  const { config, airports, env, logger } = services;
  const { registry, store, discovery, windy } = services.cameras;
  const failures = new Map<string, { count: number; resetAt: number }>();

  void app.register(
    async (admin) => {
      admin.addHook('onRequest', async (request, reply) => {
        const token = config.current.secrets.adminToken;
        if (!token) {
          return reply.code(404).send({
            error: 'not_found',
            message: `No route for ${request.method} ${request.url.split('?')[0]}`,
          });
        }
        void reply.header('Cache-Control', 'no-store');
        const now = Date.now();
        const record = failures.get(request.ip);
        if (record && record.resetAt <= now) failures.delete(request.ip);
        const blocked = failures.get(request.ip);
        if (blocked && blocked.count >= MAX_FAILURES) {
          return reply
            .code(429)
            .header('Retry-After', Math.ceil((blocked.resetAt - now) / 1000))
            .send({ error: 'too_many_attempts', message: 'Too many wrong tokens. Try again later.' });
        }
        const header = request.headers.authorization ?? '';
        const given = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
        if (!given || !sameSecret(given, token)) {
          const entry = failures.get(request.ip) ?? { count: 0, resetAt: now + FAILURE_WINDOW_MS };
          entry.count += 1;
          failures.set(request.ip, entry);
          if (given) logger.warn({ ip: request.ip }, 'admin: wrong token');
          return reply
            .code(401)
            .header('WWW-Authenticate', 'Bearer')
            .send({ error: 'unauthorized', message: 'The admin token is missing or wrong.' });
        }
      });

      const state = (): AdminState => {
        const current = config.current;
        return {
          version: env.version,
          airports: airports.list().map((a) => ({ icao: a.icao, name: a.name })),
          discovery: {
            enabled: current.discovery.enabled,
            intervalHours: current.discovery.intervalHours,
            youtube: Boolean(current.secrets.youtubeApiKey),
            windy: Boolean(current.secrets.windyApiKey),
          },
          cameras: registry.adminList(),
          runs: store?.runs() ?? [],
          proxyAllowlist: current.proxy.allowlist,
          go2rtc: Boolean(current.go2rtc.url),
        };
      };

      const needStore = () => {
        if (store) return store;
        throw Object.assign(new Error('The camera database could not be opened. See the server log.'), {
          statusCode: 503,
        });
      };

      admin.get('/state', async () => state());

      admin.post<{ Params: { icao: string } }>('/discovery/:icao', async (request, reply) => {
        needStore();
        const icao = IcaoSchema.safeParse(request.params.icao);
        const airport = icao.success ? airports.list().find((a) => a.icao === icao.data) : undefined;
        if (!airport) {
          return reply.code(404).send({ error: 'unknown_airport', message: 'Not a configured airport' });
        }
        if (!discovery)
          return reply.code(503).send({ error: 'unavailable', message: 'Discovery is unavailable.' });
        try {
          const outcomes = await discovery.run({
            icao: airport.icao,
            name: airport.name,
            city: airport.city ?? undefined,
            lat: airport.lat,
            lon: airport.lon,
          });
          return { outcomes, state: state() };
        } catch (err) {
          return reply.code(409).send({ error: 'not_run', message: (err as Error).message });
        }
      });

      admin.patch<{ Params: { id: string } }>('/cameras/:id', async (request, reply) => {
        const db = needStore();
        const patch = AdminCameraPatchSchema.safeParse(request.body);
        if (!patch.success) {
          return reply
            .code(400)
            .send({ error: 'bad_request', message: patch.error.issues[0]?.message ?? 'Invalid' });
        }
        const camera = registry.adminList().find((c) => c.id === request.params.id);
        if (!camera) return reply.code(404).send({ error: 'not_found', message: 'No such camera' });
        const { pose, ...rest } = patch.data;
        if (camera.origin === 'config' && Object.keys(rest).length > 0) {
          return reply.code(409).send({
            error: 'config_camera',
            message:
              'This camera comes from the config file. Only its pose can be set here; change the rest there.',
          });
        }
        if (camera.origin === 'discovery') db.update(camera.id, rest);
        if (pose !== undefined) db.setPose(camera.id, pose, Date.now());
        logger.info({ camera: camera.id, change: Object.keys(patch.data) }, 'admin: camera changed');
        return state();
      });

      // A current picture for a queue entry. Windy's image addresses expire, so the stored one cannot be used.
      admin.get<{ Params: { id: string } }>('/cameras/:id/preview', async (request, reply) => {
        const camera = registry.adminList().find((c) => c.id === request.params.id);
        if (!camera) return reply.code(404).send({ error: 'not_found', message: 'No such camera' });
        const webcamId = WINDY_SOURCE.exec(camera.source)?.[1];
        if (!webcamId) return { url: camera.thumbnail ?? null };
        try {
          return { url: await windy.imageUrl(webcamId) };
        } catch {
          return { url: null };
        }
      });
    },
    { prefix: '/admin/api' },
  );
}
