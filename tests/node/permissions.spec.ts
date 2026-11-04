/**
 * Specs for the shared permission pipeline: the defaults, the preauthorized lift, and the rule layer.
 */

import { expect } from 'chai';
import { decidePermission, outranks, principalLevel } from '../../dist/shared/permissions.js';
import type { PermissionRule, PermissionTarget } from '../../dist/shared/permissions.js';

/** One rule with test defaults, so each case states only what it varies. */
function rule(overrides: Partial<PermissionRule> = {}): PermissionRule {
  return {
    id: 'rule-1',
    enabled: true,
    principal: 'agent',
    resource: 'tool',
    actions: '*',
    effect: 'allow',
    ...overrides,
  };
}

const windowTarget: PermissionTarget = { kind: 'window', url: 'chrome-extension://app/dist/renderer/graphs.html' };
const fileTarget: PermissionTarget = { kind: 'file', path: '/workspace/notes.txt' };
const storageTarget: PermissionTarget = { kind: 'storage', storageId: 'vault', key: 'secret' };

describe('the permission defaults', () => {
  it('allows window reads and detach for the agent', () => {
    for (const action of ['attach', 'screenshot', 'console.read', 'detach']) {
      expect(decidePermission('agent', action, windowTarget, [])).to.equal('allow');
    }
  });

  it('asks for other window actions of the agent', () => {
    expect(decidePermission('agent', 'evaluate', windowTarget, [])).to.equal('ask');
    expect(decidePermission('mcp', 'navigate', windowTarget, [])).to.equal('ask');
  });

  it('asks for agent file reads and denies agent file writes', () => {
    expect(decidePermission('agent', 'read', fileTarget, [])).to.equal('ask');
    expect(decidePermission('agent', 'write', fileTarget, [])).to.equal('deny');
  });

  it('denies agent storage access and asks for agent tool calls', () => {
    expect(decidePermission('agent', 'set', storageTarget, [])).to.equal('deny');
    expect(decidePermission('agent', 'vault.search', { kind: 'tool', name: 'vault.search' }, [])).to.equal('ask');
  });

  it('allows everything for the user and plugin principals', () => {
    expect(decidePermission('user', 'set', storageTarget, [])).to.equal('allow');
    expect(decidePermission('plugin', 'write', fileTarget, [])).to.equal('allow');
  });
});

describe('the preauthorized lift', () => {
  it('turns the ask defaults into allow', () => {
    expect(decidePermission('agent', 'evaluate', windowTarget, [], true)).to.equal('allow');
    expect(decidePermission('agent', 'read', fileTarget, [], true)).to.equal('allow');
    expect(decidePermission('agent', 'vault.search', { kind: 'tool', name: 'vault.search' }, [], true)).to.equal('allow');
  });

  it('keeps the deny defaults', () => {
    expect(decidePermission('agent', 'set', storageTarget, [], true)).to.equal('deny');
    expect(decidePermission('agent', 'write', fileTarget, [], true)).to.equal('deny');
  });

  it('keeps a deny rule below a higher-level allow', () => {
    const rules = [rule({ resource: 'window', urlPrefix: 'chrome-extension://app/dist/renderer/graphs.html', effect: 'deny' })];
    expect(decidePermission('agent', 'evaluate', windowTarget, rules, true)).to.equal('deny');
  });
});

describe('the rule layer', () => {
  it('decides before the defaults, and the first match wins', () => {
    const rules = [
      rule({ resource: 'window', effect: 'deny' }),
      rule({ id: 'rule-2', resource: 'window', effect: 'allow' }),
    ];
    expect(decidePermission('agent', 'evaluate', windowTarget, rules)).to.equal('deny');
  });

  it('skips disabled rules and rules of other principals', () => {
    const rules = [
      rule({ enabled: false, effect: 'deny' }),
      rule({ principal: 'mcp', effect: 'deny' }),
    ];
    expect(decidePermission('agent', 'evaluate', windowTarget, rules)).to.equal('ask');
  });

  it('matches window rules by url prefix', () => {
    const rules = [rule({ resource: 'window', urlPrefix: 'chrome-extension://other/' })];
    expect(decidePermission('agent', 'evaluate', windowTarget, rules)).to.equal('ask');
  });

  it('pins one tool through the actions array, and "*" covers every tool', () => {
    const pinned = [rule({ actions: ['vault.search'] })];
    expect(decidePermission('agent', 'vault.search', { kind: 'tool', name: 'vault.search' }, pinned)).to.equal('allow');
    expect(decidePermission('agent', 'vault.read', { kind: 'tool', name: 'vault.read' }, pinned)).to.equal('ask');
    const every = [rule({ actions: '*' })];
    expect(decidePermission('agent', 'vault.read', { kind: 'tool', name: 'vault.read' }, every)).to.equal('allow');
  });

  it('counts every tool call as a write, so a readOnly allow rule denies it', () => {
    const rules = [rule({ actions: '*', effect: 'allow', readOnly: true })];
    expect(decidePermission('agent', 'vault.search', { kind: 'tool', name: 'vault.search' }, rules)).to.equal('deny');
  });

  it('downgrades window writes on a readOnly allow rule, but keeps reads', () => {
    const rules = [rule({ resource: 'window', effect: 'allow', readOnly: true })];
    expect(decidePermission('agent', 'attach', windowTarget, rules)).to.equal('allow');
    expect(decidePermission('agent', 'evaluate', windowTarget, rules)).to.equal('deny');
  });

  it('matches storage rules by storage id and key prefix', () => {
    const rules = [rule({ resource: 'storage:vault', keyPrefix: 'notes/' })];
    expect(decidePermission('agent', 'set', { kind: 'storage', storageId: 'vault', key: 'notes/a' }, rules)).to.equal('allow');
    expect(decidePermission('agent', 'set', { kind: 'storage', storageId: 'vault', key: 'secrets/a' }, rules)).to.equal('deny');
    expect(decidePermission('agent', 'set', storageTarget, rules)).to.equal('deny');
  });
});

describe('the principal ranking', () => {
  it('orders the levels and compares them', () => {
    expect(principalLevel('user')).to.be.greaterThan(principalLevel('plugin'));
    expect(principalLevel('plugin')).to.be.greaterThan(principalLevel('mcp'));
    expect(principalLevel('mcp')).to.be.greaterThan(principalLevel('agent'));
    expect(outranks('user', 'agent')).to.equal(true);
    expect(outranks('agent', 'user')).to.equal(false);
  });
});
