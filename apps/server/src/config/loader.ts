import { EventEmitter } from 'node:events';
import { type Stats, unwatchFile, watchFile } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Secrets } from './schema';
import { type AppConfig, ConfigFileSchema } from './schema';

export interface ConfigLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ConfigStoreOptions {
  /** Directory that holds `config.yaml`. Created if missing. */
  configDir: string;
  /** Example file copied in on first start when `config.yaml` does not exist. */
  exampleFile: string | null;
  /** Secrets from the environment; they win over the config file. */
  envSecrets?: Secrets;
  log?: ConfigLogger;
  /** Stat polling interval for hot reload. Polling works on bind mounts and FUSE shares where inotify does not. */
  watchIntervalMs?: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses YAML text into a validated config, with a readable error when it is wrong. */
export function parseConfig(text: string, envSecrets: Secrets = {}): AppConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(`config.yaml is not valid YAML: ${(err as Error).message}`);
  }
  const result = ConfigFileSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new ConfigError(`config.yaml is invalid:\n${z.prettifyError(result.error)}`);
  }
  const config = result.data;
  const secrets: Secrets = { ...config.secrets };
  for (const [key, value] of Object.entries(envSecrets) as [keyof Secrets, string | undefined][]) {
    if (value !== undefined && value !== '') secrets[key] = value;
  }
  return { ...config, secrets };
}

export interface ConfigStoreEvents {
  change: [next: AppConfig, previous: AppConfig];
}

/**
 * Owns the current config. Reloads when the file changes; an invalid edit is logged and ignored so a typo
 * cannot take a running server down.
 */
export class ConfigStore extends EventEmitter<ConfigStoreEvents> {
  readonly file: string;
  private currentConfig: AppConfig;
  private watching = false;
  private reloading: Promise<void> = Promise.resolve();

  private constructor(
    file: string,
    initial: AppConfig,
    private readonly options: ConfigStoreOptions,
  ) {
    super();
    this.file = file;
    this.currentConfig = initial;
  }

  static async open(options: ConfigStoreOptions): Promise<ConfigStore> {
    const file = join(options.configDir, 'config.yaml');
    await mkdir(options.configDir, { recursive: true });
    if (!(await exists(file))) {
      if (!options.exampleFile) {
        throw new ConfigError(`${file} does not exist and no example config was found to copy`);
      }
      // Written rather than copied so the new file gets normal permissions, whatever the example's mode is.
      await writeFile(file, await readFile(options.exampleFile), { mode: 0o644, flag: 'wx' });
      options.log?.info({ file }, 'no config found, copied the example config');
    }
    const initial = parseConfig(await readFile(file, 'utf8'), options.envSecrets);
    return new ConfigStore(file, initial, options);
  }

  get current(): AppConfig {
    return this.currentConfig;
  }

  /** Re-reads the file now. Resolves once the reload (or its rejection) has been handled. */
  reload(): Promise<void> {
    this.reloading = this.reloading.then(async () => {
      try {
        const next = parseConfig(await readFile(this.file, 'utf8'), this.options.envSecrets);
        if (JSON.stringify(next) === JSON.stringify(this.currentConfig)) return;
        const previous = this.currentConfig;
        this.currentConfig = next;
        this.options.log?.info({ file: this.file }, 'config reloaded');
        this.emit('change', next, previous);
      } catch (err) {
        this.options.log?.error(
          { file: this.file, err: (err as Error).message },
          'config reload failed, keeping the previous config',
        );
      }
    });
    return this.reloading;
  }

  watch(): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.file, { interval: this.options.watchIntervalMs ?? 3000, persistent: false }, this.onStat);
  }

  close(): void {
    if (!this.watching) return;
    this.watching = false;
    unwatchFile(this.file, this.onStat);
  }

  private onStat = (curr: Stats, prev: Stats): void => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (curr.mtimeMs === 0) {
      this.options.log?.warn({ file: this.file }, 'config file disappeared, keeping the previous config');
      return;
    }
    void this.reload();
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
