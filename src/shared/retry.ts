/**
 * The retry of one call that can fail before its server runs anything: a connect, a handshake, a
 * request up to its response headers. The retry repeats only the failures its policy names, under
 * a fixed attempt budget, with a wait that doubles between attempts. The module stays free of
 * platform dependencies, so every compile context retries the same way.
 */

/** Waits for the given milliseconds. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** The retry policy of one repeated call. */
export interface RetryPolicy {
  /** The attempts in total, the first try included. */
  readonly attempts: number;
  /** The wait before the first retry. Every later retry doubles it. */
  readonly baseDelayMs: number;
  /** True for a failure the retry may repeat. Every other failure fails the call at once. */
  readonly retryOn: (error: unknown) => boolean;
}

/**
 * Runs one call under a retry policy.
 *
 * @param run The call. It receives the index of its attempt, and the first try reads as zero.
 * @param policy The attempts, the first wait, and the failures the retry repeats.
 * @returns The result of the first attempt that succeeds.
 * @throws The error of the last attempt, when the budget runs out or the policy refuses the retry.
 */
export async function retry<T>(run: (attempt: number) => Promise<T>, policy: RetryPolicy): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (attempt + 1 >= policy.attempts || !policy.retryOn(error)) {
        throw error;
      }
    }
    await sleep(policy.baseDelayMs * 2 ** attempt);
  }
}
