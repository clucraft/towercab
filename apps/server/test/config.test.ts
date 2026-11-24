import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEnv } from '../src/config/env';
import { ConfigError, ConfigStore, parseConfig } from '../src/config/loader';
import { findUp } from '../src/util/paths';

const exampleFile = findUp(join('config', 'config.example.yaml'));

describe('example config', () => {
  it('is found and validates', async () => {
    expect(exampleFile).not.toBeNull();
    const config = parseConfig(await readFile(exampleFile as string, 'utf8'));
    expect(config.airports.map((a) => a.icao)).toEqual(['KLAF', 'KIND']);
    expect(config.providers.adsblol).toMatchObject({ enabled: true, priority: 1 });
    expect(config.providers.readsb.enabled).toBe(false);
    expect(config.providers.opensky.enabled).toBe(false);
    expect(config.polling.activeIntervalMs).toBe(2000);
    expect(config.cameras).toEqual([]);
  });
});

describe('parseConfig', () => {
  it('fills defaults from a minimal file', () => {
    const config = parseConfig('airports:\n  - icao: klaf\n');
    expect(config.airports[0]).toMatchObject({ icao: 'KLAF', radiusNm: 6, ceilingFtAgl: 5000, tower: null });
    expect(config.polling).toEqual({
      activeIntervalMs: 2000,
      idleIntervalMs: 60_000,
      pauseWhenNoViewersAfterMs: 300_000,
      secondaryEveryN: 3,
    });
    expect(config.providers.airplaneslive.priority).toBe(2);
    expect(config.proxy.allowlist).toEqual([]);
  });

  it('rejects an empty airport list, duplicates and bad YAML with readable errors', () => {
    expect(() => parseConfig('airports: []')).toThrow(ConfigError);
    expect(() => parseConfig('airports:\n  - icao: KLAF\n  - icao: klaf\n')).toThrow(
      /duplicate airport KLAF/,
    );
    expect(() => parseConfig('airports: [')).toThrow(/not valid YAML/);
  });

  it('rejects a camera that points at an unknown airport', () => {
    const yaml = `
airports:
  - icao: KLAF
cameras:
  - { id: ramp, airport: KIND, name: Ramp, kind: hls, source: "https://example.test/live.m3u8" }
`;
    expect(() => parseConfig(yaml)).toThrow(/not a configured airport/);
  });

  it('lets environment secrets override the file', () => {
    const yaml =
      'airports:\n  - icao: KLAF\nsecrets:\n  cesiumIonToken: from-file\n  adminToken: file-admin\n';
    const config = parseConfig(yaml, { cesiumIonToken: 'from-env', adminToken: undefined });
    expect(config.secrets.cesiumIonToken).toBe('from-env');
    expect(config.secrets.adminToken).toBe('file-admin');
  });
});

describe('readEnv', () => {
  it('applies defaults and treats blank values as unset', () => {
    const env = readEnv({
      NODE_ENV: 'production',
      PORT: '',
      ADMIN_TOKEN: '  ',
      PUBLIC_URL: 'https://tower.example.test/',
    });
    expect(env.port).toBe(8790);
    expect(env.configDir).toBe('/config');
    expect(env.dataDir).toBe('/data');
    expect(env.secrets.adminToken).toBeUndefined();
    expect(env.publicUrl).toBe('https://tower.example.test');
    expect(env.production).toBe(true);
  });

  it('uses a local folder in development and honours explicit directories', () => {
    const dev = readEnv({});
    expect(dev.production).toBe(false);
    expect(dev.configDir).toMatch(/\.local[\\/]config$/);
    expect(dev.dataDir).toMatch(/\.local[\\/]data$/);
    expect(readEnv({ CONFIG_DIR: '/srv/cfg', DATA_DIR: '/srv/data' })).toMatchObject({
      configDir: '/srv/cfg',
      dataDir: '/srv/data',
    });
  });

  it('rejects a port that is not a port', () => {
    expect(() => readEnv({ PORT: '99999' })).toThrow();
  });
});

describe('ConfigStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'towercab-config-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('copies the example config on first start', async () => {
    const store = await ConfigStore.open({ configDir: join(dir, 'nested'), exampleFile });
    expect(store.current.airports).toHaveLength(2);
    expect(await readFile(store.file, 'utf8')).toBe(await readFile(exampleFile as string, 'utf8'));
  });

  it('fails clearly when there is no config and no example', async () => {
    await expect(ConfigStore.open({ configDir: dir, exampleFile: null })).rejects.toThrow(ConfigError);
  });

  it('reloads a valid edit and emits change', async () => {
    const store = await ConfigStore.open({ configDir: dir, exampleFile });
    const changes: string[][] = [];
    store.on('change', (next) => changes.push(next.airports.map((a) => a.icao)));

    await writeFile(store.file, 'airports:\n  - icao: KORD\n');
    await store.reload();

    expect(store.current.airports.map((a) => a.icao)).toEqual(['KORD']);
    expect(changes).toEqual([['KORD']]);
  });

  it('keeps the previous config when an edit is invalid', async () => {
    const errors: string[] = [];
    const store = await ConfigStore.open({
      configDir: dir,
      exampleFile,
      log: { info() {}, warn() {}, error: (_o, msg) => errors.push(msg) },
    });
    let changed = false;
    store.on('change', () => {
      changed = true;
    });

    await writeFile(store.file, 'airports: "not a list"\n');
    await store.reload();

    expect(store.current.airports).toHaveLength(2);
    expect(changed).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('does not emit change when the file content is equivalent', async () => {
    const store = await ConfigStore.open({ configDir: dir, exampleFile });
    let changed = false;
    store.on('change', () => {
      changed = true;
    });
    await writeFile(store.file, `${await readFile(store.file, 'utf8')}\n# a comment\n`);
    await store.reload();
    expect(changed).toBe(false);
  });
});
