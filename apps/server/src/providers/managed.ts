import type { ProviderHealth, ProviderState } from '@towercab/shared';
import { Backoff } from '../scheduler/backoff';
import { TokenBucket } from '../scheduler/tokenBucket';
import {
  type AdsbProvider,
  type AdsbSource,
  type FetchResult,
  ProviderError,
  type ProviderId,
  type RateInfo,
} from './types';

export interface ProviderLimits {
  /** Shortest gap between requests to this provider, across all airports. */
  minIntervalMs: number;
  /** Requests per day assumed until the service reports its own numbers. */
  dailyQuota?: number;
  /**
   * A daily quota is spent as if it had to last this long. With 500 requests and a 2 hour horizon the gap
   * starts at 14 s and grows as the balance shrinks, so the quota is never run dry.
   */
  quotaHorizonMs?: number;
  /** Requests kept back and never spent. */
  quotaReserve?: number;
}

export interface ManagedProviderOptions {
  enabled: boolean;
  priority: number;
  limits: ProviderLimits;
  /** Only used when every other source is failing (OpenSky). */
  fallbackOnly?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const DAY_MS = 86_400_000;
const DEFAULT_HORIZON_MS = 2 * 60 * 60_000;
const DEFAULT_RESERVE = 5;

/**
 * A data source plus everything that keeps it within its limits: a token bucket shared by all airports,
 * quota pacing, exponential backoff that honours `Retry-After`, and health for the side panel.
 */
export class ManagedProvider implements AdsbProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly enabled: boolean;
  readonly priority: number;
  readonly fallbackOnly: boolean;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bucket: TokenBucket;
  private readonly backoff: Backoff;
  private readonly limits: Required<
    Pick<ProviderLimits, 'minIntervalMs' | 'quotaHorizonMs' | 'quotaReserve'>
  >;

  private quota: { limit?: number; remaining: number; resetAt?: number; reported: boolean } | null;
  private backoffUntil = 0;
  private blockedReason: string | null = null;

  private requests = 0;
  private failures = 0;
  private rateLimited = 0;
  private lastSuccessAt: number | undefined;
  private lastErrorAt: number | undefined;
  private lastError: string | undefined;
  private lastStatus: number | undefined;
  private latencyMs: number | undefined;
  private lastCount: number | undefined;
  /** Count of responses per HTTP status (or error kind), for /metrics and the soak test. */
  readonly outcomes = new Map<string, number>();

  constructor(
    private readonly source: AdsbSource,
    options: ManagedProviderOptions,
  ) {
    this.id = source.id;
    this.label = source.label;
    this.enabled = options.enabled;
    this.priority = options.priority;
    this.fallbackOnly = options.fallbackOnly ?? false;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.limits = {
      minIntervalMs: options.limits.minIntervalMs,
      quotaHorizonMs: options.limits.quotaHorizonMs ?? DEFAULT_HORIZON_MS,
      quotaReserve: options.limits.quotaReserve ?? DEFAULT_RESERVE,
    };
    this.quota = options.limits.dailyQuota
      ? { limit: options.limits.dailyQuota, remaining: options.limits.dailyQuota, reported: false }
      : null;
    this.backoff = new Backoff({ random: options.random });
    this.bucket = new TokenBucket(1, this.currentIntervalMs(), this.now());
  }

  /** True when a request could be made now or soon: enabled, not backing off, not refused, quota left. */
  isUsable(now = this.now()): boolean {
    return this.enabled && now >= this.backoffUntil && !this.quotaExhausted(now);
  }

