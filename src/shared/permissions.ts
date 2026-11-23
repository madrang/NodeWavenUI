/**
 * The shared permission contract: principals, their ranking, user rules, and the pure decision function.
 * Every guarded call in the app runs through this model. The ranking is enforced in code, and rules can only restrict further.
 */

/** The actors the permission model knows. The level orders them. */
export type PrincipalKind = 'user' | 'plugin' | 'mcp' | 'agent';

/** The origin the chat agent's permission requests carry, so the chat pane routes them to their tab. */
export const CHAT_AGENT_SOURCE = 'chat-agent';

/** Reads the chat-agent source of one chat, so parallel turns attribute their requests to their tab. */
export function chatAgentSource(chatId: number): string {
  return `${CHAT_AGENT_SOURCE}:${chatId}`;
}

/** True when one source belongs to the chat agent, bare or scoped to one chat. */
export function isChatAgentSource(source: string | null): boolean {
  return source === CHAT_AGENT_SOURCE || (source !== null && source.startsWith(`${CHAT_AGENT_SOURCE}:`));
}

/**
 * Reads the chat id one chat-agent source scopes to.
 *
 * @param source The request source. It can have any type of value a source field holds.
 * @returns The chat id, or null for the bare source and for every other origin.
 */
export function chatIdOfAgentSource(source: string | null): number | null {
  if (!source || !source.startsWith(`${CHAT_AGENT_SOURCE}:`)) {
    return null;
  }
  const id = Number(source.slice(CHAT_AGENT_SOURCE.length + 1));
  return Number.isInteger(id) ? id : null;
}

/** The access level of each principal. A higher level outranks a lower one. */
export const PRINCIPAL_LEVELS: Readonly<Record<PrincipalKind, number>> = {
  user: 4,
  plugin: 3,
  mcp: 2,
  agent: 1,
};

/** The modes of one known path: what the agent may do there without a request. */
export type PathRuleMode = 'allow' | 'ask-write' | 'ask' | 'deny';

/** The modes one stored path rule may carry. */
export const PATH_RULE_MODES: readonly PathRuleMode[] = ['allow', 'ask-write', 'ask', 'deny'];

/** One known path of the workspace and the agent access it grants or refuses. */
export interface PathRule {
  /** The workspace-relative folder or file path, normalized without leading or trailing slashes. */
  readonly path: string;
  /** The name of the path, for the settings list and the agent resource. Empty means unnamed. */
  readonly name: string;
  /** The access mode of the path. */
  readonly mode: PathRuleMode;
}

/** True when one value is one path rule mode. */
function isPathRuleMode(value: unknown): value is PathRuleMode {
  return value === 'allow' || value === 'ask-write' || value === 'ask' || value === 'deny';
}

/** Normalizes one rule path or workspace path to comparable segments. The root reads as none. */
function pathSegments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0 && segment !== '.');
}

/**
 * Reads the rule of the longest matching path. A folder rule covers everything below it, and the
 * root rule covers the whole workspace. Later entries win an equal-length tie.
 *
 * @param rules The stored path rules.
 * @param absolutePath The absolute path the agent reaches for.
 * @param workspaceRoot The absolute path of the workspace directory.
 * @returns The matching rule, or null when no rule covers the path.
 */
export function matchPathRule(
  rules: readonly PathRule[],
  absolutePath: string,
  workspaceRoot: string,
): PathRule | null {
  const root = workspaceRoot.replace(/[\\/]+$/, '');
  if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
    return null;
  }
  const segments = pathSegments(absolutePath === root ? '' : absolutePath.slice(root.length + 1));
  let match: PathRule | null = null;
  let matchLength = -1;
  for (const rule of rules) {
    const ruleSegments = pathSegments(rule.path);
    if (ruleSegments.length > segments.length) {
      continue;
    }
    const covered = ruleSegments.every((segment, index) => segment === segments[index]);
    if (covered && ruleSegments.length >= matchLength) {
      match = rule;
      matchLength = ruleSegments.length;
    }
  }
  return match;
}

