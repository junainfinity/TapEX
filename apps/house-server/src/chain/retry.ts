export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Capped exponential backoff: base·2^(attempt−1), attempt ≥ 1. Deterministic (no jitter) for testability. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  if (attempt <= 0) return 0;
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
}

export interface RetryOptions {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean;
  readonly onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  readonly sleep?: Sleep;
}

/** Runs `fn` up to `attempts` times, backing off between failures; rethrows the last error. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? realSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= options.attempts || (options.shouldRetry && !options.shouldRetry(error, attempt))) throw error;
      const delay = backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
}
