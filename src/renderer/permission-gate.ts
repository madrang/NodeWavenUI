/**
 * The permission gate of the workspace page: the client side of the gate that lives in the
 * worker core. It speaks the permission channels of the core contract through the bridge, keeps
 * a local cache fed by the `permission.event` pushes, and offers the interface the main app UI,
 * the rail, and the file tools always used. The queue and the rules live in the worker; a
 * resolve from any surface settles a request, and the first answer wins.
 */

import { isRecord } from '../shared/records.js';
import type { CorePermissionState } from '../shared/core-api.js';
import type { PermissionRule, PrincipalKind } from '../shared/permissions.js';
import type { NodeWavenBridge } from '../shared/bridge.js';

/** The public view of one queued request, for the main app UI. */
export interface PermissionRequestInfo {
  readonly id: number;
  readonly principal: PrincipalKind;
  readonly action: string;
  /** The target in human readable form, for example "window https://example.com". */
  readonly target: string;
  /** The command text of a run request, parsed for display. Null for every other target. */
  readonly command: string | null;
  /** The detail the caller attached, for example "child window 3 (https://example.com)". */
  readonly detail: string;
  readonly createdAt: number;
  /** The origin of the call, for example the MCP session id. Null when the caller gave none. */
  readonly source: string | null;
}

/** Reads one pushed or answered permission state. Returns null on an invalid shape. */
function readPermissionState(value: unknown): CorePermissionState | null {
  if (!isRecord(value) || !Array.isArray(value.pending) || !Array.isArray(value.rules)) {
    return null;
  }
  return { pending: value.pending, rules: value.rules };
}

/** The gate client of the workspace page. Every state lives in the worker core. */
export class PermissionGate {
  private readonly bridge: NodeWavenBridge;
  private state: CorePermissionState = { pending: [], rules: [] };
  private readonly listeners = new Set<() => void>();

  constructor(bridge: NodeWavenBridge) {
    this.bridge = bridge;
    bridge.workspace.onWorkspaceEvent('permission.event', (payload) => {
      const state = readPermissionState(payload);
      if (state) {
        this.state = state;
        this.notifyChange();
      }
    });
  }

  /**
   * Checks one guarded call and waits for a decision when the pipeline ends on `ask`.
   *
   * @param principal The principal that wants to act.
   * @param action The action, for example `evaluate` or `write`.
   * @param target The target of the action.
   * @param detail The detail the UI shows next to the request.
   * @param source The origin of the call, for example the MCP session id, so the UI can route the request.
   * @param preauthorized True when a rule at a higher layer already allowed the call, so the ask defaults turn into allow.
   * @throws Error when the pipeline denies the call or the UI rejects the request.
   */
  async check(
    principal: PrincipalKind,
    action: string,
    target: unknown,
    detail: string,
    source: string | null = null,
    preauthorized = false,
  ): Promise<void> {
    await this.bridge.core.request('permission.check', {
      principal,
      action,
      target,
      description: detail,
      source,
      preauthorized,
    });
  }

  /**
   * Lists the queued requests, oldest first, from the local cache.
   *
   * @returns The requests the main app UI can resolve.
   */
  pendingRequests(): readonly PermissionRequestInfo[] {
    return this.state.pending as readonly PermissionRequestInfo[];
  }

  /**
   * Resolves one queued request in the worker core.
   * The always choice persists one rule that covers the request, so the next equal call decides without a request.
   *
   * @param id The request id.
   * @param approve True approves the call, false rejects it.
   * @param remember True persists the decision as a rule.
   */
  async resolveRequest(id: number, approve: boolean, remember: boolean): Promise<void> {
    await this.bridge.core.request('permission.resolve', { id, approve, remember });
  }

  /**
   * Lists the persisted rules from the local cache.
   *
   * @returns The rules in evaluation order.
   */
  listRules(): readonly PermissionRule[] {
    return [...this.state.rules];
  }

  /**
   * Adds one rule in the worker core and persists the rule list.
   *
   * @param rule The rule to append at the end of the evaluation order.
   */
  async addRule(rule: PermissionRule): Promise<void> {
    await this.bridge.core.request('permission.rule.add', rule);
  }

  /**
   * Removes one rule in the worker core and persists the rule list.
   *
   * @param id The rule id. An unknown id does nothing.
   */
  async removeRule(id: string): Promise<void> {
    await this.bridge.core.request('permission.rule.remove', { id });
  }

  /**
   * Subscribes to every change of the request queue and the rule list.
   *
   * @param listener The listener each change calls.
   * @returns A function that removes the subscription.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Waits until the first permission state arrived from the worker core.
   * The UI reads `listRules` before any `check` runs, so it must await this or it reads an empty list.
   *
   * @throws Error when the core request fails.
   */
  async ready(): Promise<void> {
    const state = readPermissionState(await this.bridge.core.request('permission.list'));
    if (state) {
      this.state = state;
    }
  }

  private notifyChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
