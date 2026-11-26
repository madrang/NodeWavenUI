/**
 * The data format migration of a workspace, launcher stage.
 * The marker file carries the app version that last wrote the data, and this runner walks the migration
 * steps that fall between the loaded version and the running app version. The stage runs at workspace
 * open, on the data that needs no key. The core stage (`src/worker/workspace-migration.ts`) runs the
 * steps on the data only the core opens, and compares the same loaded version, which the start message
 * carries (`src/shared/workspace-migration.ts` holds the compare).
 * The stage writes no marker. The workspace page stamps the running version once the core reports
 * ready, so the marker keeps its loaded version until both stages succeeded, and a failed step of
 * either stage runs again at the next open.
 */

import type { WorkspaceSettings } from '../shared/workspace.js';
import {
  type FormatMigrationStep as SharedFormatMigrationStep,
  formatStepApplies,
  formatVersionIsNewer,
} from '../shared/workspace-migration.js';
import { joinPath, makeDirectory, renamePath, statPath } from './file-system.js';
import { readAppVersion } from './arguments.js';
import { log } from './logger.js';
import {
  moveWorkspaceAgentsFile,
  WORKSPACE_AGENTS_FILE,
  WORKSPACE_INSTRUCTIONS_FOLDER,
} from '../shared/system-prompts.js';

/** What one migration step works on and reports back. */
export interface FormatMigrationContext {
  /** The absolute workspace folder path. */
  readonly directoryPath: string;
  /** The workspace settings as they are now. */
  readonly settings: WorkspaceSettings;
}

/** One migration step of the launcher stage, from one app-version prefix to the next. */
export interface FormatMigrationStep extends SharedFormatMigrationStep {
  apply(context: FormatMigrationContext): Promise<WorkspaceSettings>;
}

/** The answer of the launcher stage. */
export interface FormatMigrationResult {
  /** The workspace settings to open the workspace with: the ones a step changed, else the ones the
   * marker held. The version stays the one of the marker. */
  readonly settings: WorkspaceSettings;
  /** The exact version the marker carried at start. Undefined when the marker carried none. Every
   * later stage of the migration compares this version, whatever the marker holds now. */
  readonly loadedVersion: string | undefined;
  /** The running app version, when the marker holds another one: the workspace page writes it into the
   * marker once the core reports ready. Undefined when nothing is to be written. */
  readonly stampVersion: string | undefined;
}

/** Moves the AGENTS.md file of the workspace root into the instructions folder, where the system
 * prompt menu lists the file with the other prompt files. A root without the file moves nothing. A
 * failed move throws, so the runner stops and the marker keeps its version: the step runs again at
 * the next open. */
async function moveAgentsFile(context: FormatMigrationContext): Promise<WorkspaceSettings> {
  const outcome = await moveWorkspaceAgentsFile(context.directoryPath, {
    joinPath,
    statPath,
    makeDirectory,
    renamePath,
  });
  if (outcome === 'kept') {
    log.workspaceMigration.warning(
      `[NodeWavenUI] the workspace "${context.directoryPath}" holds an ${WORKSPACE_AGENTS_FILE} file in its root and in its ` +
        `${WORKSPACE_INSTRUCTIONS_FOLDER} folder. Both files stay in place.`,
    );
  }
  return context.settings;
}

/** The migration steps in order. Each step covers one prefix range. */
const FORMAT_MIGRATION_STEPS: readonly FormatMigrationStep[] = [
  {
    from: '0.3',
    to: '0.4',
    description: `the ${WORKSPACE_AGENTS_FILE} file of the workspace root moves into the ${WORKSPACE_INSTRUCTIONS_FOLDER} folder`,
    apply: moveAgentsFile,
  },
];

/**
 * Runs the format steps of the launcher stage on one workspace.
 * Every step whose range falls between the loaded version and the running app version applies, in order,
 * so a workspace that skips releases still meets every format change. The stage writes no marker: it
 * names the version the workspace page stamps once the core reports ready, so an up-to-date workspace
 * stays untouched and a failed step of either stage runs again at the next open.
 *
 * @param directoryPath The absolute workspace folder path.
 * @param settings The workspace settings from the marker.
 * @returns The settings to open the workspace with, the exact version the marker carried, and the
 * version the workspace page stamps.
 */
export async function migrateWorkspaceData(
  directoryPath: string,
  settings: WorkspaceSettings,
): Promise<FormatMigrationResult> {
  const loadedVersion = settings.version;
  const runningVersion = await readAppVersion();
  if (formatVersionIsNewer(loadedVersion, runningVersion)) {
    log.workspaceMigration.warning(
      `[NodeWavenUI] the workspace "${directoryPath}" carries data version ${loadedVersion ?? 'none'}, newer than app ${runningVersion}. No migration runs.`,
    );
    return { settings, loadedVersion, stampVersion: undefined };
  }
  let current: WorkspaceSettings = settings;
  for (const step of FORMAT_MIGRATION_STEPS) {
    if (!formatStepApplies(step, loadedVersion, runningVersion)) {
      continue;
    }
    log.workspaceMigration.informative(
      `[NodeWavenUI] migrating workspace data ${step.from} to ${step.to}: ${step.description}`,
    );
    current = await step.apply({ directoryPath, settings: current });
  }
  // The marker keeps its version here. The workspace page stamps the running version once the core
  // reports ready, so a failed step of the core stage runs again at the next open.
  return {
    settings: current,
    loadedVersion,
    stampVersion: (current.version ?? '') === runningVersion ? undefined : runningVersion,
  };
}
