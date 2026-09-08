/**
 * Provider-agnostic rate limiting (Phase 12) — token bucket per
 * (provider, connection). Prevents one provider/connection from exhausting
 * the OS with aggressive polling or runaway agent loops. Engine-level; the
 * worker pool is protected because every adapter call routes through here.
 */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number; maxPerMinute: number; burst: number }>();

  private bucketFor(key: string, maxPerMinute: number, burst: number) {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: burst, lastRefill: Date.now(), maxPerMinute, burst };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Take one token or return the ms to wait (caller backs off). */
  take(key: string, maxPerMinute: number, burst = Math.max(1, Math.ceil(maxPerMinute / 4))): number {
    const b = this.bucketFor(key, maxPerMinute, burst);
    const now = Date.now();
    const elapsed = now - b.lastRefill;
    if (elapsed > 0) {
      b.tokens = Math.min(b.burst, b.tokens + (elapsed / 60000) * b.maxPerMinute);
      b.lastRefill = now;
    }
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.ceil((1 - b.tokens) / (b.maxPerMinute / 60000));
  }

  /** Retry-After-aware backoff: exponential with jitter, capped. */
  static backoffMs(attempt: number, retryAfterHeaderS?: number | null): number {
    if (retryAfterHeaderS && retryAfterHeaderS > 0) return Math.min(retryAfterHeaderS * 1000, 120_000);
    return Math.min(1000 * 2 ** attempt + Math.random() * 250, 30_000);
  }
}
