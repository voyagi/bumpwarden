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
  /**
   * True when another run held this repository and this one left it alone. Kept apart from `error`
   * because "nobody read it this time" and "reading it went wrong" are different answers, and a
   * page that dates a project by its last run must not count either as coverage.
   */
  skipped?: boolean;
}

export interface RunRecord {
  id: string;
  trigger: Trigger;
  status: RunStatus;
  /**
   * The repository a manual run was scoped to, null for the whole watch list. A running run has no
   * results yet, so this is the only thing that tells the dashboard which project's Run now button
   * is currently busy.
   */
  scope: string | null;
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
  /** `express 4.18.2 to 5.2.1`, stored so the audit log renders without a read per row. */
  bumpTitle: string;
  repositoryId: string;
  runId: string;
  ruleId: PolicyRuleId;
  kind: ActionKind;
  outcome: ActionOutcome;
  url: string | null;
  number: number | null;
  at: string;
  detail: string;
  /**
   * The score that decided this action, stored with it. An audit entry that cannot say how risky
   * the bump was is a log line rather than an audit, and re-reading the bump per row is the read
   * fan-out the store exists to avoid.
   */
  score: number;
  band: Band;
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
  /** The highest score in the last run, so Home shows a reading rather than only a tally. */
  worstScore: number;
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
    worstScore: existing?.worstScore ?? 0,
  };
}

/** The band a project reads as overall: the worst one present, since that is what needs a person. */
export function worstBand(counts: BandCounts): Band {
  if (counts.red > 0) return 'red';
  if (counts.amber > 0) return 'amber';
  return 'green';
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
