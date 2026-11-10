/**
 * Launcher window entry point and screen controller.
 * The launcher window runs two screens: the launcher (folder selection) and the setup wizard.
 * The workspace window (main.html) opens as its own window, and this window closes once the
 * main process opened it.
 */

import type { WorkspaceDirectory, WorkspaceSettings } from '../shared/workspace.js';
import { readBridge } from '../shared/bridge.js';
import { requireElement } from './dom.js';
import { readAppArguments, readAppVersion, HELP_TEXT } from './arguments.js';
import { closeWindow, resizeWindowLocked } from './window-ops.js';
import { PluginManager } from './plugins.js';
import { registerBuiltinStorageSetups } from './storage-setups.js';
import { migrateLegacyStorage } from './storage-migration.js';
import { WorkspaceSettingsStore } from './settings-store.js';
import { resolveFrameMode } from './frame-mode.js';
import { launchMainWindow } from './main-window.js';
import { selectWorkspaceDirectory } from './workspace-picker.js';
import { readDirectoryEntries, readWorkspaceMarker } from './workspace-files.js';
import { migrateWorkspaceData } from './workspace-migration.js';
import { startWizard } from './wizard.js';
import { initializeTheme } from './theme.js';

/** The launcher width. The window creation fixes the height for the compact state. */
const LAUNCHER_WINDOW_WIDTH = 300;

/** How long the launcher shows a fatal argument error before the window closes. */
const ARGUMENT_ERROR_CLOSE_MILLISECONDS = 4000;

/**
 * Reads the positional argument of the command line as a workspace path.
 * The bridge carries only the forwarded arguments, so the first entry that is not an option is the path.
 *
 * @returns The path, or null when the command line carries no positional argument.
 */
async function readPositionalWorkspaceArgument(): Promise<string | null> {
  const bridge = readBridge();
  if (!bridge) {
    return null;
  }
  for (const item of await bridge.app.arguments()) {
    if (item.length > 0 && !item.startsWith('-')) {
      return item;
    }
  }
  return null;
}

/**
 * Loads the workspace the positional argument names.
 * An invalid path logs the error, shows it on the launcher, and closes the window.
 */
async function loadWorkspaceFromArgument(): Promise<void> {
  const candidate = await readPositionalWorkspaceArgument();
  if (!candidate) {
    return;
  }
  const marker = await readWorkspaceMarker(candidate);
  if (!marker) {
    const message = `"${candidate}" holds no NodeWavenUI workspace.`;
    console.error(`[NodeWavenUI] ${message}`);
    showLauncherStatus(message);
    window.setTimeout(() => {
      void closeWindow();
    }, ARGUMENT_ERROR_CLOSE_MILLISECONDS);
    return;
  }
  const name = candidate.split(/[\\/]/).filter((part) => part.length > 0).at(-1) ?? candidate;
  void openExistingWorkspace({ name, path: candidate }, marker);
}

const screenLauncher = requireElement<HTMLElement>('#screen-launcher');
const screenWizard = requireElement<HTMLElement>('#screen-wizard');
const launcherHeader = requireElement<HTMLElement>('.launcher-header');
const launcherBody = requireElement<HTMLElement>('.launcher-body');
const launcherActions = requireElement<HTMLElement>('.launcher-actions');
const selectButton = requireElement<HTMLButtonElement>('#select-directory');
const launcherStatus = requireElement<HTMLElement>('#launcher-status');
const unlockForm = requireElement<HTMLFormElement>('#unlock-form');
const unlockPassword = requireElement<HTMLInputElement>('#unlock-password');

/** The workspace folder and settings that wait for the password unlock. */
const pendingUnlock: { directory: WorkspaceDirectory | null; settings: WorkspaceSettings | null } = {
  directory: null,
  settings: null,
};

/** The plugin registry of the app, seeded with the built-in storage setups. */
const plugins = new PluginManager();
registerBuiltinStorageSetups(plugins);

/** The screen that is showing. The launcher starts visible, and the window creation fixes its size. */
let currentScreen: 'launcher' | 'wizard' = 'launcher';

