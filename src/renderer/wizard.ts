/**
 * The setup wizard screen: names the workspace and configures the settings storage.
 * The wizard runs for folders without a workspace marker, and it writes the marker when it finishes.
 * The storage section lists every registered storage setup, and the selected setup renders its own configuration.
 */

import { closeWindow, resizeWindowLocked } from '../shared/nw.js';
import type { WorkspaceDirectory, WorkspaceSettings } from '../shared/workspace.js';
import { readAppVersion } from './arguments.js';
import { requireElement } from './dom.js';
import { PluginFieldGroup } from './plugin-fields.js';
import type { StorageSetup } from '../plugins.js';
import { writeWorkspaceMarker } from './workspace-files.js';

/** Callbacks the wizard reports to the screen controller. */
export interface WizardCallbacks {
  /** Reports a validated workspace after its marker file is written. */
  readonly onFinish: (settings: WorkspaceSettings, password: string | null) => void;
  /** Reports the back action, which returns to the launcher for a new folder selection. */
  readonly onBack: () => void;
}

const WIZARD_WINDOW_WIDTH = 440;

/**
 * Runs the wizard for one folder.
 * The caller shows the wizard screen first.
 *
 * @param directory The folder the user selected.
 * @param note A lead-in line, or null for a blank folder.
 * @param setups The registered storage setups for the dropdown.
 * @param callbacks The finish and back reporting.
 */
export function startWizard(
  directory: WorkspaceDirectory,
  note: string | null,
  setups: readonly StorageSetup[],
  callbacks: WizardCallbacks,
): void {
  const nameInput = requireElement<HTMLInputElement>('#wizard-name');
  const noteElement = requireElement<HTMLElement>('#wizard-note');
  const form = requireElement<HTMLFormElement>('#wizard-form');
  const storageSelect = requireElement<HTMLSelectElement>('#wizard-storage');
  const storageConfigContainer = requireElement<HTMLElement>('#wizard-storage-config');
  const errorElement = requireElement<HTMLElement>('#wizard-error');
  const closeButton = requireElement<HTMLButtonElement>('#wizard-close');
  const backButton = requireElement<HTMLButtonElement>('#wizard-back');
  const submitButton = requireElement<HTMLButtonElement>('#wizard-submit');
  const wizardHeader = requireElement<HTMLElement>('.wizard-header');
  const wizardFooter = requireElement<HTMLElement>('.wizard-footer');

  nameInput.value = directory.name;
  noteElement.hidden = note === null;
  noteElement.textContent = note ?? '';

  let activeSetup: StorageSetup | null = null;
  let activeFields: PluginFieldGroup | null = null;

  const showError = (message: string): void => {
    errorElement.hidden = false;
    errorElement.textContent = message;
    fitWindowToContent();
  };

  /** Measures the natural form height by suspending the flex growth for one synchronous read. */
  const measureFormHeight = (): number => {
    const previousFlex = form.style.flex;
    form.style.flex = 'none';
    const height = form.offsetHeight;
    form.style.flex = previousFlex;
    return height;
  };

  /** Resizes the window so the whole wizard content fits without scrolling. */
  const fitWindowToContent = (): void => {
    requestAnimationFrame(() => {
      const height = wizardHeader.offsetHeight + measureFormHeight() + wizardFooter.offsetHeight;
      // A hidden screen measures zero on every part, and a resize to height zero collapses the window.
      if (height <= 0) {
        return;
      }
      resizeWindowLocked(WIZARD_WINDOW_WIDTH, height);
    });
  };

  /** Renders the UI definition of the selected storage setup. */
  const updateStorageConfig = (): void => {
    activeSetup = setups.find((candidate) => candidate.id === storageSelect.value) ?? null;
    activeFields = null;
    storageConfigContainer.replaceChildren();
    if (activeSetup !== null) {
      activeFields = PluginFieldGroup.mount(storageConfigContainer, activeSetup.fields ?? []);
    }
    fitWindowToContent();
  };

  for (const setup of setups) {
    const option = document.createElement('option');
    option.value = setup.id;
    option.textContent = setup.label;
    storageSelect.append(option);
  }
  storageSelect.addEventListener('change', updateStorageConfig);
  updateStorageConfig();

  closeButton.addEventListener('click', () => {
    closeWindow();
  });

  backButton.addEventListener('click', () => {
    callbacks.onBack();
  });

  // The submit button sits in the fixed footer outside the form, so it submits the form programmatically.
  submitButton.addEventListener('click', () => {
    form.requestSubmit();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const setup = activeSetup;
    const name = nameInput.value.trim();
    if (name.length === 0) {
      showError('The workspace needs a name.');
      return;
    }
    if (setup === null) {
      showError('Select a setting storage.');
      return;
    }
    let config: unknown;
    let password: string | null = null;
    const values = activeFields !== null ? activeFields.readValues() : {};
    const configuration = setup.readConfiguration(values);
    if (typeof configuration === 'string') {
      showError(configuration);
      return;
    }
    config = configuration.config;
    password = configuration.password;
    const settings: WorkspaceSettings = {
      name,
      storageId: setup.id,
      storageConfig: config,
      createdAt: new Date().toISOString(),
      version: readAppVersion(),
    };
    const writeError = writeWorkspaceMarker(directory.path, settings);
    if (writeError !== null) {
      showError(writeError);
      return;
    }
    errorElement.hidden = true;
    callbacks.onFinish(settings, password);
  });
}
