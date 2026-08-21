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
 * Everything the run writes and the dashboard reads. It is an interface rather than a Firestore
 * handle so the test suite and local development run with no credentials at all, and so the
 * dashboard can be built and proven before a Google Cloud project exists.
 */
export interface BumpwardenStore {
  listWatchedRepositories(): Promise<WatchedRepository[]>;
  putWatchedRepository(repository: WatchedRepository): Promise<void>;

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
