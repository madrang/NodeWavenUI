/**
 * The boot of the specRunner page: runs the loaded specs and reports twice, once for
 * the human at the window through the rendered result list, and once for an attached
 * agent through the nodewavenSelftest page global.
 */
(function () {
  'use strict';

  var summary = document.getElementById('selftest-summary');
  var resultsList = document.getElementById('selftest-results');
  var state = {
    state: 'running',
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };
  globalThis.nodewavenSelftest = state;

  var env = jasmine.getEnv();
  env.configure({ random: false });

  function renderResult(result) {
    var item = document.createElement('li');
    item.className = `selftest-spec ${result.status}`;
    var name = document.createElement('span');
    name.className = 'selftest-spec-name';
    name.textContent = `${result.status === 'passed' ? '✔' : '✘'} ${result.fullName}`;
    item.append(name);
    for (var index = 0; index < result.failedExpectations.length; index += 1) {
      var message = document.createElement('div');
      message.className = 'selftest-spec-message';
      message.textContent = result.failedExpectations[index].message;
      item.append(message);
    }
    resultsList.append(item);
  }

  env.addReporter({
    specDone: function (result) {
      renderResult(result);
      state.total += 1;
      if (result.status === 'failed') {
        state.failed += 1;
        state.failures.push({
          name: result.fullName,
          messages: result.failedExpectations.map(function (expectation) {
            return expectation.message;
          }),
        });
        return;
      }
      if (result.status === 'disabled' || result.status === 'excluded' || result.status === 'pending') {
        state.skipped += 1;
        return;
      }
      state.passed += 1;
    },
    jasmineDone: function () {
      state.state = 'done';
      summary.textContent =
        state.failed === 0
          ? `Self test passed: ${state.passed} of ${state.total} specs.`
          : `Self test FAILED: ${state.failed} of ${state.total} specs.`;
      summary.classList.add(state.failed === 0 ? 'passed' : 'failed');
    },
  });

  // The window manager injects the page globals again 1.5 seconds after the open, because the
  // page loads after the window. The specs wait past that pass, so they see the injected API.
  function waitForPageGlobals(deadline, then) {
    if (typeof globalThis.nodewavenMcp === 'object' || Date.now() >= deadline) {
      then();
      return;
    }
    window.setTimeout(function () {
      waitForPageGlobals(deadline, then);
    }, 50);
  }

  waitForPageGlobals(Date.now() + 3000, function () {
    env.execute();
  });
})();
