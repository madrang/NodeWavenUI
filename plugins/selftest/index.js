/**
 * The selftest plugin. Its payload is the specRunner page, which the window tools open
 * in a child window to run the app self test inside the real NW.js engine.
 * The plugin registers its own harness document, so the resource list and the page
 * appear and leave together with the plugin folder.
 */

module.exports = {
  id: 'selftest',
  setup(registry) {
    registry.registerHarnessDoc({
      uri: 'harness:///nodewavenui/selftest.md',
      file: '/plugins/selftest/selftest.md',
      name: 'selftest',
      description: 'The app self test: run the specRunner page in a child window and read nodewavenSelftest.',
    });
  },
};
