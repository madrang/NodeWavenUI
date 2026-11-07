/**
 * Specs for the frame address mapping: the kind and side guards, and the address each embed loads.
 */

import { expect } from 'chai';
import { isFrameKind, isFrameSide, resolveFrameUrl } from '../../dist/renderer/frames.js';

describe('the frame kind and side guards', () => {
  it('accepts the two kinds and the two sides, nothing else', () => {
    expect(isFrameKind('iframe')).to.equal(true);
    expect(isFrameKind('webview')).to.equal(true);
    expect(isFrameKind('window')).to.equal(false);
    expect(isFrameKind(null)).to.equal(false);
    expect(isFrameSide('left')).to.equal(true);
    expect(isFrameSide('right')).to.equal(true);
    expect(isFrameSide('top')).to.equal(false);
    expect(isFrameSide(1)).to.equal(false);
  });
});

describe('the frame address mapping', () => {
  it('resolves a relative path against the origin root, stripping repeated separators', () => {
    expect(resolveFrameUrl('dist/renderer/graphs.html', 'chrome-extension://app')).to.equal(
      'chrome-extension://app/dist/renderer/graphs.html',
    );
    expect(resolveFrameUrl('/plugins/selftest/specRunner.html', 'chrome-extension://app/')).to.equal(
      'chrome-extension://app/plugins/selftest/specRunner.html',
    );
  });

  it('passes absolute addresses unchanged, whatever their scheme', () => {
    expect(resolveFrameUrl('https://example.com/page', 'chrome-extension://app')).to.equal('https://example.com/page');
    expect(resolveFrameUrl('http://127.0.0.1:9666/', 'chrome-extension://app')).to.equal('http://127.0.0.1:9666/');
    expect(resolveFrameUrl('file:///tmp/page.html', 'chrome-extension://app')).to.equal('file:///tmp/page.html');
    expect(resolveFrameUrl('chrome-extension://app/dist/renderer/graphs.html', 'chrome-extension://app')).to.equal(
      'chrome-extension://app/dist/renderer/graphs.html',
    );
  });
});
