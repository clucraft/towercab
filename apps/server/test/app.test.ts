import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { readEnv } from '../src/config/env';
import { ConfigStore } from '../src/config/loader';
import { findUp } from '../src/util/paths';

describe('app', () => {
  let dir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'towercab-app-'));
    const webDist = join(dir, 'web');
    await mkdir(join(webDist, 'assets'), { recursive: true });
    await writeFile(join(webDist, 'index.html'), '<!doctype html><title>TowerCab</title>');
    await writeFile(join(webDist, 'assets', 'app.js'), 'console.log(1)');

    const env = readEnv({ CONFIG_DIR: join(dir, 'config'), DATA_DIR: join(dir, 'data'), WEB_DIST: webDist });
    const config = await ConfigStore.open({
      configDir: env.configDir,
      exampleFile: findUp(join('config', 'config.example.yaml')),
    });
    app = await buildApp({ env, config, logger: pino({ level: 'silent' }) });
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers /healthz', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', airports: ['KLAF', 'KIND'] });
  });

  it('serves the web app and falls back to index.html for app routes', async () => {
    for (const url of ['/', '/KLAF', '/KIND?view=tower&mode=schematic', '/debug/KLAF']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toContain('text/html');
    }
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');
  });

  it('returns JSON 404 for unknown API routes instead of the app shell', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_found' });
    const missingAsset = await app.inject({ method: 'GET', url: '/assets/missing.js' });
    expect(missingAsset.statusCode).toBe(404);
  });
});