/** Reads one stored path rule list. A damaged list reads as empty. */
export function readPathRules(value: unknown): readonly PathRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rules: PathRule[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || !entry) {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate['path'] !== 'string' || !isPathRuleMode(candidate['mode'])) {
      continue;
    }
    // Older records carry no name: they read as unnamed.
    rules.push({
      path: candidate['path'],
      name: typeof candidate['name'] === 'string' ? candidate['name'] : '',
      mode: candidate['mode'],
    });
  }
  return rules;
}

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
  /** Resource selector: `window`, `storage`, `storage:<id>`, `file`, or `tool`. */
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
  | { readonly kind: 'window'; readonly url: string } |
  { readonly kind: 'storage'; readonly storageId: string; readonly key: string } |
  { readonly kind: 'file'; readonly path: string } |
  { readonly kind: 'command'; readonly command: string } |
  { readonly kind: 'tool'; readonly name: string };

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
  if (typeof value !== 'object' || !value) {
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
  if (target.kind === 'command') {
    // A command run may change anything, so every run counts as a write: a readOnly allow rule denies it.
    return true;
  }
  if (target.kind === 'tool') {
    // A tool call may change anything, so every call counts as a write: a readOnly allow rule denies it.
    return true;
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
  if (target.kind === 'command') {
    if (rule.resource !== 'command') {
      return false;
    }
    return rule.pathPrefix === undefined || target.command.startsWith(rule.pathPrefix);
  }
  if (target.kind === 'tool') {
    if (rule.resource !== 'tool') {
      return false;
    }
    // The action of a tool call is the tool name, so the actions array pins one tool or every tool.
    return rule.actions === '*' || rule.actions.includes(target.name);
  }
  if (rule.resource !== 'storage' && rule.resource !== `storage:${target.storageId}`) {
    return false;
  }
  return rule.keyPrefix === undefined || target.key.startsWith(rule.keyPrefix);
}

/**
 * Reads the first rule that matches one guarded call.
 * The renderer follows the same matcher for the tool rules of the agent, so the tool matrix and
 * the request cards read the rules the gate reads.
 *
 * @param principal The principal that wants to act.
 * @param action The action, for example `evaluate` or `write`.
 * @param target The target of the action.
 * @param rules The persisted rules, in order. The first match wins.
 * @returns The first matching rule, or null when no rule matches.
 */
export function matchingRule(
  principal: PrincipalKind,
  action: string,
  target: PermissionTarget,
  rules: readonly PermissionRule[],
): PermissionRule | null {
  for (const rule of rules) {
    if (ruleMatchesTarget(rule, principal, action, target)) {
      return rule;
    }
  }
  return null;
}

/**
 * Reads the decision of the first rule that matches one guarded call.
 * The pipeline defaults never run here, so a caller that holds its own grant, for example a
 * storage share, may follow the rules alone and keep its grant under every no-rule key.
 *
 * @param principal The principal that wants to act.
 * @param action The action, for example `evaluate` or `write`.
 * @param target The target of the action.
 * @param rules The persisted rules, in order. The first match wins.
 * @returns The effect of the first matching rule, or null when no rule matches.
 */
export function matchingRuleDecision(
  principal: PrincipalKind,
  action: string,
  target: PermissionTarget,
  rules: readonly PermissionRule[],
): PermissionEffect | null {
  const rule = matchingRule(principal, action, target, rules);
  if (!rule) {
    return null;
  }
  if (rule.effect === 'deny') {
    return 'deny';
  }
  if (rule.readOnly && isWriteAction(target, action)) {
    return 'deny';
  }
  return 'allow';
}

/**
 * Runs the decision pipeline for one guarded call.
 * The rules decide first, then the defaults apply: `user` and `plugin` allow, `agent` and `mcp` allow window reads
 * and window detach, ask for other window actions, ask for file reads, file patch proposals, and command runs, ask
 * for tool calls, and deny storage.
 * A preauthorized call turns the ask defaults into allow, so one call never prompts twice. Rules and deny
 * defaults still decide, so a deny rule below a higher-level allow keeps its block.
 * The storage shares of the chat agent sit behind the guarded storage wrapper: a matching rule
 * decides there through `matchingRuleDecision`, and these defaults never run for them.
 *
 * @param principal The principal that wants to act.
 * @param action The action, for example `evaluate` or `write`.
 * @param target The target of the action.
 * @param rules The persisted rules, in order. The first match wins.
 * @param preauthorized True when a rule at a higher layer already allowed the call.
 * @returns The decision. `ask` means the main app UI must approve the call.
 */
export function decidePermission(
  principal: PrincipalKind,
  action: string,
  target: PermissionTarget,
  rules: readonly PermissionRule[],
  preauthorized = false,
): PermissionDecision {
  const ruled = matchingRuleDecision(principal, action, target, rules);
  if (ruled) {
    return ruled;
  }
  if (principal === 'user' || principal === 'plugin') {
    return 'allow';
  }
  if (target.kind === 'window') {
    if (WINDOW_READ_ACTIONS.has(action) || action === 'detach') {
      return 'allow';
    }
    return preauthorized ? 'allow' : 'ask';
  }
  if (target.kind === 'file' && (action === 'read' || action === 'propose')) {
    return preauthorized ? 'allow' : 'ask';
  }
  if (target.kind === 'command') {
    return preauthorized ? 'allow' : 'ask';
  }
  if (target.kind === 'tool') {
    return preauthorized ? 'allow' : 'ask';
  }
  return 'deny';
}
