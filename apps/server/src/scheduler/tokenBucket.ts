/**
 * Token bucket. One token is one upstream request; tokens refill at one per `refillIntervalMs`.
 * A provider has a single bucket shared by every airport, so the service's rate limit holds no matter how
 * many airports are being watched.
 *
 * `take` may be called when the bucket is empty: it reserves the next token and returns how long the caller
 * has to wait for it. That lets a poll that is a few hundred milliseconds early wait instead of being skipped,
 * while two callers can never be handed the same token.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private refillIntervalMs: number,
    now: number,
  ) {
    if (capacity < 1) throw new RangeError('capacity must be at least 1');
    if (refillIntervalMs <= 0) throw new RangeError('refillIntervalMs must be positive');
    this.tokens = capacity;
    this.updatedAt = now;
  }

  get intervalMs(): number {
    return this.refillIntervalMs;
  }

  /** Milliseconds until a token is available. 0 means one is available now. */
  waitMs(now: number): number {
    this.refill(now);
    if (this.tokens >= 1) return 0;
    // Fractions of a token carry rounding noise: 100.0000000001 ms is 100 ms, not 101. Rounding one wait up
    // by a millisecond would leave the next request a millisecond short of the interval after it.
    return Math.ceil((1 - this.tokens) * this.refillIntervalMs - 1e-6);
  }

  /** Takes a token, reserving a future one if the bucket is empty. Returns the wait in milliseconds. */
  take(now: number): number {
    const wait = this.waitMs(now);
    this.tokens -= 1;
    return wait;
  }

  /** Changes the refill rate, keeping the tokens earned so far. */
  setRefillInterval(refillIntervalMs: number, now: number): void {
    if (refillIntervalMs <= 0) throw new RangeError('refillIntervalMs must be positive');
    if (refillIntervalMs === this.refillIntervalMs) return;
    this.refill(now);
    this.refillIntervalMs = refillIntervalMs;
  }

  private refill(now: number): void {
    if (now <= this.updatedAt) return;
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) / this.refillIntervalMs);
    this.updatedAt = now;
  }
}
