import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { registerApiRoutes } from './routes/api';
import type { Services } from './services';
import { findUp } from './util/paths';

/** Paths that belong to the API surface and must never fall through to the single-page app. */
const NON_SPA_PREFIXES = ['/api/', '/ws', '/healthz', '/metrics', '/cesium/', '/models/', '/assets/'];

export async function buildApp(services: Services): Promise<FastifyInstance> {
  const { env, config, logger } = services;
  const startedAt = Date.now();

  const app = Fastify({
    loggerInstance: logger,
    // The app sits behind a reverse proxy; trust X-Forwarded-* for protocol, host and client address.
    trustProxy: true,
    // One log line per request is noise next to static files and health checks; keep it for debugging only.
    logController: new LogController({ disableRequestLogging: !['debug', 'trace'].includes(env.logLevel) }),
  });

  const webDist = env.webDist ?? findUp(join('apps', 'web', 'dist'));

  app.get('/healthz', async () => ({
    status: 'ok',
    version: env.version,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    airports: config.current.airports.map((a) => a.icao),
  }));

  registerApiRoutes(app, services);
  services.hub.attach(app.server);
  app.addHook('onClose', async () => services.close());

  // A model placed in /data/models replaces the built-in one of the same name.
  const modelOverrides = join(env.dataDir, 'models');
  app.get<{ Params: { file: string } }>('/models/:file', async (request, reply) => {
    const { file } = request.params;
    if (!/^[a-z0-9-]+\.glb$/.test(file)) return reply.code(404).send({ error: 'not_found' });
    for (const dir of [modelOverrides, webDist ? join(webDist, 'models') : null]) {
      if (!dir) continue;
      try {
        const body = await readFile(join(dir, file));
        return reply.type('model/gltf-binary').header('Cache-Control', 'public, max-age=3600').send(body);
      } catch {
        // not in this directory
      }
    }
    return reply.code(404).send({ error: 'not_found', message: `No model named ${file}` });
  });

  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      setHeaders(reply, path) {
        // Vite fingerprints everything under /assets, so those files can be cached forever.
        if (path.startsWith(join(webDist, 'assets'))) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (path.startsWith(join(webDist, 'cesium'))) {
          // The assets Cesium loads at run time change only with a Cesium upgrade.
          reply.header('Cache-Control', 'public, max-age=86400');
        } else if (path.endsWith('index.html')) {
          reply.header('Cache-Control', 'no-cache');
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0] ?? '/';
      const isSpaRoute =
        request.method === 'GET' && !NON_SPA_PREFIXES.some((p) => path === p || path.startsWith(p));
      if (isSpaRoute) {
        return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found', message: `No route for ${request.method} ${path}` });
    });
  } else {
    logger.warn({ webDist }, 'web app build not found; serving the API only');
    app.get('/', async (_request, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><title>TowerCab</title><p>TowerCab server is running. The web app has not been built.</p>',
        ),
    );
  }

  return app;
}
