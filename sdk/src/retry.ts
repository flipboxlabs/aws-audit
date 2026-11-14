/**
 * Longest delay in milliseconds before a retry.
 */
export const RETRY_MAX_DELAY = 30_000;

/**
 * The delay before retrying after failed attempt `attempt` (1-based): jittered
 * exponential backoff, between half and all of `baseDelay * 2^(attempt - 1)`,
 * capped at `maxDelay`. The jitter spreads out clients throttled at the same time,
 * so they don't all retry at once.
 *
 * The Rust Lambdas use the same formula (`lambda_kit::retry::Backoff`).
 *
 * @internal
 */
export function backoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number = RETRY_MAX_DELAY,
): number {
  const ceiling = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
}
