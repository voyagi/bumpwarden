import type { RunRecord, Trigger } from '../core/records.js';

/**
 * The orchestrator refuses a second concurrent run by throwing, and both endpoints have to answer
 * 409 rather than 500 for it. They test the name rather than the class so this module keeps no
 * dependency on the orchestrator, which the architecture rules read as a cycle.
 */
export const RUN_IN_PROGRESS = 'RunInProgressError';

/**
 * Checks whether an error indicates that a run is already in progress.
 */
export function isRunInProgress(error: unknown): boolean {
  return error instanceof Error && error.name === RUN_IN_PROGRESS;
}

/**
 * Options for starting a new run.
 */
export interface StartRunOptions {
  trigger: Trigger;
  /** A manual run may be scoped to one project; a scheduled run covers the whole watch list. */
  repositoryId?: string;
}

/**
 * The one way anything outside the orchestrator starts a run. It lives in its own module so the
 * scheduler endpoint and the dashboard can both depend on the shape without depending on each
 * other, which the architecture rules would otherwise read as a cycle.
 */
export type StartRun = (options: StartRunOptions) => Promise<RunRecord>;