function showScreen(name: 'launcher' | 'wizard'): void {
  screenLauncher.hidden = name !== 'launcher';
  screenWizard.hidden = name !== 'wizard';
  if (currentScreen === name) {
    return;
  }
  currentScreen = name;
  if (name === 'launcher') {
    // Covers the way back from the wizard.
    fitLauncherToContent();
  }
}

/** Measures the natural body height by suspending the flex growth for one synchronous read. */
function measureLauncherBodyHeight(): number {
  const previousFlex = launcherBody.style.flex;
  launcherBody.style.flex = 'none';
  const height = launcherBody.offsetHeight;
  launcherBody.style.flex = previousFlex;
  return height;
}

/** Resizes the launcher window so its header, body, and actions fit without clipping. */
function fitLauncherToContent(): void {
  requestAnimationFrame(() => {
    // A hidden screen measures zero on every part, and a resize to height zero collapses the window.
    if (screenLauncher.hidden) {
      return;
    }
    const height = launcherHeader.offsetHeight + measureLauncherBodyHeight() + launcherActions.offsetHeight;
    void resizeWindowLocked(LAUNCHER_WINDOW_WIDTH, height);
  });
}

function showLauncherStatus(message: string | null): void {
  launcherStatus.hidden = message === null;
  launcherStatus.textContent = message ?? '';
  fitLauncherToContent();
}

/**
 * Opens the workspace window with the workspace data, then closes the launcher window.
 * The stored frame mode decides the window chrome. A failed launch shows its message on the launcher.
 */
async function launchWorkspaceWindow(
  directory: WorkspaceDirectory,
  settings: WorkspaceSettings,
  store: WorkspaceSettingsStore,
  password: string | null,
): Promise<void> {
  selectButton.disabled = true;
  let storedFrameMode: string | null = null;
  try {
    storedFrameMode = await store.loadFrameModePreference();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the stored window frame could not be read, the default applies: ${message}`);
  }
  try {
    await launchMainWindow({ directory, settings, password, frameMode: resolveFrameMode(storedFrameMode) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showLauncherStatus(message);
    selectButton.disabled = false;
    return;
  }
  void closeWindow();
}

function finishWizard(
  directory: WorkspaceDirectory,
  settings: WorkspaceSettings,
  password: string | null,
): void {
  const setup = plugins.getStorageSetup(settings.storageId);
  if (!setup) {
    showScreen('launcher');
    showLauncherStatus(`The storage "${settings.storageId}" is not registered.`);
    return;
  }
  const backend = setup.open(
    password ?
      { directoryPath: directory.path, config: settings.storageConfig, password } :
      { directoryPath: directory.path, config: settings.storageConfig },
  );
  void launchWorkspaceWindow(directory, settings, new WorkspaceSettingsStore(backend), password);
}

/** Returns to the launcher for a new folder selection. */
function backToLauncher(): void {
  showLauncherStatus(null);
  showScreen('launcher');
}

async function openExistingWorkspace(
  directory: WorkspaceDirectory,
  rawSettings: WorkspaceSettings,
): Promise<void> {
  let settings = rawSettings;
  try {
    const migrated = await migrateWorkspaceData(directory.path, rawSettings);
    if (migrated) {
      settings = migrated;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the workspace data migration did not complete: ${message}`);
  }
  const setup = plugins.getStorageSetup(settings.storageId);
  if (!setup) {
    showLauncherStatus(`The storage "${settings.storageId}" of this workspace is not registered.`);
    return;
  }
  if (!setup.needsPassword) {
    const backend = setup.open({ directoryPath: directory.path, config: settings.storageConfig });
    const migrated = await migrateLegacyStorage(directory.path, settings, backend, null);
    if (migrated) {
      void launchWorkspaceWindow(directory, migrated.settings, new WorkspaceSettingsStore(migrated.backend), null);
      return;
    }
    void launchWorkspaceWindow(directory, settings, new WorkspaceSettingsStore(backend), null);
    return;
  }
  pendingUnlock.directory = directory;
  pendingUnlock.settings = settings;
  showLauncherStatus('Enter the workspace password.');
  unlockForm.hidden = false;
  unlockPassword.value = '';
  unlockPassword.focus();
}

