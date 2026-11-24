import type { AppConfig } from '../config/schema';
import {
  AGGREGATORS,
  type AggregatorId,
  createAggregatorSource,
  effectiveMinIntervalMs,
} from './aggregators';
import type { FetchLike } from './http';
import { ManagedProvider } from './managed';
import { createOpenSkySource } from './opensky';
import { createReadsbLocalSource } from './readsbLocal';

export interface RegistryDeps {
  userAgent: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** Builds one managed provider per configured source. Disabled sources are built too, so they show in health. */
export function buildProviders(config: AppConfig, deps: RegistryDeps): ManagedProvider[] {
  const { providers, secrets } = config;
  const common = { userAgent: deps.userAgent, fetchImpl: deps.fetchImpl, now: deps.now };
  const out: ManagedProvider[] = [];

  out.push(
    new ManagedProvider(
      createReadsbLocalSource({
        ...common,
        url: providers.readsb.url,
        stream: providers.readsb.stream,
        log: deps.log,
      }),
      {
        enabled: providers.readsb.enabled,
        priority: providers.readsb.priority,
        // Your own hardware: no limit to respect beyond not hammering it.
        limits: { minIntervalMs: 500 },
        now: deps.now,
      },
    ),
  );

  for (const id of Object.keys(AGGREGATORS) as AggregatorId[]) {
    const def = AGGREGATORS[id];
    const cfg = providers[id];
    const apiKey = id === 'adsblol' ? secrets.adsblolApiKey : undefined;
    // With a key the quota is whatever the key's tier allows; the service reports it in its headers.
    const builtInQuota = 'dailyQuota' in def && !apiKey ? def.dailyQuota : undefined;
    out.push(
      new ManagedProvider(
        createAggregatorSource(def, { ...common, baseUrl: cfg.baseUrl, headers: cfg.headers, apiKey }),
        {
          enabled: cfg.enabled,
          priority: cfg.priority,
          limits: {
            minIntervalMs: effectiveMinIntervalMs(def, cfg.minIntervalMs),
            dailyQuota: cfg.dailyQuota ?? builtInQuota,
          },
          now: deps.now,
        },
      ),
    );
  }

  const hasOpenSkyCredentials = Boolean(secrets.openskyClientId && secrets.openskyClientSecret);
  out.push(
    new ManagedProvider(
      createOpenSkySource({
        ...common,
        clientId: secrets.openskyClientId,
        clientSecret: secrets.openskyClientSecret,
      }),
      {
        enabled: providers.opensky.enabled,
        priority: providers.opensky.priority,
        fallbackOnly: true,
        limits: {
          // Authenticated data has 5 s resolution, anonymous 10 s; asking more often returns the same answer.
          minIntervalMs: hasOpenSkyCredentials ? 5000 : 10_000,
          dailyQuota: hasOpenSkyCredentials ? 4000 : 400,
        },
        now: deps.now,
      },
    ),
  );

  return out.sort((a, b) => a.priority - b.priority);
}

/** Holds the current providers and replaces them when the config changes. */
export class ProviderRegistry {
  private providers: ManagedProvider[] = [];

  constructor(private readonly deps: RegistryDeps) {}

  rebuild(config: AppConfig): void {
    for (const provider of this.providers) provider.close();
    this.providers = buildProviders(config, this.deps);
  }

  list = (): ManagedProvider[] => this.providers;

  close(): void {
    for (const provider of this.providers) provider.close();
    this.providers = [];
  }
}
