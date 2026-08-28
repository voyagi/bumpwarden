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
import { BRIEFS_IN_FLIGHT } from '../core/stack.js';
import type { CandidateBump, MissingSource, Score } from '../core/types.js';
import type { RepositoryActor } from '../io/github-actor.js';
import type { RepoRef } from '../io/github.js';
import type { RunFetcher } from '../io/http.js';
import { mapInFlight } from '../io/in-flight.js';
import { silentLogger, type Logger } from '../io/log.js';
import {
  RUN_CLAIM_KEY,
  SCOPED_RUN_CLAIM_KEY,
  repositoryClaimKey,
  type BumpwardenStore,
} from '../io/store.js';
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

/**
 * What is LEFT of a run's budget. The numbers above are published as per-run limits and a run can
 * cover the whole watch list, so resolving them inside each repository gave every repository its
 * own full allowance: five projects could ask for five times the briefs and take five times the
 * actions the Policy page promises. One of these is made per run and each repository takes from
 * what the ones before it left.
 */
export interface RunAllowance {
  briefs: number;
  actions: number;
}

export function allowanceFor(options: RunOptions): RunAllowance {
  const budgets = resolveBudgets(options);
  return { briefs: budgets.brief, actions: budgets.action };
}

/** Hands out up to `wanted` of what is left, and records what it handed out. */
function take(allowance: RunAllowance, of: keyof RunAllowance, wanted: number): number {
  const given = Math.max(0, Math.min(wanted, allowance[of]));
  allowance[of] -= given;
  return given;
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

  // `canWrite` is set last, and only once all three reads have come back, because writing depends
  // on the other two as much as on the permission. A listing that throws leaves `existing` empty,
  // an empty `existing` matches no bump marker, and a run that writes on that basis opens a second
  // issue for every bump that already had one. So a transient read failure makes the repository a
  // dry run rather than a duplicating one.
  let read = false;
  try {
    const facts = await actor.facts();
    context.defaultBranch = facts.defaultBranch;
    context.existing = await actor.listBumpwardenIssues(LABEL_ROOT);
    context.openPullRequests = await actor.listOpenPullRequests();
    context.canWrite = facts.canWrite;
    read = true;
  } catch (error) {
    missing.push({
      what: 'GitHub write access',
      why: error instanceof Error ? error.message : 'the repository could not be read',
    });
  }

  // Only when the reads succeeded and the answer was no. After a failure the token may well be
  // able to push, and saying otherwise would send an operator to check the wrong thing.
  if (read && !context.canWrite) {
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

interface QueuedBump {
  bump: BumpSummary;
  candidate: CandidateBump;
  score: Score;
}

async function processBump(
  repository: WatchedRepository,
  context: ActContext,
  queued: QueuedBump,
  brief: BriefRecord,
  act: boolean,
  /** Read before the budget was shared out, because what was reported before decides who gets it. */
  previous: BumpRecord | null,
): Promise<ProcessedBump> {
  const { bump, score } = queued;
  const at = context.at;

  const action = act
    ? await actOnBump(context, { bump, score, brief })
    : skippedAction(context.runId, bump, score, at);

  return {
    action,
    record: {
      key: bump.key,
      runId: context.runId,
      repositoryId: repository.id,
      dependency: bump.dependency,
      currentVersion: bump.currentVersion,
      candidateVersion: bump.candidateVersion,
      score,
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

/** A bump the reader has already been told about, on GitHub, by a run that landed something. */
function alreadyReported(record: BumpRecord | null | undefined): boolean {
  const outcome = record?.action?.outcome;
  return outcome !== undefined && LANDED.has(outcome);
}

/**
 * Which bumps the action budget reaches. Score order decides the queue and the audit log, but it
 * cannot also decide this: on a repository with more pending bumps than the budget, the same top
 * few kept the budget every run, spending it on refreshing issues that were already open, and the
 * ones below them were "carried to the next run" for ever without a reader ever hearing of them.
 *
 * A bump nobody has been told about takes the budget first, and within each group the riskiest
 * comes first. So a run still leads with the worst thing it can act on, and the queue advances.
 */
export function budgetedBumps(
  scored: readonly QueuedBump[],
  previous: ReadonlyArray<BumpRecord | null>,
  budget: number,
): Set<number> {
  const unreported: number[] = [];
  const reported: number[] = [];

  scored.forEach((_unused, index) => {
    (alreadyReported(previous[index]) ? reported : unreported).push(index);
  });

  return new Set([...unreported, ...reported].slice(0, budget));
}

async function runRepository(
  deps: RunDependencies,
  options: RunOptions,
  repository: WatchedRepository,
  runId: string,
  at: Date,
  deadline: number,
  allowance: RunAllowance,
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
  const scored: QueuedBump[] = ingest.bumps
    .map((candidate) => ({
      bump: summaryOf(repository, candidate),
      candidate,
      score: scoreBump(candidate, at),
    }))
    .sort((left, right) => right.score.total - left.score.total);

  // What this repository may spend is what the repositories before it left, not a fresh copy of
  // the published number.
  const briefBudget = take(allowance, 'briefs', scored.length);
  let actions = 0;

  // The briefs go out several at a time, riskiest first, because each depends on nothing but its
  // own material. The actions below still land one at a time in score order: GitHub's secondary
  // limits measure the rate of writes, and the audit log reads riskiest first.
  const briefs = await mapInFlight(scored, BRIEFS_IN_FLIGHT, (queued, index) =>
    briefFor(
      deps,
      briefRequestFor(queued.bump, queued.candidate, queued.score),
      briefRefusal(index, briefBudget, deps.now().getTime() >= deadline),
      at,
    ),
  );

  // Read before the budget is shared out, because what a bump got last time decides whether it
  // needs the budget this time. These are the same reads the loop below used to make one at a
  // time, moved earlier rather than added.
  const previous: Array<BumpRecord | null> = [];
  for (const queued of scored) {
    previous.push(await deps.store.getBump(repository.id, queued.bump.key));
  }

  const acting = budgetedBumps(scored, previous, take(allowance, 'actions', scored.length));

  for (const [index, queued] of scored.entries()) {
    const processed = await processBump(
      repository,
      context,
      queued,
      briefs[index] as BriefRecord,
      acting.has(index),
      previous[index] ?? null,
    );
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
 * Claims one lease and hands back the release, or null when something else holds it. Releasing
 * never rejects: a rejection would replace whatever the run returned or threw, turning a finished
 * run into a store error the caller answers 500 to, and a lease left behind expires on its own.
 */
async function takeLease(
  deps: RunDependencies,
  key: string,
  runId: string,
  at: Date,
): Promise<(() => Promise<void>) | null> {
  const holder = randomUUID();
  const claimed = await deps.store.claimRun({
    key,
    holder,
    runId,
    claimedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + CLAIM_LEASE_MS).toISOString(),
  });
  if (!claimed) return null;

  return async () => {
    await deps.store.releaseRun(key, holder).catch((error: unknown) => {
      (deps.logger ?? silentLogger).error('lease not released', { runId, key, error });
    });
  };
}

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
  //
  // A scoped run takes the shared scoped slot and its own repository. A whole-watch-list run takes
  // the watch-list lease and then each repository as it reaches it, so a press authorised for one
  // project can no longer shut out a scheduled run over every other one.
  const scope = options.repositoryId ?? null;
  const releases: Array<() => Promise<void>> = [];
  const keys = scope ? [SCOPED_RUN_CLAIM_KEY, repositoryClaimKey(scope)] : [RUN_CLAIM_KEY];

  try {
    for (const key of keys) {
      const release = await takeLease(deps, key, id, startedAt);
      if (!release) throw new RunInProgressError();
      releases.push(release);
    }
    return await runClaimed(deps, options, id, startedAt);
  } finally {
    for (const release of releases.reverse()) await release();
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
  // One allowance for the whole run, handed down and drawn from, so the published numbers mean
  // what they say however many repositories the watch list holds.
  const allowance = allowanceFor(options);
  const results: RepositoryResult[] = [];
  for (const repository of repositories) {
    // A scoped run already holds its one repository from executeRun. A watch-list run takes each
    // repository as it reaches it, and steps over one another run is holding rather than refusing
    // the whole run: the other repositories on the list still deserve their scan.
    let release: (() => Promise<void>) | null = null;
    if (!options.repositoryId) {
      release = await takeLease(deps, repositoryClaimKey(repository.id), id, deps.now());
      if (!release) {
        logger.info('repository held', { runId: id, repository: repository.id });
        results.push({
          repositoryId: repository.id,
          dependenciesConsidered: 0,
          counts: { ...ZERO_COUNTS },
          actions: 0,
          missing: [],
          error: 'another run holds this repository, so this run left it alone',
          skipped: true,
        });
        continue;
      }
    }

    try {
      results.push(
        await runRepository(deps, options, repository, id, deps.now(), deadline, allowance),
      );
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
    } finally {
      if (release) await release();
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
