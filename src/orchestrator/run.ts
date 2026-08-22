import { randomUUID } from 'node:crypto';
import { writeBrief, type BriefEngine } from '../agent/write-brief.js';
import type { BriefRequest } from '../agent/prompt.js';
import { briefCacheKey, unavailableBrief, type BriefRecord } from '../core/brief.js';
import { bumpKey } from '../core/bump-key.js';
import { bumpTitle, type BumpSummary } from '../core/issue-body.js';
import {
  LABEL_ROOT,
  PER_RUN_BUDGETS,
  POLICY_VERSION,
  RUN_TIME_BUDGET_SECONDS,
  ruleFor,
} from '../core/policy.js';
import {
  ZERO_COUNTS,
  actionIdFor,
  countBands,
  projectSummaryFor,
  runIdFor,
  summarizeRepositories,
  type ActionOutcome,
  type ActionRecord,
  type BumpRecord,
  type RepositoryResult,
  type RunRecord,
  type Trigger,
  type WatchedRepository,
} from '../core/records.js';
import { RUBRIC_VERSION } from '../core/rubric.js';
import { scoreBump } from '../core/scorer.js';
import type { CandidateBump, MissingSource, Score } from '../core/types.js';
import type { RepositoryActor } from '../io/github-actor.js';
import type { RepoRef } from '../io/github.js';
import type { RunFetcher } from '../io/http.js';
import { silentLogger, type Logger } from '../io/log.js';
import { RUN_CLAIM_KEY, type BumpwardenStore } from '../io/store.js';
import { actOnBump, type ActContext } from './act.js';
import { ingestRepository } from './ingest.js';
import { collectSourceFiles } from './source-files.js';

/**
 * What the dashboard's "actions" number counts. A dry run, a skip and a failure are all recorded in
 * the audit log, but none of them changed anything on GitHub, so none of them is an action taken.
 */
const LANDED = new Set<ActionOutcome>(['opened', 'updated', 'commented']);

export interface RunOptions {
  trigger: Trigger;
  /** A manual run may be scoped to one project; a scheduled run covers the whole watch list. */
  repositoryId?: string;
  maxDependencies?: number;
  briefBudget?: number;
  actionBudget?: number;
}

/**
 * What a run will actually spend, resolved in one place. The Policy page publishes these numbers,
 * so the defaults are the published constants rather than literals sitting next to a `??`, and
 * `run.test.ts` pins the two together.
 */
export function resolveBudgets(options: RunOptions): { brief: number; action: number } {
  return {
    brief: options.briefBudget ?? PER_RUN_BUDGETS.briefs,
    action: options.actionBudget ?? PER_RUN_BUDGETS.actions,
  };
}

export interface RunDependencies {
  store: BumpwardenStore;
  now: () => Date;
  createFetcher: () => RunFetcher;
  createActor: (repository: WatchedRepository) => RepositoryActor | null;
  engine: BriefEngine | null;
  githubToken: string | null;
  dashboardBaseUrl: string | null;
  /** Left out by tests, which have no use for the line the deployed service writes per run. */
  logger?: Logger;
}

function summaryOf(repository: WatchedRepository, candidate: CandidateBump): BumpSummary {
  return {
    key: bumpKey({
      owner: repository.owner,
      repo: repository.repo,
      dependency: candidate.dependency,
      candidateVersion: candidate.candidateVersion,
    }),
    repositoryId: repository.id,
    dependency: candidate.dependency,
    currentVersion: candidate.currentVersion,
    candidateVersion: candidate.candidateVersion,
  };
}

function briefRequestFor(bump: BumpSummary, candidate: CandidateBump, score: Score): BriefRequest {
  return {
    bumpKey: bump.key,
    repositoryId: bump.repositoryId,
    dependency: candidate.dependency,
    currentVersion: candidate.currentVersion,
    candidateVersion: candidate.candidateVersion,
    band: score.band,
    score: score.total,
    releaseNotes: candidate.release.notes,
    releaseNotesSource: candidate.release.notesSource,
    commitSubjects: candidate.release.commitSubjects,
    usageSites: candidate.usageSites,
    changedFiles: candidate.release.changedFiles ?? [],
  };
}