async function handleSelectedDirectory(directory: WorkspaceDirectory): Promise<void> {
  const marker = await readWorkspaceMarker(directory.path);
  if (marker) {
    void openExistingWorkspace(directory, marker);
    return;
  }
  const entries = await readDirectoryEntries(directory.path);
  const note =
    entries !== null && entries.length > 0 ?
      'This folder holds files but no workspace. The wizard initializes it.' :
      null;
  showScreen('wizard');
  startWizard(directory, note, plugins.listStorageSetups(), {
    onFinish: (settings, password) => {
      finishWizard(directory, settings, password);
    },
    onBack: () => {
      backToLauncher();
    },
  });
}

const launcherClose = requireElement<HTMLButtonElement>('#launcher-close');
launcherClose.addEventListener('click', () => {
  void closeWindow();
});

const launcherCloseText = requireElement<HTMLButtonElement>('#launcher-close-text');
launcherCloseText.addEventListener('click', () => {
  void closeWindow();
});

selectButton.addEventListener('click', async () => {
  selectButton.disabled = true;
  try {
    const directory = await selectWorkspaceDirectory();
    if (directory) {
      await handleSelectedDirectory(directory);
    }
  } catch (error) {
    showLauncherStatus(error instanceof Error ? error.message : String(error));
  } finally {
    selectButton.disabled = false;
  }
});

unlockForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const directory = pendingUnlock.directory;
  const settings = pendingUnlock.settings;
  if (directory === null || settings === null) {
    return;
  }
  const setup = plugins.getStorageSetup(settings.storageId);
  if (!setup) {
    showLauncherStatus(`The storage "${settings.storageId}" of this workspace is not registered.`);
    return;
  }
  const backend = setup.open({
    directoryPath: directory.path,
    config: settings.storageConfig,
    password: unlockPassword.value,
  });
  const store = new WorkspaceSettingsStore(backend);
  unlockPassword.disabled = true;
  try {
    // Any first store access verifies the password through the check record.
    await store.loadProviderRegistry();
    unlockPassword.disabled = false;
    // The screen switch hides the launcher. No intermediate shrink: a locked resize right before
    // the main resize loses on a transparent window, and the launcher size would stick.
    const migrated = await migrateLegacyStorage(directory.path, settings, backend, unlockPassword.value);
    if (migrated) {
      await launchWorkspaceWindow(
        directory,
        migrated.settings,
        new WorkspaceSettingsStore(migrated.backend),
        unlockPassword.value,
      );
      return;
    }
    await launchWorkspaceWindow(directory, settings, store, unlockPassword.value);
  } catch (error) {
    unlockPassword.disabled = false;
    showLauncherStatus(error instanceof Error ? error.message : String(error));
  }
});

// One global catch for rejected promises, so the stderr log carries every unhandled failure.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error(`[NodeWavenUI] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

/** Boots the launcher: the theme, the screens, then the argument flow. */
async function boot(): Promise<void> {
  console.info('[NodeWavenUI] launcher boot: theme');
  await initializeTheme();
  showScreen('launcher');
  console.info('[NodeWavenUI] launcher boot: arguments');
  const appArguments = await readAppArguments();
  // The print-and-quit arguments run before anything else opens.
  if (appArguments.version) {
    console.info(`NodeWavenUI ${await readAppVersion()}`);
  }
  if (appArguments.help) {
    console.info(`[NodeWavenUI] ${HELP_TEXT}`);
  }
  if (appArguments.version || appArguments.help) {
    void closeWindow();
    return;
  }
  console.info('[NodeWavenUI] launcher boot: workspace argument');
  await loadWorkspaceFromArgument();
  console.info('[NodeWavenUI] renderer ready');
}

void boot();
