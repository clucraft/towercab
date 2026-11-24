import type { ProviderErrorKind } from '../providers/types';

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of random extra delay, so many instances do not retry in step. */
  jitter?: number;
  random?: () => number;
}

/**
 * Shortest wait per failure kind. Retrying a refusal or a malformed request cannot succeed, and adsb.fi
 * counts 400/401/403/404/429 answers towards a temporary IP ban, so those wait much longer.
 */
const FLOOR_MS: Record<ProviderErrorKind, number> = {
  rate_limited: 30_000,
  forbidden: 60 * 60_000,
  bad_request: 10 * 60_000,
  server: 0,
  network: 0,
  timeout: 0,
  parse: 0,
};

/** Exponential backoff: base, 2x, 4x … up to a cap. A `Retry-After` from the service always wins if longer. */
export class Backoff {
  private failures = 0;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly jitter: number;
  private readonly random: () => number;

  constructor(options: BackoffOptions = {}) {
    this.baseMs = options.baseMs ?? 2000;
    this.maxMs = options.maxMs ?? 5 * 60_000;
    this.jitter = options.jitter ?? 0.2;
    this.random = options.random ?? Math.random;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Records a failure and returns how long to wait before trying again. */
  fail(kind: ProviderErrorKind, retryAfterMs?: number): number {
    this.failures += 1;
    const exponential = Math.min(this.maxMs, this.baseMs * 2 ** (this.failures - 1));
    const withJitter = exponential * (1 + this.jitter * this.random());
    return Math.round(Math.max(withJitter, FLOOR_MS[kind], retryAfterMs ?? 0));
  }

  succeed(): void {
    this.failures = 0;
  }
}