  /** Milliseconds until the next request may be made. `Infinity` when the provider cannot be used. */
  waitMs(now = this.now()): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY;
    if (this.quotaExhausted(now)) return Number.POSITIVE_INFINITY;
    return Math.max(this.backoffUntil - now, this.bucket.waitMs(now), 0);
  }

  /**
   * Claims the right to make one request. Resolves true when the caller may go ahead (after waiting up to
   * `maxWaitMs` for a token), false when it should skip this provider for now.
   */
  async acquire(maxWaitMs = 0): Promise<boolean> {
    const now = this.now();
    if (!this.isUsable(now)) return false;
    if (this.bucket.waitMs(now) > maxWaitMs) return false;
    const wait = this.bucket.take(now);
    if (wait > 0) await this.sleep(wait);
    return true;
  }

  /** Makes the request and records the outcome. Callers must have called `acquire` first. */
  async fetchArea(lat: number, lon: number, radiusNm: number, signal?: AbortSignal): Promise<FetchResult> {
    const startedAt = this.now();
    this.requests += 1;
    try {
      const result = await this.source.fetchArea(lat, lon, radiusNm, signal);
      this.latencyMs = result.receivedAt - startedAt;
      this.lastSuccessAt = result.receivedAt;
      this.lastStatus = 200;
      this.lastCount = result.observations.length;
      this.blockedReason = null;
      this.backoff.succeed();
      this.backoffUntil = 0;
      this.count('200');
      this.applyRate(result.rate, result.receivedAt, true);
      return result;
    } catch (err) {
      const now = this.now();
      const error =
        err instanceof ProviderError
          ? err
          : new ProviderError('network', (err as Error).message ?? String(err));
      this.failures += 1;
      this.lastErrorAt = now;
      this.lastError = error.message;
      this.lastStatus = error.status;
      this.count(error.status ? String(error.status) : error.kind);
      if (error.kind === 'rate_limited') this.rateLimited += 1;
      this.blockedReason = error.kind === 'forbidden' ? error.message : null;
      this.backoffUntil = now + this.backoff.fail(error.kind, error.retryAfterMs);
      this.applyRate(error.details.rate, now, false);
      throw error;
    }
  }

  health(): ProviderHealth {
    const now = this.now();
    const health: ProviderHealth = {
      id: this.id,
      label: this.label,
      enabled: this.enabled,
      state: this.state(now),
      priority: this.priority,
      requests: this.requests,
      failures: this.failures,
      rateLimited: this.rateLimited,
    };
    if (this.lastSuccessAt !== undefined) health.lastSuccessAt = this.lastSuccessAt;
    if (this.lastErrorAt !== undefined) health.lastErrorAt = this.lastErrorAt;
    if (this.lastError !== undefined && this.backoff.consecutiveFailures > 0)
      health.lastError = this.lastError;
    if (this.lastStatus !== undefined) health.lastStatus = this.lastStatus;
    if (this.latencyMs !== undefined) health.latencyMs = this.latencyMs;
    if (this.lastCount !== undefined) health.lastCount = this.lastCount;
    if (this.quota?.reported) {
      health.quota = { remaining: this.quota.remaining };
      if (this.quota.limit !== undefined) health.quota.limit = this.quota.limit;
      if (this.quota.resetAt !== undefined) health.quota.resetAt = this.quota.resetAt;
    }
    if (this.backoffUntil > now) health.backoffUntil = this.backoffUntil;
    return health;
  }

  close(): void {
    this.source.close?.();
  }

  private state(now: number): ProviderState {
    if (!this.enabled) return 'disabled';
    if (this.blockedReason || this.quotaExhausted(now)) return 'blocked';
    if (now < this.backoffUntil) return 'backoff';
    if (this.requests === 0) return 'idle';
    if (this.backoff.consecutiveFailures > 0) return 'degraded';
    return 'ok';
  }

  private count(key: string): void {
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
  }

  private quotaExhausted(now: number): boolean {
    const q = this.quota;
    if (!q) return false;
    if (q.resetAt !== undefined && now >= q.resetAt) return false;
    return q.remaining <= this.limits.quotaReserve;
  }

  /** Gap between requests right now: the rate limit, or longer when a daily quota has to be stretched. */
  private currentIntervalMs(): number {
    const q = this.quota;
    if (!q) return this.limits.minIntervalMs;
    const now = this.now();
    const spendable = q.remaining - this.limits.quotaReserve;
    if (spendable <= 0) return this.limits.minIntervalMs;
    const untilReset = q.resetAt !== undefined ? Math.max(0, q.resetAt - now) : DAY_MS;
    const horizon = Math.min(untilReset, this.limits.quotaHorizonMs);
    return Math.max(this.limits.minIntervalMs, Math.ceil(horizon / spendable));
  }

  private applyRate(rate: RateInfo | undefined, now: number, success: boolean): void {
    if (rate?.remaining !== undefined) {
      this.quota = {
        limit: rate.limit ?? this.quota?.limit,
        remaining: rate.remaining,
        resetAt: rate.resetAt ?? this.quota?.resetAt,
        reported: true,
      };
    } else if (this.quota && success) {
      // The service did not say: count the request against the assumed quota ourselves.
      if (this.quota.resetAt !== undefined && now >= this.quota.resetAt) {
        this.quota = {
          limit: this.quota.limit,
          remaining: this.quota.limit ?? this.quota.remaining,
          reported: false,
        };
      }
      this.quota.remaining = Math.max(0, this.quota.remaining - 1);
    }
    if (this.quota) this.bucket.setRefillInterval(this.currentIntervalMs(), now);
  }
}
