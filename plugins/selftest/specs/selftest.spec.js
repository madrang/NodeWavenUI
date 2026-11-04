/**
 * The DOM specs of the app self test. They run inside the real NW.js engine, in a child
 * window of the app, so they verify the environment the app pages actually run in.
 */

describe('the NW.js engine of the app', function () {
  it('exposes the nw global to app pages', function () {
    expect(typeof globalThis.nw).toBe('object');
    expect(globalThis.nw).not.toBe(null);
  });

  it('ships the EditContext API the Editor window builds on', function () {
    // The Editor window constructs and drives its instance the same way (src/renderer/editor.ts).
    expect(typeof globalThis.EditContext).toBe('function');
    const context = new globalThis.EditContext({ text: 'hello' });
    expect(context.text).toBe('hello');
    context.updateText(0, context.text.length, 'hello!');
    expect(context.text).toBe('hello!');
    context.updateSelection(0, 3);
    expect(context.selectionStart).toBe(0);
    expect(context.selectionEnd).toBe(3);
  });
});

describe('the child window environment', function () {
  it('rides the nodewavenMcp page API into child windows', function () {
    expect(typeof globalThis.nodewavenMcp).toBe('object');
    expect(typeof globalThis.nodewavenMcp.list).toBe('function');
  });

  it('serves the plugin folder as a web root', function () {
    // This page itself loads from plugins/selftest/, and the Jasmine bundle with it.
    const link = document.querySelector('link[rel="stylesheet"]');
    expect(link).not.toBe(null);
    expect(link.getAttribute('href')).toBe('vendor/jasmine.css');
    expect(typeof globalThis.jasmine).toBe('object');
  });
});
