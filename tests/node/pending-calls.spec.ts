/**
 * Specs for the pending calls: a reply settles its call, an unknown or settled id settles nothing,
 * the cap rejects the call and drops it, and a close fails every waiting call.
 */

import { expect } from 'chai';
import { PendingCalls } from '../../dist/shared/pending-calls.js';

describe('the pending calls', () => {
  it('settles one call with its reply, under a fresh id per call', async () => {
    const pending = new PendingCalls();
    const first = pending.open(1000, () => new Error('first timed out'));
    const second = pending.open(1000, () => new Error('second timed out'));
    expect(second.id).to.equal(first.id + 1);
    expect(pending.resolve(first.id, 'the reply')).to.equal(true);
    expect(await first.promise).to.equal('the reply');
    expect(pending.reject(second.id, new Error('the agent answered an error'))).to.equal(true);
    let failure: unknown = null;
    try {
      await second.promise;
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.equal('the agent answered an error');
  });

  it('settles nothing under an unknown id or a settled id', () => {
    const pending = new PendingCalls();
    const call = pending.open(1000, () => new Error('timed out'));
    call.promise.catch(() => {});
    expect(pending.has(call.id)).to.equal(true);
    expect(pending.resolve(call.id, null)).to.equal(true);
    expect(pending.has(call.id)).to.equal(false);
    expect(pending.resolve(call.id, 'late')).to.equal(false);
    expect(pending.reject(call.id, new Error('late'))).to.equal(false);
    expect(pending.reject(99, new Error('unknown'))).to.equal(false);
  });

  it('rejects a silent call at the cap, and the late reply settles nothing', async () => {
    const pending = new PendingCalls();
    const call = pending.open(5, () => new Error('timed out after 5 ms'));
    let failure: unknown = null;
    try {
      await call.promise;
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).to.equal('timed out after 5 ms');
    expect(pending.has(call.id)).to.equal(false);
    expect(pending.resolve(call.id, 'late')).to.equal(false);
  });

  it('fails every waiting call with an error of its own, and drops them all', async () => {
    const pending = new PendingCalls();
    const first = pending.open(1000, () => new Error('timed out'));
    const second = pending.open(1000, () => new Error('timed out'));
    const failures: unknown[] = [];
    const record = (error: unknown): void => {
      failures.push(error);
    };
    const settled = Promise.all([first.promise.catch(record), second.promise.catch(record)]);
    pending.rejectAll(() => new Error('the connection closed'));
    await settled;
    expect(failures).to.have.lengthOf(2);
    expect(failures[0]).to.not.equal(failures[1]);
    expect((failures[0] as Error).message).to.equal('the connection closed');
    expect(pending.has(first.id)).to.equal(false);
    expect(pending.has(second.id)).to.equal(false);
  });
});
