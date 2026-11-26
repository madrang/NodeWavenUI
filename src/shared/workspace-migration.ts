/**
 * The version compare of the data format migration of a workspace.
 * The migration runs in two stages, in two files, because the two processes open different data: the
 * launcher stage (`src/renderer/workspace-migration.ts`) runs at workspace open, and the core stage
 * (`src/worker/workspace-migration.ts`) runs at core boot. Both compare the version the launcher read
 * in the marker at start against their step ranges through the helpers here.
 * Only the first two numbers of a version matter for the compare, so a patch release never migrates
 * data. A marker without a version predates versioning and counts as the oldest format.
 */

/** The range of one migration step, from one app-version prefix to the next. */
export interface FormatMigrationStep {
  /** The format prefix this step upgrades from, for example "0.1". */
  readonly from: string;
  /** The format prefix after this step, for example "0.2". */
  readonly to: string;
  /** What the step changes, for the log. */
  readonly description: string;
}

/**
 * Reads the compare prefix of a version: the first two numbers.
 *
 * @param version The version string, for example "0.1.0".
 * @returns The prefix, for example "0.1". A damaged version reads as "0.0".
 */
export function formatPrefixOf(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version.trim());
  return match ? `${match[1]}.${match[2]}` : '0.0';
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
 * Reads whether the loaded version is newer than the running app. No step of any stage applies then.
 *
 * @param loadedVersion The exact version the marker carried at start. Undefined when the marker
 * carried none.
 * @param runningVersion The version of the running app.
 * @returns True when the workspace data is newer than the app.
 */
export function formatVersionIsNewer(loadedVersion: string | undefined, runningVersion: string): boolean {
  return compareFormatPrefix(formatPrefixOf(loadedVersion ?? '0.0'), formatPrefixOf(runningVersion)) > 0;
}

/**
 * Reads whether one migration step applies to a workspace. The range of the step starts at or after
 * the loaded version and ends at or before the running version. A workspace that carries a newer
 * version than the app migrates nothing.
 *
 * @param step The step to test.
 * @param loadedVersion The exact version the marker carried at start. Undefined when the marker
 * carried none.
 * @param runningVersion The version of the running app.
 * @returns True when the step must run.
 */
export function formatStepApplies(
  step: FormatMigrationStep,
  loadedVersion: string | undefined,
  runningVersion: string,
): boolean {
  if (formatVersionIsNewer(loadedVersion, runningVersion)) {
    return false;
  }
  const loadedPrefix = formatPrefixOf(loadedVersion ?? '0.0');
  const runningPrefix = formatPrefixOf(runningVersion);
  const fromPrefix = formatPrefixOf(step.from);
  const toPrefix = formatPrefixOf(step.to);
  return (
    compareFormatPrefix(loadedPrefix, fromPrefix) <= 0 &&
    compareFormatPrefix(fromPrefix, runningPrefix) < 0 &&
    compareFormatPrefix(toPrefix, runningPrefix) <= 0
  );
}
