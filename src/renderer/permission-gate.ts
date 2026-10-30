/**
 * The permission gate: the stateful side of the permission model.
 * It loads and persists the user rules through the settings store, queues undecided requests, and hands the main app UI the approve and deny controls.
 * A request waits forever. The caller promise settles only when the UI resolves the request.
 */

import { decidePermission, type PermissionRule, type PermissionTarget, type PrincipalKind } from '../shared/permissions.js';

/** The rule persistence the gate needs. The settings store of the workspace implements it. */
export interface PermissionRuleStore {
  loadPermissionRules(): Promise<readonly PermissionRule[]>;
  savePermissionRules(rules: readonly PermissionRule[]): Promise<void>;
}

/** The public view of one queued request, for the main app UI. */
export interface PermissionRequestInfo {
  readonly id: number;
  readonly principal: PrincipalKind;
  readonly action: string;
  /** The target in human readable form, for example "window https://example.com". */
  readonly target: string;
  /** The detail the caller attached, for example "child window 3 (https://example.com)". */
  readonly detail: string;
  readonly createdAt: number;
  /** The origin of the call, for example the MCP session id. Null when the caller gave none. */
  readonly source: string | null;
}

/** One queued request with the promise that waits for the UI decision. */
interface PendingPermissionRequest {
  readonly info: PermissionRequestInfo;
  readonly target: PermissionTarget;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

function describeTarget(target: PermissionTarget): string {
  if (target.kind === 'window') {
    return `window ${target.url}`;
  }
  if (target.kind === 'file') {
    return `file ${target.path}`;
  }
  return `storage "${target.storageId}" key "${target.key}"`;
}

function resourceOfTarget(target: PermissionTarget): string {
  if (target.kind === 'window') {
    return 'window';
  }
  if (target.kind === 'file') {
    return 'file';
  }
  return `storage:${target.storageId}`;
}

/** Decides guarded calls and holds the request queue and the rule list of one workspace. */
export class PermissionGate {
  private readonly store: PermissionRuleStore;
  private rules: PermissionRule[] = [];
  private rulesLoaded = false;
  private rulesLoading: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingPermissionRequest>();
  private nextRequestId = 1;
  private readonly listeners = new Set<() => void>();

  constructor(store: PermissionRuleStore) {
    this.store = store;
  }

  /**
   * Checks one guarded call and waits for the UI decision when the pipeline ends on `ask`.
   *
   * @param principal The principal that wants to act.
   * @param action The action, for example `evaluate` or `write`.
   * @param target The target of the action.
   * @param detail The detail the UI shows next to the request.
   * @param source The origin of the call, for example the MCP session id, so the UI can route the request.
   * @throws Error when the pipeline denies the call or the UI rejects the request.
   */
  async check(
    principal: PrincipalKind,
    action: string,
    target: PermissionTarget,
    detail: string,
    source: string | null = null,
  ): Promise<void> {
    await this.ensureRules();
    const decision = decidePermission(principal, action, target, this.rules);
    if (decision === 'allow') {
      return;
    }
    if (decision === 'deny') {
      throw new Error(
        `Permission denied: "${principal}" may not run "${action}" on ${describeTarget(target)}.`,
      );
    }
    const targetText = describeTarget(target);
    await new Promise<void>((resolve, reject) => {
      const id = this.nextRequestId;
      this.nextRequestId += 1;
      const info: PermissionRequestInfo = {
        id,
        principal,
        action,
        target: targetText,
        detail,
        createdAt: Date.now(),
        source,
      };
      this.pending.set(id, { info, target, resolve, reject });
      this.notifyChange();
    });
  }

  /**
   * Lists the queued requests, oldest first.
   *
   * @returns The requests the main app UI can resolve.
   */
  pendingRequests(): readonly PermissionRequestInfo[] {
    return [...this.pending.values()].map((request) => request.info);
  }

  /**
   * Resolves one queued request.
   * The always choice persists one rule that covers the request, so the next equal call decides without a request.
   *
   * @param id The request id.
   * @param approve True approves the call, false rejects it.
   * @param remember True persists the decision as a rule.
   */
  async resolveRequest(id: number, approve: boolean, remember: boolean): Promise<void> {
    const request = this.pending.get(id);
    if (request === undefined) {
      return;
    }
    this.pending.delete(id);
    if (remember) {
      const rule: PermissionRule = {
        id: crypto.randomUUID(),
        enabled: true,
        principal: request.info.principal,
        resource: resourceOfTarget(request.target),
        actions: [request.info.action],
        effect: approve ? 'allow' : 'deny',
      };
      this.rules.push(rule);
      await this.persistRules();
    }
    if (approve) {
      request.resolve();
    } else {
      request.reject(
        new Error(
          `Permission denied: the user rejected "${request.info.principal}" ${request.info.action} on ${request.info.target}.`,
        ),
      );
    }
    this.notifyChange();
  }

  /**
   * Lists the persisted rules.
   *
   * @returns The rules in evaluation order.
   */
  listRules(): readonly PermissionRule[] {
    return [...this.rules];
  }

  /**
   * Adds one rule and persists the rule list.
   *
   * @param rule The rule to append at the end of the evaluation order.
   */
  async addRule(rule: PermissionRule): Promise<void> {
    await this.ensureRules();
    this.rules.push(rule);
    await this.persistRules();
    this.notifyChange();
  }

  /**
   * Removes one rule and persists the rule list.
   *
   * @param id The rule id. An unknown id does nothing.
   */
  async removeRule(id: string): Promise<void> {
    await this.ensureRules();
    const next = this.rules.filter((rule) => rule.id !== id);
    if (next.length === this.rules.length) {
      return;
    }
    this.rules = next;
    await this.persistRules();
    this.notifyChange();
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

  private ensureRules(): Promise<void> {
    if (this.rulesLoaded) {
      return Promise.resolve();
    }
    this.rulesLoading ??= this.loadRules();
    return this.rulesLoading;
  }

  private async loadRules(): Promise<void> {
    this.rules = [...await this.store.loadPermissionRules()];
    this.rulesLoaded = true;
  }

  private async persistRules(): Promise<void> {
    try {
      await this.store.savePermissionRules(this.rules);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[NodeWavenUI] the permission rules could not be saved: ${message}`);
    }
  }

  private notifyChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
