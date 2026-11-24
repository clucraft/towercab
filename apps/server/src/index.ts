import { join } from 'node:path';
import pino from 'pino';
import { buildApp } from './app';
import { readEnv } from './config/env';
import { ConfigStore } from './config/loader';
import { findUp } from './util/paths';

async function main(): Promise<void> {
  const env = readEnv();
  const logger = pino({
    level: env.logLevel,
    // JSON in production; readable lines on a developer terminal.
    transport: env.production ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
  });

  const config = await ConfigStore.open({
    configDir: env.configDir,
    exampleFile: findUp(join('config', 'config.example.yaml')),
    envSecrets: env.secrets,
    log: logger,
  });
  config.watch();

  const app = await buildApp({ env, config, logger });

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
    { version: env.version, airports: config.current.airports.map((a) => a.icao), configFile: config.file },
    'TowerCab is up',
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
