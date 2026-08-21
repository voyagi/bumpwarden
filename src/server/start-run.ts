import type { RunRecord, Trigger } from '../core/records.js';

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
