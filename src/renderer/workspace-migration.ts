/**
 * The data format migration of a workspace.
 * The marker file carries the app version that last wrote the data, and this runner walks the migration
 * steps that fall between the detected version and the running app version. Only the first two numbers
 * of a version matter for the compare, so a patch release never migrates data. A marker without a
 * version predates versioning and counts as the oldest format.
 */

import type { WorkspaceSettings } from '../shared/workspace.js';
import { writeWorkspaceMarker } from './workspace-files.js';
import { readAppVersion } from './arguments.js';

/** What one migration step works on and reports back. */
export interface FormatMigrationContext {
  /** The absolute workspace folder path. */
  readonly directoryPath: string;
  /** The workspace settings as they are now. */
  readonly settings: WorkspaceSettings;
}

/** One migration step from one app-version prefix to the next. */
export interface FormatMigrationStep {
  /** The format prefix this step upgrades from, for example "0.1". */
  readonly from: string;
  /** The format prefix after this step, for example "0.2". */
  readonly to: string;
  /** What the step changes, for the log. */
  readonly description: string;
  apply(context: FormatMigrationContext): Promise<WorkspaceSettings>;
}

/**
 * The migration steps in order. Each step covers one prefix range.
 * No step exists yet: the data format never changed since versioning began.
 */
const FORMAT_MIGRATION_STEPS: readonly FormatMigrationStep[] = [];

/**
 * Reads the compare prefix of a version: the first two numbers.
 *
 * @param version The version string, for example "0.1.0".
 * @returns The prefix, for example "0.1". A damaged version reads as "0.0".
 */
export function formatPrefixOf(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  return match === null ? '0.0' : `${match[1]}.${match[2]}`;
}

/** Compares two format prefixes numerically: negative when the first is older, zero when equal. */
function compareFormatPrefix(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const leftMajor = Number.parseInt(leftParts[0] ?? '0', 10);
  const leftMinor = Number.parseInt(leftParts[1] ?? '0', 10);
  const rightMajor = Number.parseInt(rightParts[0] ?? '0', 10);
  const rightMinor = Number.parseInt(rightParts[1] ?? '0', 10);
  if (leftMajor !== rightMajor) {
    return leftMajor - rightMajor;
  }
  return leftMinor - rightMinor;
}

/**
 * Runs the data format migration of one workspace.
 * Every step whose range falls between the marker version and the running app version applies, in order,
 * so a workspace that skips releases still meets every format change. The runner rewrites the marker only
 * when the version changed, so an up-to-date workspace stays untouched.
 *
 * @param directoryPath The absolute workspace folder path.
 * @param settings The workspace settings from the marker.
 * @returns The updated settings, or null when nothing changed.
 */
export async function migrateWorkspaceData(
  directoryPath: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettings | null> {
  const runningVersion = readAppVersion();
  const detectedPrefix = formatPrefixOf(settings?.version ?? '0.0');
  const runningPrefix = formatPrefixOf(runningVersion);
  if (compareFormatPrefix(detectedPrefix, runningPrefix) > 0) {
    console.warn(
      `[NodeWavenUI] the workspace "${directoryPath}" carries data version ${settings?.version ?? 'none'}, newer than app ${runningVersion}. No migration runs.`,
    );
    return null;
  }
  let current: WorkspaceSettings = settings;
  for (const step of FORMAT_MIGRATION_STEPS) {
    const fromPrefix = formatPrefixOf(step.from);
    const toPrefix = formatPrefixOf(step.to);
    const inRange =
      compareFormatPrefix(detectedPrefix, fromPrefix) <= 0 && compareFormatPrefix(fromPrefix, runningPrefix) < 0;
    if (!inRange || compareFormatPrefix(toPrefix, runningPrefix) > 0) {
      continue;
    }
    console.info(`[NodeWavenUI] migrating workspace data ${step.from} to ${step.to}: ${step.description}`);
    current = await step.apply({ directoryPath, settings: current });
  }
  if ((current.version ?? '') === runningVersion) {
    return null;
  }
  const migrated: WorkspaceSettings = { ...current, version: runningVersion };
  const writeError = writeWorkspaceMarker(directoryPath, migrated);
  if (writeError !== null) {
    console.warn(`[NodeWavenUI] the migrated marker could not be written: ${writeError}`);
    return null;
  }
  return migrated;
}
