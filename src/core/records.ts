import type { BriefRecord } from './brief.js';
import type { ActionKind, PolicyRuleId } from './policy.js';
import type { Band, MissingSource, Score } from './types.js';

export type Trigger = 'scheduled' | 'manual';
export type RunStatus = 'running' | 'finished' | 'failed';
export type ActionOutcome = 'opened' | 'updated' | 'commented' | 'dry-run' | 'skipped' | 'failed';

export interface WatchedRepository {
  /** `owner/repo`, which is also the Firestore document id and the dashboard route segment. */
  id: string;
  owner: string;
  repo: string;
  ref: string;
  /** Only a demo project may be triggered by a visitor from the dashboard. */
  demo: boolean;
}

export interface BandCounts {
  green: number;
  amber: number;
  red: number;
}

export const ZERO_COUNTS: BandCounts = { green: 0, amber: 0, red: 0 };

export function countBands(bands: Band[]): BandCounts {
  const counts: BandCounts = { ...ZERO_COUNTS };
  for (const band of bands) counts[band] += 1;
  return counts;
}

export function addCounts(left: BandCounts, right: BandCounts): BandCounts {
  return {
    green: left.green + right.green,
    amber: left.amber + right.amber,
    red: left.red + right.red,
  };
}

export function totalBumps(counts: BandCounts): number {
  return counts.green + counts.amber + counts.red;
}

export interface RepositoryResult {
  repositoryId: string;
  dependenciesConsidered: number;
  counts: BandCounts;
  actions: number;
  missing: MissingSource[];
  error: string | null;
}

export interface RunRecord {
  id: string;
  trigger: Trigger;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  repositories: RepositoryResult[];
  /**
   * Written with the run rather than counted when a page renders. The dashboard's home page then
   * costs one read per project instead of one read per bump, which is what keeps it inside the
   * Firestore free quota.
   */
  counts: BandCounts;
  actionsTaken: number;
  rubricVersion: string;
  policyVersion: string;
  error: string | null;
}

export interface ActionRecord {
  id: string;
  bumpKey: string;
  repositoryId: string;
  runId: string;
  ruleId: PolicyRuleId;
  kind: ActionKind;
  outcome: ActionOutcome;
  url: string | null;
  number: number | null;
  at: string;
  detail: string;
}

export interface BumpRecord {
  key: string;
  runId: string;
  repositoryId: string;
  dependency: string;
  currentVersion: string;
  candidateVersion: string;
  score: Score;
  brief: BriefRecord;
  action: ActionRecord | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface ProjectSummary {
  repository: WatchedRepository;
  lastRunId: string | null;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  counts: BandCounts;
  actions: number;
}

/**
 * Adding a repository to the watch list must not reset the counts a previous run wrote, and a
 * repository the dashboard has never run must still read as a complete summary rather than a
 * half-filled document. Both stores build the record here so they cannot drift apart.
 */
export function projectSummaryFor(
  repository: WatchedRepository,
  existing: ProjectSummary | null,
): ProjectSummary {
  return {
    repository,
    lastRunId: existing?.lastRunId ?? null,
    lastRunAt: existing?.lastRunAt ?? null,
    lastRunStatus: existing?.lastRunStatus ?? null,
    counts: existing?.counts ?? { ...ZERO_COUNTS },
    actions: existing?.actions ?? 0,
  };
}

function compactTimestamp(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, '');
}

/**
 * Derived from the start instant and the trigger, so a scheduler that fires the same job twice in
 * the same millisecond overwrites one record rather than filling the audit log with a phantom run.
 */
export function runIdFor(startedAt: Date, trigger: Trigger): string {
  return `run-${compactTimestamp(startedAt)}-${trigger}`;
}

/** One action per bump per run: a retry inside a run updates its record instead of adding one. */
export function actionIdFor(runId: string, bumpKey: string): string {
  return `${runId}|${bumpKey}`;
}

export function summarizeRepositories(results: RepositoryResult[]): {
  counts: BandCounts;
  actions: number;
} {
  return results.reduce(
    (accumulator, result) => ({
      counts: addCounts(accumulator.counts, result.counts),
      actions: accumulator.actions + result.actions,
    }),
    { counts: { ...ZERO_COUNTS }, actions: 0 },
  );
}
