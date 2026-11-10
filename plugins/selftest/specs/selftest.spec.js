/**
 * The DOM specs of the app self test. They run inside the real Electron engine, in a child
 * window or an embedded frame of the app, so they verify the environment the app pages run in.
 */

describe('the app engine of the Electron main process', function () {
  it('exposes the nodewavenui bridge to app pages', function () {
    expect(typeof globalThis.nodewavenui).toBe('object');
    expect(globalThis.nodewavenui).not.toBe(null);
    expect(typeof globalThis.nodewavenui.app.version).toBe('function');
    expect(typeof globalThis.nodewavenui.fs.readText).toBe('function');
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
    // The app theme link may sit before the bundle, so the spec looks for the bundle itself.
    const hrefs = Array.prototype.map.call(document.querySelectorAll('link[rel="stylesheet"]'), function (link) {
      return link.getAttribute('href');
    });
    expect(hrefs).toContain('vendor/jasmine.css');
    expect(typeof globalThis.jasmine).toBe('object');
  });
});
