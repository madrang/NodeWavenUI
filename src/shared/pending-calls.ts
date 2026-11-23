/**
 * The pending calls of one request-reply protocol: each call waits under its id for the reply of
 * the peer, under a time cap. The cap drops the waiting entry, so a late reply of a silent peer
 * settles nothing. The module stays free of platform dependencies, so every compile context that
 * speaks a request-reply protocol holds its calls the same way.
 */

/** One call that waits for its reply. */
interface WaitingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Holds the calls of one connection that wait for a reply. */
export class PendingCalls {
  private readonly waiting = new Map<number, WaitingCall>();
  private nextId = 1;

  /**
   * Opens one call under a fresh id and starts its cap.
   *
   * @param timeoutMs The reply cap in milliseconds.
   * @param onTimeout Builds the refusal the cap rejects the call with.
   * @returns The id of the call and the promise that settles with its reply.
   */
  open(timeoutMs: number, onTimeout: () => Error): { readonly id: number; readonly promise: Promise<unknown> } {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.delete(id)) {
          reject(onTimeout());
        }
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
    });
    return { id, promise };
  }

  /** True when one call waits under the id. */
  has(id: number): boolean {
    return this.waiting.has(id);
  }

  /** Settles one call with its reply. False when no call waits under the id. */
  resolve(id: number, value: unknown): boolean {
    return this.settle(id, (call) => {
      call.resolve(value);
    });
  }

  /** Fails one call with an error. False when no call waits under the id. */
  reject(id: number, error: unknown): boolean {
    return this.settle(id, (call) => {
      call.reject(error);
    });
  }

  /** Fails every waiting call with an error of its own and drops them all. */
  rejectAll(error: () => Error): void {
    for (const call of this.waiting.values()) {
      clearTimeout(call.timer);
      call.reject(error());
    }
    this.waiting.clear();
  }

  /** Drops one waiting call, stops its cap, and settles it through the given action. */
  private settle(id: number, action: (call: WaitingCall) => void): boolean {
    const call = this.waiting.get(id);
    if (!call) {
      return false;
    }
    this.waiting.delete(id);
    clearTimeout(call.timer);
    action(call);
    return true;
  }
}
