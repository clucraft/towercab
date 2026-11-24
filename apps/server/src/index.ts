import { join } from 'node:path';
import pino from 'pino';
import { buildApp } from './app';
import { readEnv } from './config/env';
import { ConfigStore } from './config/loader';
import { createServices } from './services';
import { findUp } from './util/paths';

async function main(): Promise<void> {
  const env = readEnv();
  const logger = pino({
    level: env.logLevel,
    // JSON in production; readable lines on a developer terminal.
    transport: env.production ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
    // Tokens travel in config and request headers; make sure none of them can reach a log line.
    redact: ['secrets', '*.secrets', 'req.headers.authorization', 'req.headers["x-admin-token"]'],
  });

  const config = await ConfigStore.open({
    configDir: env.configDir,
    exampleFile: findUp(join('config', 'config.example.yaml')),
    envSecrets: env.secrets,
    log: logger,
  });
  config.watch();

  const services = await createServices({ env, logger, config });
  const app = await buildApp(services);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    config.close();
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: env.port });
  logger.info(
    {
      version: env.version,
      airports: services.airports.list().map((a) => `${a.icao}${a.available ? '' : ' (no data)'}`),
      sources: services.providers
        .list()
        .filter((p) => p.enabled)
        .map((p) => p.id),
      configFile: config.file,
      dataDir: env.dataDir,
    },
    'TowerCab is up',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
