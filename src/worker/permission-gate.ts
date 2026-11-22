/**
 * The permission gate of the worker core: the stateful side of the permission model.
 * It loads and persists the user rules through the settings store of the worker, queues undecided
 * requests, and reports every change so each surface renders the same queue and answers through
 * the `permission.resolve` channel. A request waits forever. The caller promise settles only when
 * a surface resolves the request. The first resolve of one request wins, and a repeated resolve
 * of a settled request changes nothing.
 */

import {
  decidePermission,
  type PermissionRule,
  type PermissionTarget,
  type PrincipalKind,
} from '../shared/permissions.js';
import type { CorePendingPermission } from '../shared/core-api.js';
import { log } from './logger.js';

/** The rule persistence the gate needs. The settings store of the worker implements it. */
export interface PermissionRuleStore {
  loadPermissionRules(): Promise<readonly PermissionRule[]>;
  savePermissionRules(rules: readonly PermissionRule[]): Promise<void>;
}

/** One queued request with the promise that waits for a surface decision. */
interface PendingPermissionRequest {
  readonly info: CorePendingPermission;
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
  if (target.kind === 'command') {
    return `command ${target.command}`;
  }
  if (target.kind === 'tool') {
    return `tool ${target.name}`;
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
  if (target.kind === 'command') {
    return 'command';
  }
  if (target.kind === 'tool') {
    return 'tool';
  }
  return `storage:${target.storageId}`;
}

/** Decides guarded calls and holds the request queue and the rule list of one workspace. */
export class WorkerPermissionGate {
  private readonly store: PermissionRuleStore;
  private readonly changeListener: () => void;
  private rules: PermissionRule[] = [];
  private rulesLoaded = false;
  private rulesLoading: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingPermissionRequest>();
  private nextRequestId = 1;

  constructor(store: PermissionRuleStore, changeListener: () => void) {
    this.store = store;
    this.changeListener = changeListener;
  }

  /**
   * Checks one guarded call and waits for a surface decision when the pipeline ends on `ask`.
   *
   * @param principal The principal that wants to act.
   * @param action The action, for example `evaluate` or `write`.
   * @param target The target of the action.
   * @param detail The detail the surfaces show next to the request.
   * @param source The origin of the call, for example the MCP session id, so the surfaces route the request.
   * @param preauthorized True when a rule at a higher layer already allowed the call, so the ask defaults turn into allow.
   * @throws Error when the pipeline denies the call or a surface rejects the request.
   */
  async check(
    principal: PrincipalKind,
    action: string,
    target: PermissionTarget,
    detail: string,
    source: string | null = null,
    preauthorized = false,
  ): Promise<void> {
    await this.ensureRules();
    const decision = decidePermission(principal, action, target, this.rules, preauthorized);
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
      const info: CorePendingPermission = {
        id,
        principal,
        action,
        target: targetText,
        command: target.kind === 'command' ? target.command : null,
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
   * @returns The requests every surface can resolve.
   */
  pendingRequests(): readonly CorePendingPermission[] {
    return [...this.pending.values()].map((request) => request.info);
  }

  /**
   * Resolves one queued request.
   * The always choice persists one rule that covers the request, so the next equal call decides without a request.
   * A resolve of a settled request changes nothing, so the first answer of any surface wins.
   *
   * @param id The request id.
   * @param approve True approves the call, false rejects it.
   * @param remember True persists the decision as a rule.
   */
  async resolveRequest(id: number, approve: boolean, remember: boolean): Promise<void> {
    const request = this.pending.get(id);
    if (!request) {
      return;
    }
    this.pending.delete(id);
    if (remember) {
      const rule: PermissionRule = {
        id: crypto.randomUUID(),
        enabled: true,
        principal: request.info.principal as PermissionRule['principal'],
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
   * Waits until the persisted rules loaded. The first call loads them.
   *
   * @throws StorageError when the store fails.
   */
  ready(): Promise<void> {
    return this.ensureRules();
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
      log.worker.warning(`the permission rules could not be saved: ${message}`);
    }
  }

  private notifyChange(): void {
    this.changeListener();
  }
}
