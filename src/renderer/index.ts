/**
 * Launcher window entry point and screen controller.
 * The launcher window runs two screens: the launcher (folder selection) and the setup wizard.
 * The workspace window (main.html) opens as its own window, and this window closes once it reports readiness.
 */

import { closeWindow, resizeWindowLocked } from '../shared/nw.js';
import type { WorkspaceDirectory, WorkspaceSettings } from '../shared/workspace.js';
import { requireElement } from './dom.js';
import { mcpHostConfigFromProcess } from './mcp-host.js';
import { readAppArguments, readAppVersion, HELP_TEXT } from './arguments.js';
import { PluginManager } from '../plugins.js';
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

/** The launcher width. The manifest fixes the height for the compact state. */
const LAUNCHER_WINDOW_WIDTH = 300;

/** How long the launcher shows a fatal argument error before the window closes. */
const ARGUMENT_ERROR_CLOSE_MILLISECONDS = 4000;

/**
 * Reads the positional argument of the command line as a workspace path.
 * The NW.js App argv carries only the forwarded arguments, so the first entry that is not an option is the path.
 *
 * @returns The path, or null when the command line carries no positional argument.
 */
function readPositionalWorkspaceArgument(): string | null {
  const appArgv = (globalThis as { nw?: { App?: { argv?: unknown } } }).nw?.App?.argv;
  if (!Array.isArray(appArgv)) {
    return null;
  }
  for (const item of appArgv) {
    if (typeof item === 'string' && item.length > 0 && !item.startsWith('-')) {
      return item;
    }
  }
  return null;
}

/**
 * Loads the workspace the positional argument names.
 * An invalid path logs the error, shows it on the launcher, and closes the window.
 */
function loadWorkspaceFromArgument(): void {
  const candidate = readPositionalWorkspaceArgument();
  if (candidate === null) {
    return;
  }
  const marker = readWorkspaceMarker(candidate);
  if (marker === null) {
    const message = `"${candidate}" holds no NodeWavenUI workspace.`;
    console.error(`[NodeWavenUI] ${message}`);
    showLauncherStatus(message);
    window.setTimeout(() => {
      closeWindow();
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

/** The app arguments, read once at startup. */
const appArguments = readAppArguments();

/** The screen that is showing. The launcher starts visible, and the manifest fixes its window size. */
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
    resizeWindowLocked(LAUNCHER_WINDOW_WIDTH, height);
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
  closeWindow();
}

function finishWizard(
  directory: WorkspaceDirectory,
  settings: WorkspaceSettings,
  password: string | null,
): void {
  const setup = plugins.getStorageSetup(settings.storageId);
  if (setup === undefined) {
    showScreen('launcher');
    showLauncherStatus(`The storage "${settings.storageId}" is not registered.`);
    return;
  }
  const backend = setup.open(
    password !== null
      ? { directoryPath: directory.path, config: settings.storageConfig, password }
      : { directoryPath: directory.path, config: settings.storageConfig },
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
    if (migrated !== null) {
      settings = migrated;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the workspace data migration did not complete: ${message}`);
  }
  const setup = plugins.getStorageSetup(settings.storageId);
  if (setup === undefined) {
    showLauncherStatus(`The storage "${settings.storageId}" of this workspace is not registered.`);
    return;
  }
  if (!setup.needsPassword) {
    const backend = setup.open({ directoryPath: directory.path, config: settings.storageConfig });
    const migrated = await migrateLegacyStorage(directory.path, settings, backend, null);
    if (migrated !== null) {
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

function handleSelectedDirectory(directory: WorkspaceDirectory): void {
  const marker = readWorkspaceMarker(directory.path);
  if (marker !== null) {
    void openExistingWorkspace(directory, marker);
    return;
  }
  const entries = readDirectoryEntries(directory.path);
  const note =
    entries !== null && entries.length > 0
      ? 'This folder holds files but no workspace. The wizard initializes it.'
      : null;
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
  closeWindow();
});

const launcherCloseText = requireElement<HTMLButtonElement>('#launcher-close-text');
launcherCloseText.addEventListener('click', () => {
  closeWindow();
});

selectButton.addEventListener('click', async () => {
  selectButton.disabled = true;
  try {
    const directory = await selectWorkspaceDirectory();
    if (directory !== null) {
      handleSelectedDirectory(directory);
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
  if (setup === undefined) {
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
      if (migrated !== null) {
        await launchWorkspaceWindow(directory, migrated.settings, new WorkspaceSettingsStore(migrated.backend), unlockPassword.value);
        return;
      }
      await launchWorkspaceWindow(directory, settings, store, unlockPassword.value);
    } catch (error) {
      unlockPassword.disabled = false;
      showLauncherStatus(error instanceof Error ? error.message : String(error));
    }
});

initializeTheme();
showScreen('launcher');
// One global catch for rejected promises, so the stderr log carries every unhandled failure.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error(`[NodeWavenUI] unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});
// The print-and-quit arguments run before anything else opens.
if (appArguments.version) {
  console.info(`NodeWavenUI ${readAppVersion()}`);
}
if (appArguments.help) {
  console.info(`[NodeWavenUI] ${HELP_TEXT}`);
}
if (appArguments.version || appArguments.help) {
  closeWindow();
} else {
  // The MCP host logs its enabled state at boot. The server itself starts when the workspace window opens,
  // because the access token persists in the workspace storage.
  try {
    const mcpHostBoot = mcpHostConfigFromProcess();
    if (mcpHostBoot !== null) {
      console.info(
        `[NodeWavenUI] MCP host enabled: it listens on ${mcpHostBoot.interface}:${mcpHostBoot.port} when the workspace window opens.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[NodeWavenUI] the MCP host argument is invalid: ${message}`);
  }
  loadWorkspaceFromArgument();
}
console.info('[NodeWavenUI] renderer ready');
