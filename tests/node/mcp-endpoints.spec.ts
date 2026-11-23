/**
 * Specs for the MCP endpoint contract: the label sanitizer, the label collisions, and the record guards.
 */

import { expect } from 'chai';
import {
  endpointLabelCollisions,
  isMcpEndpoint,
  isMcpEndpoints,
  sanitizeEndpointLabel,
  type McpEndpoint,
} from '../../dist/shared/mcp-endpoints.js';

describe('the endpoint label sanitizer', () => {
  it('lowercases and keeps letters, digits, and dashes', () => {
    expect(sanitizeEndpointLabel('My Vault')).to.equal('my-vault');
    expect(sanitizeEndpointLabel('Vault 2')).to.equal('vault-2');
    expect(sanitizeEndpointLabel('UPPER')).to.equal('upper');
  });

  it('collapses repeated separators and trims the edges', () => {
    expect(sanitizeEndpointLabel('a--b')).to.equal('a-b');
    expect(sanitizeEndpointLabel(' --x-- ')).to.equal('x');
    expect(sanitizeEndpointLabel('a_b/c')).to.equal('a-b-c');
  });

  it('falls back to "mcp" when nothing usable remains', () => {
    expect(sanitizeEndpointLabel('')).to.equal('mcp');
    expect(sanitizeEndpointLabel('!!!')).to.equal('mcp');
    expect(sanitizeEndpointLabel('---')).to.equal('mcp');
  });
});

describe('the endpoint label collisions', () => {
  const native = (id: string, label: string): McpEndpoint => ({
    id,
    label,
    transport: { kind: 'http', url: `https://${id}/mcp` },
    mode: 'native',
  });

  it('blocks the later native endpoint of one sanitized prefix and keeps the first', () => {
    const collisions = endpointLabelCollisions([native('a', 'My Vault'), native('b', 'my-vault!')]);
    expect([...collisions.keys()]).to.deep.equal(['b']);
    expect(collisions.get('b')).to.match(/"my-vault!" sanitizes to "my-vault", the same tool prefix as "My Vault"\./u);
  });

  it('ignores the other modes, even on one prefix', () => {
    const other: McpEndpoint = { ...native('b', 'my-vault'), mode: 'preloaded' };
    const dormant: McpEndpoint = { ...native('c', 'my-vault'), mode: 'none' };
    expect([...endpointLabelCollisions([native('a', 'My Vault'), other, dormant]).keys()]).to.deep.equal([]);
  });

  it('blocks every later endpoint of one prefix, and clears when the labels differ again', () => {
    const first = [native('a', 'Vault'), native('b', 'VAULT'), native('c', 'vault-')];
    expect([...endpointLabelCollisions(first).keys()]).to.deep.equal(['b', 'c']);
    expect([...endpointLabelCollisions([native('a', 'Vault'), native('b', 'Other')]).keys()]).to.deep.equal([]);
  });

  it('blocks the empty-label fallback prefix like any other', () => {
    const collisions = endpointLabelCollisions([native('a', '!!!'), native('b', '---')]);
    expect([...collisions.keys()]).to.deep.equal(['b']);
    expect(collisions.get('b')).to.match(/sanitizes to "mcp"/u);
  });
});

describe('the endpoint guard', () => {
  it('accepts a valid http endpoint with and without a token', () => {
    expect(
      isMcpEndpoint({
        id: 'a',
        label: 'Vault',
        transport: { kind: 'http', url: 'https://vault.local/mcp' },
        mode: 'native',
      }),
    ).to.equal(true);
    expect(
      isMcpEndpoint({
        id: 'a',
        label: 'Vault',
        transport: { kind: 'http', url: 'https://vault.local/mcp', token: 'secret' },
        mode: 'disabled',
      }),
    ).to.equal(true);
  });

  it('accepts a valid stdio endpoint with string args', () => {
    expect(
      isMcpEndpoint({
        id: 'a',
        label: 'Vault',
        transport: { kind: 'stdio', command: 'vault-mcp', args: ['--json'] },
        mode: 'none',
      }),
    ).to.equal(true);
  });

  it('rejects broken shapes', () => {
    const good = { id: 'a', label: 'Vault', transport: { kind: 'http', url: 'https://v/mcp' }, mode: 'native' };
    expect(isMcpEndpoint(null)).to.equal(false);
    expect(isMcpEndpoint('a')).to.equal(false);
    expect(isMcpEndpoint({ ...good, id: '' })).to.equal(false);
    expect(isMcpEndpoint({ ...good, transport: { kind: 'ftp', url: 'x' } })).to.equal(false);
    expect(isMcpEndpoint({ ...good, transport: { kind: 'http', url: '' } })).to.equal(false);
    expect(isMcpEndpoint({ ...good, transport: { kind: 'stdio', command: '' } })).to.equal(false);
    expect(isMcpEndpoint({ ...good, transport: { kind: 'stdio', command: 'x', args: ['a', 2] } })).to.equal(false);
    expect(isMcpEndpoint({ ...good, mode: 'fast' })).to.equal(false);
  });
});

describe('the endpoint list guard', () => {
  it('accepts an empty list and rejects one damaged entry whole', () => {
    expect(isMcpEndpoints({ endpoints: [] })).to.equal(true);
    expect(isMcpEndpoints({ endpoints: 'none' })).to.equal(false);
    expect(
      isMcpEndpoints({
        endpoints: [
          { id: 'a', label: 'A', transport: { kind: 'http', url: 'https://a/mcp' }, mode: 'native' },
          { id: '', label: 'B', transport: { kind: 'http', url: 'https://b/mcp' }, mode: 'native' },
        ],
      }),
    ).to.equal(false);
  });
});
