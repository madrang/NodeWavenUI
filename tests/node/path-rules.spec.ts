/**
 * Specs for the known paths: the longest matching folder rule decides, the root covers the whole
 * workspace, ties prefer the later entry, a stored name rides each rule, and the pipeline asks
 * for file patch proposals.
 */

import { expect } from 'chai';
import { matchPathRule, readPathRules, decidePermission, type PathRule } from '../../dist/shared/permissions.js';

const ROOT = '/work/testbox';

describe('the known paths', () => {
  it('matches nothing without a rule', () => {
    expect(matchPathRule([], `${ROOT}/src/main.ts`, ROOT)).to.equal(null);
  });

  it('covers everything below a folder rule', () => {
    const rules: readonly PathRule[] = [{ path: 'src', name: '', mode: 'allow' }];
    expect(matchPathRule(rules, `${ROOT}/src/main.ts`, ROOT)?.mode).to.equal('allow');
    expect(matchPathRule(rules, `${ROOT}/src/deep/nested/main.ts`, ROOT)?.mode).to.equal('allow');
    expect(matchPathRule(rules, `${ROOT}/tests/main.spec.ts`, ROOT)).to.equal(null);
  });

  it('keeps a sibling folder with the same name outside the rule', () => {
    const rules: readonly PathRule[] = [{ path: 'src', name: '', mode: 'deny' }];
    expect(matchPathRule(rules, `${ROOT}/src-old/main.ts`, ROOT)).to.equal(null);
  });

  it('lets the longest rule win', () => {
    const rules: readonly PathRule[] = [
      { path: 'src', name: 'Source', mode: 'allow' },
      { path: 'src/secrets', name: 'Secrets', mode: 'deny' },
    ];
    expect(matchPathRule(rules, `${ROOT}/src/main.ts`, ROOT)?.mode).to.equal('allow');
    expect(matchPathRule(rules, `${ROOT}/src/secrets/key.json`, ROOT)?.mode).to.equal('deny');
  });

  it('prefers the later entry on an equal-length tie', () => {
    const rules: readonly PathRule[] = [
      { path: 'src', name: '', mode: 'allow' },
      { path: 'src', name: '', mode: 'deny' },
    ];
    expect(matchPathRule(rules, `${ROOT}/src/main.ts`, ROOT)?.mode).to.equal('deny');
  });

  it('covers the whole workspace through the root rule', () => {
    const rules: readonly PathRule[] = [{ path: '.', name: 'Everything', mode: 'deny' }];
    expect(matchPathRule(rules, `${ROOT}/anything/here.md`, ROOT)?.mode).to.equal('deny');
    expect(matchPathRule(rules, ROOT, ROOT)?.mode).to.equal('deny');
  });

  it('reads nothing outside the workspace', () => {
    const rules: readonly PathRule[] = [{ path: '.', name: '', mode: 'allow' }];
    expect(matchPathRule(rules, '/etc/passwd', ROOT)).to.equal(null);
  });

  it('drops damaged entries from a stored list and reads a missing name as empty', () => {
    expect(readPathRules('nope')).to.deep.equal([]);
    expect(readPathRules([{ path: 'src' }, { path: 'src', mode: 'allow' }, { path: 3, mode: 'deny' }])).to.deep.equal([
      { path: 'src', name: '', mode: 'allow' },
    ]);
    expect(readPathRules([{ path: 'docs', name: 'Handbook', mode: 'ask-write' }])).to.deep.equal([
      { path: 'docs', name: 'Handbook', mode: 'ask-write' },
    ]);
  });

  it('asks the agent for a file patch proposal', () => {
    const decision = decidePermission('agent', 'propose', { kind: 'file', path: '/work/x.md' }, []);
    expect(decision).to.equal('ask');
  });
});
