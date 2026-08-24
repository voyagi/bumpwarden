import type { BriefRecord } from '../core/brief.js';
import type {
  ActionRecord,
  BumpRecord,
  ProjectSummary,
  RunRecord,
  WatchedRepository,
} from '../core/records.js';
import type { Band } from '../core/types.js';

export interface BumpQuery {
  repositoryId: string;
  band?: Band;
  limit: number;
}

export interface ActionQuery {
  repositoryId?: string;
  limit: number;
}

/**
 * A lease on the right to run. It carries an expiry rather than being held forever because a
 * container killed mid-run would otherwise leave the claim standing and nothing could ever run
 * again, and nobody can reach into Firestore to clear it while the service is the only writer.
 */
export interface RunClaim {
  key: string;
  /**
   * Unique per attempt, and deliberately not the run id: a run id is derived from the start
   * instant, so two presses inside the same millisecond carry the same one and would each read the
   * other's lease as their own.
   */
  holder: string;
  /** Recorded so an operator reading the lock document can see which run is holding it. */
  runId: string;
  claimedAt: string;
  expiresAt: string;
}

/** The one lease. A run reads and writes GitHub and Firestore, so two of anything overlap. */
export const RUN_CLAIM_KEY = 'run';

/**
 * A held claim only stops counting once its expiry has passed, and an expiry that does not parse
 * never passes: a lease this service wrote itself is always an ISO string, so an unreadable one
 * means the document is not what this code wrote, and starting a second run on that reading is the
 * failure this lease exists to prevent.
 */
export function claimHeld(held: RunClaim, holder: string, at: string): boolean {
  if (held.holder === holder) return false;

  const expires = Date.parse(held.expiresAt);
  const now = Date.parse(at);
  if (!Number.isFinite(expires) || !Number.isFinite(now)) return true;
  return expires > now;
}

/**
 * Everything the run writes and the dashboard reads. It is an interface rather than a Firestore
 * handle so the test suite and local development run with no credentials at all, and so the
 * dashboard can be built and proven before a Google Cloud project exists.
 */
export interface BumpwardenStore {
  listWatchedRepositories(): Promise<WatchedRepository[]>;
  putWatchedRepository(repository: WatchedRepository): Promise<void>;

  /**
   * Take the run lease, or answer false because someone else holds it. The check and the write are
   * one atomic step: the dashboard's run button is public, so two presses a millisecond apart both
   * read "nothing is running" and a guard that reads before it writes lets both through.
   */
  claimRun(claim: RunClaim): Promise<boolean>;
  releaseRun(key: string, holder: string): Promise<void>;

  saveRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  listRuns(limit: number): Promise<RunRecord[]>;

  saveBump(bump: BumpRecord): Promise<void>;
  getBump(repositoryId: string, key: string): Promise<BumpRecord | null>;
  listBumps(query: BumpQuery): Promise<BumpRecord[]>;

  appendAction(action: ActionRecord): Promise<void>;
  listActions(query: ActionQuery): Promise<ActionRecord[]>;

  getBrief(cacheKey: string): Promise<BriefRecord | null>;
  putBrief(record: BriefRecord): Promise<void>;

  putProjectSummary(summary: ProjectSummary): Promise<void>;
  listProjectSummaries(): Promise<ProjectSummary[]>;
}
