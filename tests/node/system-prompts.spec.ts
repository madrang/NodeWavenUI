/**
 * Specs for the system prompt helpers: the prompt files of the instructions folder list as sources,
 * the selectors of the menu shape from a selection, a send reads its pick and resolves its sources,
 * several texts join into one prompt, and the AGENTS.md file of the workspace root moves into the folder.
 */

import { expect } from 'chai';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  joinSystemPromptTexts,
  listPromptFileSources,
  moveWorkspaceAgentsFile,
  promptFileId,
  readSystemPromptIds,
  resolvePromptSelectors,
  resolveSystemPromptSources,
  withPromptSelectorChange,
} from '../../dist/shared/system-prompts.js';
import {
  joinPath,
  listDirectoryNames,
  makeDirectory,
  readTextFile,
  renamePath,
  statPath,
} from '../../dist/worker/node-file-system.js';

/** The fs slice of the specs: the worker fs over a real temp folder. */
const fs = { joinPath, listDirectoryNames, readTextFile, statPath, makeDirectory, renamePath };

/** Creates one fresh temp workspace and removes it after the spec. */
function freshWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'nwprompt-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('the prompt files of the instructions folder', () => {
  let root: string;
  let cleanup: () => void;

  beforeEach(() => {
    const fresh = freshWorkspace();
    root = fresh.root;
    cleanup = fresh.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  /** Writes one file of the instructions folder, and creates the folder when missing. */
  function writePromptFile(name: string, text: string): void {
    mkdirSync(join(root, 'instructions'), { recursive: true });
    writeFileSync(join(root, 'instructions', name), text);
  }

  it('lists nothing while the folder is missing', async () => {
    expect(await listPromptFileSources(root, fs)).to.deep.equal([]);
  });

  it('lists every file in name order, and no folder', async () => {
    writePromptFile('skills.md', 'Use the read tool.');
    writePromptFile('AGENTS.md', 'Be terse.');
    mkdirSync(join(root, 'instructions', 'notes'));
    const sources = await listPromptFileSources(root, fs);
    expect(sources.map((source) => source.id)).to.deep.equal([promptFileId('AGENTS.md'), promptFileId('skills.md')]);
    expect(sources.map((source) => source.label)).to.deep.equal(['AGENTS.md', 'skills.md']);
    expect(await sources[1]?.build({ workspacePath: root })).to.equal('Use the read tool.');
  });

  it('lists no hidden file, with a name that starts with a dot', async () => {
    writePromptFile('rules.md', 'Be terse.');
    writePromptFile('.rules.md.swp', 'swap');
    writePromptFile('.#rules.md', 'lock');
    const sources = await listPromptFileSources(root, fs);
    expect(sources.map((source) => source.id)).to.deep.equal([promptFileId('rules.md')]);
  });

  it('builds the text of a file, and fails once the file is gone', async () => {
    writePromptFile('rules.md', 'Be terse.');
    const source = (await listPromptFileSources(root, fs))[0];
    expect(await source?.build({ workspacePath: root })).to.equal('Be terse.');
    rmSync(join(root, 'instructions', 'rules.md'));
    let failure: unknown;
    try {
      await source?.build({ workspacePath: root });
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
  });
});

describe('the selectors of the system prompt menu', () => {
  const base = { id: 'base' };
  const rules = { id: 'rules' };
  const sources = [base, rules];

  it('starts with one selector on none while nothing is selected', () => {
    expect(resolvePromptSelectors(sources, [])).to.deep.equal({
      selected: [],
      slots: [{ slot: 0, selectedId: null, choices: [base, rules] }],
    });
  });

  it('adds the selector of the next slot while a source stays unselected', () => {
    expect(resolvePromptSelectors(sources, ['base'])).to.deep.equal({
      selected: ['base'],
      slots: [
        { slot: 0, selectedId: 'base', choices: [base, rules] },
        { slot: 1, selectedId: null, choices: [rules] },
      ],
    });
  });

  it('adds no selector once every source is selected', () => {
    const shaped = resolvePromptSelectors(sources, ['rules', 'base']);
    expect(shaped.selected).to.deep.equal(['rules', 'base']);
    expect(shaped.slots).to.deep.equal([
      { slot: 0, selectedId: 'rules', choices: [rules] },
      { slot: 1, selectedId: 'base', choices: [base] },
    ]);
  });

  it('drops a selected id that names no source', () => {
    const shaped = resolvePromptSelectors(sources, ['rules', 'gone', 'rules']);
    expect(shaped.selected).to.deep.equal(['rules']);
    expect(shaped.slots.map((slot) => slot.slot)).to.deep.equal([0, 1]);
  });

  it('answers no slot while the menu lists no source', () => {
    expect(resolvePromptSelectors([], ['base'])).to.deep.equal({ selected: [], slots: [] });
  });
});

describe('the change of one selector', () => {
  it('takes its slot, and the selection goes on from there', () => {
    expect(withPromptSelectorChange(['base', 'rules'], 1, 'skills')).to.deep.equal(['base', 'skills']);
  });

  it('ends the selection at its slot on none', () => {
    expect(withPromptSelectorChange(['base', 'rules'], 0, null)).to.deep.equal([]);
    expect(withPromptSelectorChange(['base', 'rules'], 1, null)).to.deep.equal(['base']);
  });
});

describe('the sources of a first send', () => {
  const base = { id: 'base' };
  const rules = { id: 'rules' };
  const sources = [base, rules];

  it('read the default source when the sender holds no menu', () => {
    expect(resolveSystemPromptSources(undefined, sources)).to.deep.equal([base]);
    expect(resolveSystemPromptSources(undefined, [])).to.deep.equal([]);
  });

  it('read the none prompt for an empty pick', () => {
    expect(resolveSystemPromptSources([], sources)).to.deep.equal([]);
  });

  it('keep the order of the pick, and drop an id that names no source', () => {
    expect(resolveSystemPromptSources(['rules', 'gone', 'base', 'rules'], sources)).to.deep.equal([rules, base]);
  });

  it('read the default source for a pick that names no known source', () => {
    expect(resolveSystemPromptSources(['gone'], sources)).to.deep.equal([base]);
  });
});

describe('the system prompt pick of one send', () => {
  it('keeps an empty list as the none pick, and drops the elements that are no string', () => {
    expect(readSystemPromptIds([])).to.deep.equal([]);
    expect(readSystemPromptIds(['rules', 2, 'base'])).to.deep.equal(['rules', 'base']);
  });

  it('reads no pick from a list that holds no string, or from a value of another shape', () => {
    expect(readSystemPromptIds([2])).to.equal(undefined);
    expect(readSystemPromptIds('rules')).to.equal(undefined);
    expect(readSystemPromptIds(undefined)).to.equal(undefined);
  });
});

describe('the prompt text of several sources', () => {
  it('joins the texts with a blank line, and an empty text adds nothing', () => {
    expect(joinSystemPromptTexts(['Be terse.\n\n', '', '  Use the read tool.\n\n\n'])).to.equal(
      'Be terse.\n\n  Use the read tool.',
    );
    expect(joinSystemPromptTexts(['', '  '])).to.equal('');
  });
});

describe('the AGENTS.md file of the workspace root', () => {
  let root: string;
  let cleanup: () => void;

  beforeEach(() => {
    const fresh = freshWorkspace();
    root = fresh.root;
    cleanup = fresh.cleanup;
  });

  afterEach(() => {
    cleanup();
  });

  it('moves into the instructions folder, and a second run moves nothing', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'Be terse.');
    expect(await moveWorkspaceAgentsFile(root, fs)).to.equal('moved');
    expect(readdirSync(root)).to.deep.equal(['instructions']);
    expect(readFileSync(join(root, 'instructions', 'AGENTS.md'), 'utf-8')).to.equal('Be terse.');
    expect(await moveWorkspaceAgentsFile(root, fs)).to.equal('absent');
  });

  it('moves nothing and creates no folder while the root holds no file', async () => {
    expect(await moveWorkspaceAgentsFile(root, fs)).to.equal('absent');
    expect(readdirSync(root)).to.deep.equal([]);
  });

  it('keeps both files while the target exists', async () => {
    writeFileSync(join(root, 'AGENTS.md'), 'At the root.');
    mkdirSync(join(root, 'instructions'));
    writeFileSync(join(root, 'instructions', 'AGENTS.md'), 'In the folder.');
    expect(await moveWorkspaceAgentsFile(root, fs)).to.equal('kept');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf-8')).to.equal('At the root.');
    expect(readFileSync(join(root, 'instructions', 'AGENTS.md'), 'utf-8')).to.equal('In the folder.');
  });

  it('moves nothing for a folder of that name at the root', async () => {
    mkdirSync(join(root, 'AGENTS.md'));
    expect(await moveWorkspaceAgentsFile(root, fs)).to.equal('absent');
  });
});
