/**
 * Token-bucket rate limits for the player API (per session, or per client IP before sign-in). In memory and
 * bounded: when the key table is full the least recently refilled keys are dropped, which can only make a
 * limit more lenient for an idle key, never block anyone permanently.
 */
export type RateBucket = 'nonce' | 'verify' | 'session' | 'bet' | 'read' | 'withdraw' | 'dev-wallet';

export interface RateLimit { readonly limit: number; readonly windowMs: number }

/** Requests per window. Placement allows bursts of fast taps; sign-in and withdrawals are slower. */
export const DEFAULT_RATE_LIMITS: Readonly<Record<RateBucket, RateLimit>> = Object.freeze({
  nonce: { limit: 30, windowMs: 60_000 },
  verify: { limit: 20, windowMs: 60_000 },
  session: { limit: 120, windowMs: 60_000 },
  bet: { limit: 40, windowMs: 10_000 },
  read: { limit: 300, windowMs: 60_000 },
  withdraw: { limit: 20, windowMs: 60_000 },
  'dev-wallet': { limit: 600, windowMs: 60_000 },
});

interface Bucket { tokens: number; at: number }

export class RateLimiter {
  private readonly limits: Record<RateBucket, RateLimit>;
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(options: { now?: () => number; limits?: Partial<Record<RateBucket, RateLimit>>; maxKeys?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 50_000;
    this.limits = { ...DEFAULT_RATE_LIMITS, ...(options.limits ?? {}) };
    for (const [name, l] of Object.entries(this.limits)) if (!(l.limit > 0) || !(l.windowMs > 0)) throw new Error(`Invalid rate limit ${name}`);
  }

  /** Take one token; `retryAfterMs` is the wait for the next token when refused. */
  take(bucket: RateBucket, key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const { limit, windowMs } = this.limits[bucket];
    const id = `${bucket}|${key}`;
    const now = this.now();
    const rate = limit / windowMs;
    let b = this.buckets.get(id);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) { const oldest = this.buckets.keys().next().value; if (oldest !== undefined) this.buckets.delete(oldest); }
      b = { tokens: limit, at: now };
    } else {
      this.buckets.delete(id); // re-insert below: Map order doubles as least-recently-used order
      b.tokens = Math.min(limit, b.tokens + Math.max(0, now - b.at) * rate);
      b.at = now;
    }
    this.buckets.set(id, b);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / rate) };
  }
}
