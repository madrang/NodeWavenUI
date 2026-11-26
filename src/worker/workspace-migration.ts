/**
 * The data format migration of a workspace, core stage.
 * The migration runs in two stages, in two files, because the two processes open different data. The
 * launcher stage (`src/renderer/workspace-migration.ts`) runs at workspace open, on the data that needs
 * no key. This stage runs at core boot, before the core reads any chat session: a password workspace
 * seals every session file with its chat key, and only the core holds that key. Both stages compare the
 * version the launcher read in the marker at start, which the start message carries
 * (`src/shared/workspace-migration.ts` holds the compare). The marker keeps that version until the
 * workspace page hears that this core is ready, so a failed step here aborts the open and runs again
 * at the next open.
 */

import { NONE_SYSTEM_PROMPT_SETUP_ID } from '../shared/system-prompts.js';
import { type FormatMigrationStep, formatStepApplies } from '../shared/workspace-migration.js';
import type { ChatSessionStore } from './chat-sessions.js';
import { log } from './logger.js';

/** What one step of the core stage works on. */
export interface CoreFormatMigrationContext {
  /** The chat session store of the workspace, after its key loaded and before its first session read. */
  readonly chatSessions: ChatSessionStore;
}

/** One migration step of the core stage, from one app-version prefix to the next. */
export interface CoreFormatMigrationStep extends FormatMigrationStep {
  apply(context: CoreFormatMigrationContext): Promise<void>;
}

/**
 * Upgrades the bound prompt of one session record to the list of its source ids.
 * A record from before the list names one `sourceId`. That id becomes the one-element list, and the
 * none prompt becomes the empty list. The session reader refuses a record that still names the one id.
 *
 * @param record The parsed session record. The function changes the record.
 * @returns True when the record changed.
 */
export function upgradePromptSourceList(record: Record<string, unknown>): boolean {
  const prompt = record.systemPrompt;
  if (typeof prompt !== 'object' || !prompt || !Object.hasOwn(prompt, 'sourceId')) {
    return false;
  }
  const candidate = prompt as Record<string, unknown>;
  const sourceId = candidate.sourceId;
  delete candidate.sourceId;
  if (!Object.hasOwn(candidate, 'sourceIds') && typeof sourceId === 'string') {
    candidate.sourceIds = sourceId === NONE_SYSTEM_PROMPT_SETUP_ID ? [] : [sourceId];
  }
  return true;
}

/** The steps of the core stage, in order. Each step covers one prefix range. */
const CORE_FORMAT_MIGRATION_STEPS: readonly CoreFormatMigrationStep[] = [
  {
    from: '0.4',
    to: '0.5',
    description: 'the bound system prompt of every chat session names the list of its source ids',
    apply: async ({ chatSessions }) => {
      await chatSessions.upgradeSessionRecords(upgradePromptSourceList);
    },
  },
];

/**
 * Runs the format steps of the core stage on one workspace. Every step whose range falls between the
 * loaded version and the running app version applies, in order. A failed step throws, so the open
 * aborts: the marker keeps the version it held at load, and the step runs again at the next open.
 *
 * @param loadedVersion The exact version the launcher read in the marker at start. Undefined when the
 * marker carried none.
 * @param runningVersion The version of the running app.
 * @param context What the steps work on.
 */
export async function migrateCoreWorkspaceData(
  loadedVersion: string | undefined,
  runningVersion: string,
  context: CoreFormatMigrationContext,
): Promise<void> {
  for (const step of CORE_FORMAT_MIGRATION_STEPS) {
    if (!formatStepApplies(step, loadedVersion, runningVersion)) {
      continue;
    }
    log.worker.informative(
      `[NodeWavenUI] migrating workspace data ${step.from} to ${step.to}: ${step.description}`,
    );
    try {
      await step.apply(context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`The workspace data did not migrate from ${step.from} to ${step.to}: ${message}`, {
        cause: error,
      });
    }
  }
}
