/**
 * The notification hub: one event bus for every MCP notification source.
 * Client notifications that reach the MCP host and notifications that remote MCP servers send the
 * client both dispatch here, so evaluated code can hook them with callbacks. The chat side turns a
 * notification into one user message for the chat agent.
 */

/** One notification listener. A throwing listener never breaks the dispatch. */
export type NotificationListener = (method: string, params: unknown, source: string) => void;

/** Owns the notification listeners and the chat notification path. */
export class NotificationHub {
  private readonly listeners = new Map<number, { readonly method: string; readonly listener: NotificationListener }>();
  private nextListenerId = 1;
  private chatNotifier: ((text: string) => void) | null = null;

  /** Sets the function that lands one notification as a user message in the chat. */
  setChatNotifier(notifier: (text: string) => void): void {
    this.chatNotifier = notifier;
  }

  /**
   * Registers one listener for one notification method.
   *
   * @param method The notification method name, for example "notifications/message". "*" hears every method.
   * @param listener The listener the dispatch calls.
   * @returns The listener id, for unsubscribe.
   */
  subscribe(method: string, listener: NotificationListener): number {
    const id = this.nextListenerId;
    this.nextListenerId += 1;
    this.listeners.set(id, { method, listener });
    return id;
  }

  /** Removes one listener. An unknown id does nothing. */
  unsubscribe(id: number): void {
    this.listeners.delete(id);
  }

  /** The registered listener ids with their methods, for the page API. */
  listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Dispatches one notification to every matching listener.
   *
   * @param method The notification method.
   * @param params The notification params, when the sender carried any.
   * @param source Where the notification came from, for example "host-session <id>" or "mcp <label>".
   */
  dispatch(method: string, params: unknown, source: string): void {
    for (const entry of this.listeners.values()) {
      if (entry.method !== '*' && entry.method !== method) {
        continue;
      }
      try {
        entry.listener(method, params, source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[NodeWavenUI] one notification listener of "${method}" threw: ${message}`);
      }
    }
  }

  /**
   * Lands one notification as a user message for the chat agent.
   *
   * @param parts The notification content pieces. Strings join, everything else serializes.
   */
  notifyChat(...parts: readonly unknown[]): void {
    const text = parts
      .map((part) => (typeof part === 'string' ? part : JSON.stringify(part) ?? String(part)))
      .join(' ');
    this.chatNotifier?.(text.length > 0 ? text : '(empty notification)');
  }
}
