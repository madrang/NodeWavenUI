/**
 * Specs for the chat session reader: a damaged record reads as null, whole.
 */

import { expect } from 'chai';
import { readStoredChatSession } from '../../dist/renderer/chat-sessions.js';

/** One session record with test defaults. */
function session(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chat-1',
    title: 'Chat 1',
    createdAt: '2026-11-03T10:00:00.000Z',
    entries: [],
    ...overrides,
  };
}

describe('the chat session reader', () => {
  it('reads a minimal session', () => {
    const read = readStoredChatSession(session());
    expect(read).to.deep.equal({
      id: 'chat-1',
      title: 'Chat 1',
      createdAt: '2026-11-03T10:00:00.000Z',
      entries: [],
    });
  });

  it('keeps the optionals and the bound system prompt', () => {
    const read = readStoredChatSession(
      session({
        boundProviderId: 'openai-main',
        boundModel: 'gpt-test',
        contextTokens: 120,
        outputTokens: 340,
        systemPrompt: { sourceId: 'agents-md', title: 'AGENTS.md', text: 'Be terse.' },
      }),
    );
    expect(read).to.not.equal(null);
    expect(read?.boundProviderId).to.equal('openai-main');
    expect(read?.boundModel).to.equal('gpt-test');
    expect(read?.contextTokens).to.equal(120);
    expect(read?.outputTokens).to.equal(340);
    expect(read?.systemPrompt).to.deep.equal({ sourceId: 'agents-md', title: 'AGENTS.md', text: 'Be terse.' });
  });

  it('reads every entry role and drops unknown fields', () => {
    const read = readStoredChatSession(
      session({
        entries: [
          { role: 'user', content: 'hello', images: [{ data: 'aGk=', mimeType: 'image/png' }], queued: true, extra: 'drop' },
          { role: 'assistant', content: '', reasoning: 'thought', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
          { role: 'tool', content: 'result', toolCallId: 'c1', toolName: 'read', mcpSession: '2f2c2809' },
          { role: 'notice', content: 'noted' },
          { role: 'error', content: 'failed' },
        ],
      }),
    );
    expect(read?.entries).to.have.lengthOf(5);
    expect(read?.entries[0]).to.deep.equal({
      role: 'user',
      content: 'hello',
      images: [{ data: 'aGk=', mimeType: 'image/png' }],
      queued: true,
    });
    expect(read?.entries[1]?.reasoning).to.equal('thought');
    expect(read?.entries[1]?.toolCalls).to.deep.equal([{ id: 'c1', name: 'read', arguments: '{}' }]);
    expect(read?.entries[2]).to.deep.equal({
      role: 'tool',
      content: 'result',
      toolCallId: 'c1',
      toolName: 'read',
      mcpSession: '2f2c2809',
    });
  });

  it('reads null for a damaged record, whole', () => {
    expect(readStoredChatSession(null)).to.equal(null);
    expect(readStoredChatSession('chat')).to.equal(null);
    expect(readStoredChatSession(session({ title: 7 }))).to.equal(null);
    expect(readStoredChatSession(session({ entries: 'none' }))).to.equal(null);
    expect(readStoredChatSession(session({ entries: [{ role: 'system', content: 'x' }] }))).to.equal(null);
    expect(readStoredChatSession(session({ entries: [{ role: 'user' }] }))).to.equal(null);
    expect(
      readStoredChatSession(session({ entries: [{ role: 'assistant', content: 'x', toolCalls: [{ id: 'c', name: 'n', arguments: 3 }] }] })),
    ).to.equal(null);
  });

  it('reads null for damaged optionals, including the system prompt', () => {
    expect(readStoredChatSession(session({ contextTokens: '120' }))).to.equal(null);
    expect(readStoredChatSession(session({ boundModel: null }))).to.equal(null);
    expect(readStoredChatSession(session({ systemPrompt: { sourceId: 'agents-md', title: 'AGENTS.md' } }))).to.equal(null);
    expect(readStoredChatSession(session({ systemPrompt: { sourceId: '', title: 'x', text: '' } }))).to.equal(null);
  });
});