function noBrief(request: BriefRequest, at: Date, model: string, reason: string): BriefRecord {
  return unavailableBrief({
    bumpKey: request.bumpKey,
    cacheKey: briefCacheKey(request.bumpKey, RUBRIC_VERSION),
    model,
    rubricVersion: RUBRIC_VERSION,
    generatedAt: at.toISOString(),
    attempts: 0,
    truncated: false,
    reason,
  });
}

async function briefFor(
  deps: RunDependencies,
  request: BriefRequest,
  refusal: string | null,
  at: Date,
): Promise<BriefRecord> {
  if (!deps.engine) return noBrief(request, at, 'none', 'no Gemini API key is configured');
  if (refusal) return noBrief(request, at, deps.engine.model, refusal);

  return writeBrief(request, {
    engine: deps.engine,
    rubricVersion: RUBRIC_VERSION,
    now: at,
    cache: {
      get: (key) => deps.store.getBrief(key),
      put: (record) => deps.store.putBrief(record),
    },
  });
}

function skippedAction(runId: string, bump: BumpSummary, score: Score, at: Date): ActionRecord {
  const rule = ruleFor(score.band);
  return {
    id: actionIdFor(runId, bump.key),
    bumpKey: bump.key,
    bumpTitle: bumpTitle(bump),
    repositoryId: bump.repositoryId,
    runId,
    ruleId: rule.id,
    kind: rule.kind,
    outcome: 'skipped',
    url: null,
    number: null,
    at: at.toISOString(),
    detail: 'over the per-run action budget, carried to the next run',
    score: score.total,
    band: score.band,
  };
}

async function loadActorContext(
  deps: RunDependencies,
  repository: WatchedRepository,
  runId: string,
  at: Date,
  missing: MissingSource[],
): Promise<ActContext> {
  const actor = deps.createActor(repository);
  const context: ActContext = {
    actor,
    canWrite: false,
    defaultBranch: repository.ref === 'HEAD' ? 'main' : repository.ref,
    existing: [],
    openPullRequests: [],
    runId,
    at,
    dashboardBaseUrl: deps.dashboardBaseUrl,
  };

  if (!actor) {
    missing.push({
      what: 'GitHub write access',
      why: 'no token is configured, so actions are dry runs',
    });
    return context;
  }

  try {
    const facts = await actor.facts();
    context.canWrite = facts.canWrite;
    context.defaultBranch = facts.defaultBranch;
    context.existing = await actor.listBumpwardenIssues(LABEL_ROOT);
    context.openPullRequests = await actor.listOpenPullRequests();
  } catch (error) {
    missing.push({
      what: 'GitHub write access',
      why: error instanceof Error ? error.message : 'the repository could not be read',
    });
  }

  if (actor && !context.canWrite) {
    missing.push({
      what: 'GitHub write access',
      why: 'the token cannot push to this repository, so actions are dry runs',
    });
  }

  return context;
}

interface ProcessedBump {
  record: BumpRecord;
  action: ActionRecord;
}

async function processBump(
  deps: RunDependencies,
  repository: WatchedRepository,
  context: ActContext,
  scored: { candidate: CandidateBump; score: Score },
  budgets: { brief: string | null; action: boolean },
): Promise<ProcessedBump> {
  const at = context.at;
  const bump = summaryOf(repository, scored.candidate);
  const request = briefRequestFor(bump, scored.candidate, scored.score);
  const brief = await briefFor(deps, request, budgets.brief, at);

  const action = budgets.action
    ? await actOnBump(context, { bump, score: scored.score, brief })
    : skippedAction(context.runId, bump, scored.score, at);

  const previous = await deps.store.getBump(repository.id, bump.key);
  return {
    action,
    record: {
      key: bump.key,
      runId: context.runId,
      repositoryId: repository.id,
      dependency: bump.dependency,
      currentVersion: bump.currentVersion,
      candidateVersion: bump.candidateVersion,
      score: scored.score,
      brief,
      action,
      firstSeenAt: previous?.firstSeenAt ?? at.toISOString(),
      updatedAt: at.toISOString(),
    },
  };
}

