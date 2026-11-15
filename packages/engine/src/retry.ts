export interface RetryOptions {
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  backoffMultiplier?: number;
  randomFn?: () => number;
}

/**
 * Calculates exponential backoff with full jitter:
 * ceiling = min(maxBackoff, initialBackoff * (multiplier ** (attempt - 1)))
 * backoff = floor(random() * ceiling)
 */
export function calculateFullJitterBackoff(attempt: number, options: RetryOptions = {}): number {
  const initial = options.initialBackoffMs ?? 1000;
  const max = options.maxBackoffMs ?? 30000;
  const multiplier = options.backoffMultiplier ?? 2;
  const random = options.randomFn ?? Math.random;

  const exp = Math.max(0, attempt - 1);
  const ceiling = Math.min(max, initial * multiplier ** exp);
  return Math.floor(random() * ceiling);
}
