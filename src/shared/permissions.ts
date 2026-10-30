/**
 * The shared permission contract: principals, their ranking, user rules, and the pure decision function.
 * Every guarded call in the app runs through this model. The ranking is enforced in code, and rules can only restrict further.
 */

/** The actors the permission model knows. The level orders them. */
export type PrincipalKind = 'user' | 'plugin' | 'mcp' | 'agent';

/** The access level of each principal. A higher level outranks a lower one. */
export const PRINCIPAL_LEVELS: Readonly<Record<PrincipalKind, number>> = {
  user: 4,
  plugin: 3,
  mcp: 2,
  agent: 1,
};

const PRINCIPAL_NAMES: ReadonlySet<string> = new Set(['user', 'plugin', 'mcp', 'agent']);

/**
 * Reads the access level of one principal.
 *
 * @param principal The principal.
 * @returns The level, where a higher number outranks a lower one.
 */
export function principalLevel(principal: PrincipalKind): number {
  return PRINCIPAL_LEVELS[principal];
}

/**
 * Compares two principals by level.
 *
 * @param higher The claimed higher principal.
 * @param lower The claimed lower principal.
 * @returns True when the first principal strictly outranks the second.
 */
export function outranks(higher: PrincipalKind, lower: PrincipalKind): boolean {
  return PRINCIPAL_LEVELS[higher] > PRINCIPAL_LEVELS[lower];
}

/** The effect one rule carries. */
export type PermissionEffect = 'allow' | 'deny';

/** The outcome of the decision pipeline. `ask` queues a request for the main app UI. */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/** One user rule. The rules persist in the `permission-rules` record of the workspace storage, and the first match wins. */
export interface PermissionRule {
  readonly id: string;
  readonly enabled: boolean;
  /** The principal the rule selects, or `*` for every principal. */
  readonly principal: PrincipalKind | '*';
  /** Resource selector: `window`, `storage`, `storage:<id>`, or `file`. */
  readonly resource: string;
  /** Window rules: match children whose URL starts with this prefix. Undefined matches every child. */
  readonly urlPrefix?: string;
  /** Storage rules: match keys that start with this prefix. Undefined matches every key. */
  readonly keyPrefix?: string;
  /** File rules: match paths that start with this prefix. Undefined matches every path. */
  readonly pathPrefix?: string;
  /** The selected actions, or `*` for every action. */
  readonly actions: readonly string[] | '*';
  readonly effect: PermissionEffect;
  /** Downgrades write actions to deny on an allow rule. */
  readonly readOnly?: boolean;
}

/** What one guarded call targets. */
export type PermissionTarget =
  | { readonly kind: 'window'; readonly url: string }
  | { readonly kind: 'storage'; readonly storageId: string; readonly key: string }
  | { readonly kind: 'file'; readonly path: string };

/** The window actions that only read. */
export const WINDOW_READ_ACTIONS: ReadonlySet<string> = new Set(['attach', 'screenshot', 'console.read']);

/**
 * Checks that a value is a valid PermissionRule.
 * Use this guard where rules arrive without type backing, above all from the persisted record.
 *
 * @param value The value to check. It can have any type.
 * @returns True when the value satisfies the rule shape.
 */
export function isPermissionRule(value: unknown): value is PermissionRule {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const principal = candidate['principal'];
  const principalValid =
    principal === '*' || (typeof principal === 'string' && PRINCIPAL_NAMES.has(principal));
  const actions = candidate['actions'];
  const actionsValid =
    actions === '*' || (Array.isArray(actions) && actions.every((action) => typeof action === 'string'));
  const effect = candidate['effect'];
  return (
    typeof candidate['id'] === 'string' &&
    candidate['id'].length > 0 &&
    (candidate['enabled'] === true || candidate['enabled'] === false) &&
    principalValid &&
    typeof candidate['resource'] === 'string' &&
    candidate['resource'].length > 0 &&
    (candidate['urlPrefix'] === undefined || typeof candidate['urlPrefix'] === 'string') &&
    (candidate['keyPrefix'] === undefined || typeof candidate['keyPrefix'] === 'string') &&
    (candidate['pathPrefix'] === undefined || typeof candidate['pathPrefix'] === 'string') &&
    actionsValid &&
    (effect === 'allow' || effect === 'deny') &&
    (candidate['readOnly'] === undefined || typeof candidate['readOnly'] === 'boolean')
  );
}

/** True when the action changes the target. Window detach does not count, because the session ranking gates it. */
function isWriteAction(target: PermissionTarget, action: string): boolean {
  if (target.kind === 'storage') {
    return action === 'write';
  }
  if (target.kind === 'file') {
    return action !== 'read';
  }
  return !WINDOW_READ_ACTIONS.has(action) && action !== 'detach';
}

/** True when one rule selects the principal, the action, and the target of a guarded call. */
function ruleMatchesTarget(
  rule: PermissionRule,
  principal: PrincipalKind,
  action: string,
  target: PermissionTarget,
): boolean {
  if (!rule.enabled) {
    return false;
  }
  if (rule.principal !== '*' && rule.principal !== principal) {
    return false;
  }
  if (rule.actions !== '*' && !rule.actions.includes(action)) {
    return false;
  }
  if (target.kind === 'window') {
    if (rule.resource !== 'window') {
      return false;
    }
    return rule.urlPrefix === undefined || target.url.startsWith(rule.urlPrefix);
  }
  if (target.kind === 'file') {
    if (rule.resource !== 'file') {
      return false;
    }
    return rule.pathPrefix === undefined || target.path.startsWith(rule.pathPrefix);
  }
  if (rule.resource !== 'storage' && rule.resource !== `storage:${target.storageId}`) {
    return false;
  }
  return rule.keyPrefix === undefined || target.key.startsWith(rule.keyPrefix);
}

/**
 * Runs the decision pipeline for one guarded call.
 * The rules decide first, then the defaults apply: `user` and `plugin` allow, `agent` and `mcp` allow window reads
 * and window detach, ask for other window actions, ask for file reads, and deny storage. Storage sharing for the
 * chat agent runs through the storage sharing settings, not through this pipeline.
 *
 * @param principal The principal that wants to act.
 * @param action The action, for example `evaluate` or `write`.
 * @param target The target of the action.
 * @param rules The persisted rules, in order. The first match wins.
 * @returns The decision. `ask` means the main app UI must approve the call.
 */
export function decidePermission(
  principal: PrincipalKind,
  action: string,
  target: PermissionTarget,
  rules: readonly PermissionRule[],
): PermissionDecision {
  for (const rule of rules) {
    if (!ruleMatchesTarget(rule, principal, action, target)) {
      continue;
    }
    if (rule.effect === 'deny') {
      return 'deny';
    }
    if (rule.readOnly === true && isWriteAction(target, action)) {
      return 'deny';
    }
    return 'allow';
  }
  if (principal === 'user' || principal === 'plugin') {
    return 'allow';
  }
  if (target.kind === 'window') {
    if (WINDOW_READ_ACTIONS.has(action) || action === 'detach') {
      return 'allow';
    }
    return 'ask';
  }
  if (target.kind === 'file' && action === 'read') {
    return 'ask';
  }
  return 'deny';
}