/**
 * Why a bump gets no brief, or null when it should get one. Both limits are published, and both are
 * refusals rather than failures: the bump is still scored, still acted on, and the reason is stored
 * on the record so the page says which limit was reached.
 */
function briefRefusal(index: number, budget: number, overtime: boolean): string | null {
  if (index >= budget) return 'over the per-run brief budget';
  if (overtime) return `over the per-run time budget of ${RUN_TIME_BUDGET_SECONDS} seconds`;
  return null;
}

async function runRepository(
  deps: RunDependencies,
  options: RunOptions,
  repository: WatchedRepository,
  runId: string,
  at: Date,
  deadline: number,
): Promise<RepositoryResult> {
  const logger = deps.logger ?? silentLogger;
  const fetcher = deps.createFetcher();
  const readStarted = performance.now();
  const target: RepoRef = { owner: repository.owner, repo: repository.repo, ref: repository.ref };
  const missing: MissingSource[] = [];

  const sources = await collectSourceFiles(fetcher, target, deps.githubToken);
  missing.push(...sources.missing);

  const ingest = await ingestRepository(fetcher, target, {
    githubToken: deps.githubToken,
    sourceFiles: sources.files,
    maxDependencies: options.maxDependencies,
  });
  missing.push(...ingest.missing);

  const reads = fetcher.stats();
  logger.info('repository read', {
    runId,
    repository: repository.id,
    dependencies: ingest.dependenciesConsidered,
    bumps: ingest.bumps.length,
    calls: reads.calls,
    cacheHits: reads.cacheHits,
    bytes: reads.bytes,
    seconds: Math.round((performance.now() - readStarted) / 100) / 10,
  });

  const context = await loadActorContext(deps, repository, runId, at, missing);
  const scored = ingest.bumps
    .map((candidate) => ({ candidate, score: scoreBump(candidate, at) }))
    .sort((left, right) => right.score.total - left.score.total);

  const { brief: briefBudget, action: actionBudget } = resolveBudgets(options);
  let actions = 0;

  for (const [index, entry] of scored.entries()) {
    const processed = await processBump(deps, repository, context, entry, {
      brief: briefRefusal(index, briefBudget, deps.now().getTime() >= deadline),
      action: index < actionBudget,
    });
    await deps.store.appendAction(processed.action);
    await deps.store.saveBump(processed.record);
    if (LANDED.has(processed.action.outcome)) actions += 1;

    logger.info('bump handled', {
      runId,
      bump: processed.record.key,
      score: processed.record.score.total,
      band: processed.record.score.band,
      rule: processed.action.ruleId,
      outcome: processed.action.outcome,
      url: processed.action.url,
    });
  }

  const counts = countBands(scored.map((entry) => entry.score.band));
  const result: RepositoryResult = {
    repositoryId: repository.id,
    dependenciesConsidered: ingest.dependenciesConsidered,
    counts,
    actions,
    missing,
    error: null,
  };

  const existing = await deps.store
    .listProjectSummaries()
    .then((summaries) => summaries.find((summary) => summary.repository.id === repository.id));

  await deps.store.putProjectSummary({
    ...projectSummaryFor(repository, existing ?? null),
    lastRunId: runId,
    lastRunAt: at.toISOString(),
    lastRunStatus: 'finished',
    counts,
    actions,
    worstScore: scored[0]?.score.total ?? 0,
  });

  return result;
}

/**
 * Thrown rather than returned as a run record: a refused start produced no run, and inventing an
 * empty one would put a run in the audit log that never happened.
 */
export class RunInProgressError extends Error {
  constructor() {
    super('a run is already going');
    this.name = 'RunInProgressError';
  }
}

