import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, LogController } from 'fastify';
import type { Env } from './config/env';
import type { ConfigStore } from './config/loader';
import { findUp } from './util/paths';

export interface AppDeps {
  env: Env;
  config: ConfigStore;
  logger: FastifyBaseLogger;
}

/** Paths that belong to the API surface and must never fall through to the single-page app. */
const NON_SPA_PREFIXES = ['/api/', '/ws', '/healthz', '/metrics', '/cesium/', '/models/', '/assets/'];

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env, config, logger } = deps;
  const startedAt = Date.now();

  const app = Fastify({
    loggerInstance: logger,
    // The app sits behind a reverse proxy; trust X-Forwarded-* for protocol, host and client address.
    trustProxy: true,
    // One log line per request is noise next to static files and health checks; keep it for debugging only.
    logController: new LogController({ disableRequestLogging: !['debug', 'trace'].includes(env.logLevel) }),
  });

  app.get('/healthz', async () => ({
    status: 'ok',
    version: env.version,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    airports: config.current.airports.map((a) => a.icao),
  }));

  const webDist = env.webDist ?? findUp(join('apps', 'web', 'dist'));
  if (webDist && existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      // Vite fingerprints everything under /assets, so those files can be cached forever.
      setHeaders(reply, path) {
        if (path.startsWith(join(webDist, 'assets'))) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
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
