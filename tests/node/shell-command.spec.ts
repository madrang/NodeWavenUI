/**
 * Specs for the shell command display parser and the command permission default: the stages
 * split on the operators, the words keep their quoting, the redirects separate, the expansions
 * mark without resolving, and a command run of the agent asks.
 */

import { expect } from 'chai';
import { parseShellCommand } from '../../dist/shared/shell-command.js';
import { decidePermission, type PermissionRule } from '../../dist/shared/permissions.js';

describe('the shell command display parser', () => {
  it('splits one simple command into one stage', () => {
    const stages = parseShellCommand('npm test');
    expect(stages).to.have.lengthOf(1);
    expect(stages[0]?.program.text).to.equal('npm');
    expect(stages[0]?.args.map((arg) => arg.text)).to.deep.equal(['test']);
    expect(stages[0]?.operator).to.equal(null);
  });

  it('splits a pipeline and keeps the joining operators', () => {
    const stages = parseShellCommand('cat notes.md | grep TODO && wc -l; echo done');
    expect(stages.map((stage) => stage.program.text)).to.deep.equal(['cat', 'grep', 'wc', 'echo']);
    expect(stages.map((stage) => stage.operator)).to.deep.equal(['|', '&&', ';', null]);
  });

  it('keeps the quoting inside the words', () => {
    const stages = parseShellCommand("echo 'two words' \"a \\\"quoted\\\"\"");
    expect(stages[0]?.args.map((arg) => arg.text)).to.deep.equal(["'two words'", '"a \\"quoted\\""']);
  });

  it('separates the redirects with their targets', () => {
    const stages = parseShellCommand('npm run build 2>> err.log > out.txt < input.txt');
    expect(stages[0]?.redirects).to.deep.equal([
      { kind: '2>>', target: 'err.log' },
      { kind: '>', target: 'out.txt' },
      { kind: '<', target: 'input.txt' },
    ]);
    expect(stages[0]?.args.map((arg) => arg.text)).to.deep.equal(['run', 'build']);
  });

  it('marks expansions outside single quotes', () => {
    const stages = parseShellCommand('echo $HOME "$USER" \'$LITERAL\' plain');
    expect(stages[0]?.args.map((arg) => arg.expansion)).to.deep.equal([true, true, false, false]);
  });

  it('answers no stage for empty and blank input', () => {
    expect(parseShellCommand('')).to.deep.equal([]);
    expect(parseShellCommand('   ')).to.deep.equal([]);
  });

  it('keeps a dangling operator tail out', () => {
    const stages = parseShellCommand('ls |');
    expect(stages.map((stage) => stage.program.text)).to.deep.equal(['ls']);
    expect(stages[0]?.operator).to.equal('|');
  });
});

describe('the command permission default', () => {
  it('asks the agent for a command run and lifts a preauthorized call', () => {
    const target = { kind: 'command' as const, command: 'npm test' };
    expect(decidePermission('agent', 'run', target, [])).to.equal('ask');
    expect(decidePermission('agent', 'run', target, [], true)).to.equal('allow');
  });

  it('lets the user run and lets a readOnly allow rule deny the agent', () => {
    const target = { kind: 'command' as const, command: 'npm test' };
    expect(decidePermission('user', 'run', target, [])).to.equal('allow');
    const rules: readonly PermissionRule[] = [
      {
        id: 'r1',
        enabled: true,
        principal: 'agent',
        resource: 'command',
        actions: '*',
        effect: 'allow',
        readOnly: true,
      },
    ];
    expect(decidePermission('agent', 'run', target, rules)).to.equal('deny');
  });
});