/**
 * How long a claim stands before another run may take it. Long enough to cover the run's own time
 * budget plus the reads and writes around it, short enough that a container killed mid-run does not
 * leave the button dead for an afternoon.
 */
const CLAIM_LEASE_MS = (RUN_TIME_BUDGET_SECONDS + 600) * 1000;

/**
 * The one run path. Cloud Scheduler's OIDC call and the dashboard's "Run now" both land here and
 * differ only in the recorded trigger, so what a judge sees after pressing the button is the same
 * artifact the nightly run produces.
 */
export async function executeRun(deps: RunDependencies, options: RunOptions): Promise<RunRecord> {
  const startedAt = deps.now();
  const id = runIdFor(startedAt, options.trigger);

  // Claimed before anything is read or written. The status check in front of the button is a
  // courtesy that tells a visitor why; this is the thing that actually stops a second run.
  const holder = randomUUID();
  const claimed = await deps.store.claimRun({
    key: RUN_CLAIM_KEY,
    holder,
    runId: id,
    claimedAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + CLAIM_LEASE_MS).toISOString(),
  });
  if (!claimed) throw new RunInProgressError();

  try {
    return await runClaimed(deps, options, id, startedAt);
  } finally {
    // A rejection here would replace whatever the run returned or threw, turning a finished run
    // into a store error the caller answers 500 to. The lease expires on its own, so failing to
    // hand it back early is a delay rather than a fault.
    await deps.store.releaseRun(RUN_CLAIM_KEY, holder).catch((error: unknown) => {
      (deps.logger ?? silentLogger).error('lease not released', { runId: id, error });
    });
  }
}

async function runClaimed(
  deps: RunDependencies,
  options: RunOptions,
  id: string,
  startedAt: Date,
): Promise<RunRecord> {
  const logger = deps.logger ?? silentLogger;

  const watched = await deps.store.listWatchedRepositories();
  const repositories = options.repositoryId
    ? watched.filter((repository) => repository.id === options.repositoryId)
    : watched;

  const opened: RunRecord = {
    id,
    trigger: options.trigger,
    status: 'running',
    scope: options.repositoryId ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    repositories: [],
    counts: { ...ZERO_COUNTS },
    actionsTaken: 0,
    rubricVersion: RUBRIC_VERSION,
    policyVersion: POLICY_VERSION,
    error: null,
  };

  // Written before any work so a dashboard poll during a long run sees a running run rather than
  // nothing at all.
  await deps.store.saveRun(opened);
  logger.info('run started', {
    runId: id,
    trigger: options.trigger,
    scope: opened.scope,
    repositories: repositories.length,
    rubricVersion: RUBRIC_VERSION,
    policyVersion: POLICY_VERSION,
  });

  const deadline = startedAt.getTime() + RUN_TIME_BUDGET_SECONDS * 1000;
  const results: RepositoryResult[] = [];
  for (const repository of repositories) {
    try {
      results.push(await runRepository(deps, options, repository, id, deps.now(), deadline));
    } catch (error) {
      logger.error('repository failed', { runId: id, repository: repository.id, error });
      results.push({
        repositoryId: repository.id,
        dependenciesConsidered: 0,
        counts: { ...ZERO_COUNTS },
        actions: 0,
        missing: [],
        error: error instanceof Error ? error.message : 'the repository could not be processed',
      });
    }
  }

  const summary = summarizeRepositories(results);
  const finished: RunRecord = {
    ...opened,
    status: 'finished',
    finishedAt: deps.now().toISOString(),
    repositories: results,
    counts: summary.counts,
    actionsTaken: summary.actions,
  };

  await deps.store.saveRun(finished);
  logger.info('run finished', {
    runId: id,
    counts: summary.counts,
    actionsTaken: summary.actions,
    seconds: Math.round(
      (new Date(finished.finishedAt as string).getTime() - startedAt.getTime()) / 1000,
    ),
  });
  return finished;
}
