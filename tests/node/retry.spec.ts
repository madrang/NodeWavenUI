/**
 * Specs for the shared retry: a success passes through, a retryable failure repeats under the
 * budget, a final failure fails at once, and the budget ends on the error of the last attempt.
 */

import { expect } from 'chai';
import { retry, sleep, type RetryPolicy } from '../../dist/shared/retry.js';

/** One policy with a near-zero wait, so the specs run fast. */
const policy: RetryPolicy = { attempts: 3, baseDelayMs: 1, retryOn: (error) => error instanceof RangeError };

describe('the shared retry', () => {
  it('answers the result of the first attempt, and runs no second attempt', async () => {
    const attempts: number[] = [];
    const result = await retry((attempt) => {
      attempts.push(attempt);
      return Promise.resolve(`answer ${attempt}`);
    }, policy);
    expect(result).to.equal('answer 0');
    expect(attempts).to.deep.equal([0]);
  });

  it('repeats a retryable failure until the budget runs out, and throws the error of the last attempt', async () => {
    const attempts: number[] = [];
    let failure: unknown = null;
    try {
      await retry((attempt) => {
        attempts.push(attempt);
        return Promise.reject(new RangeError(`attempt ${attempt}`));
      }, policy);
    } catch (error) {
      failure = error;
    }
    expect(attempts).to.deep.equal([0, 1, 2]);
    expect((failure as Error).message).to.equal('attempt 2');
  });

  it('fails a final failure at once', async () => {
    const attempts: number[] = [];
    let failure: unknown = null;
    try {
      await retry(async (attempt) => {
        attempts.push(attempt);
        throw new TypeError(`attempt ${attempt}`);
      }, policy);
    } catch (error) {
      failure = error;
    }
    expect(attempts).to.deep.equal([0]);
    expect(failure).to.be.instanceOf(TypeError);
  });

  it('answers the first attempt that succeeds after a retryable failure', async () => {
    const attempts: number[] = [];
    const result = await retry((attempt) => {
      attempts.push(attempt);
      return attempt === 0 ? Promise.reject(new RangeError('first')) : Promise.resolve('second');
    }, policy);
    expect(result).to.equal('second');
    expect(attempts).to.deep.equal([0, 1]);
  });

  it('sleeps at least the given milliseconds', async () => {
    const started = Date.now();
    await sleep(20);
    expect(Date.now() - started).to.be.at.least(15);
  });
});
