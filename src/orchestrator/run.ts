import { writeBrief, type BriefEngine } from '../agent/write-brief.js';
import type { BriefRequest } from '../agent/prompt.js';
import { briefCacheKey, unavailableBrief, type BriefRecord } from '../core/brief.js';
import { bumpKey } from '../core/bump-key.js';
import type { BumpSummary } from '../core/issue-body.js';
import { LABEL_ROOT, POLICY_VERSION, ruleFor } from '../core/policy.js';
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
import type { BumpwardenStore } from '../io/store.js';
import { actOnBump, type ActContext } from './act.js';
import { ingestRepository } from './ingest.js';
import { collectSourceFiles } from './source-files.js';

/**
 * Two budgets, both per run. Briefs cost Gemini tokens, and a first run over a neglected repository
 * would otherwise open dozens of issues at once, which is how a helpful bot becomes one a
 * maintainer blocks. Bumps are handled in descending score order, so whatever the budgets cut is
 * always the least risky end of the queue, and every cut is recorded.
 */
const DEFAULT_BRIEF_BUDGET = 20;
const DEFAULT_ACTION_BUDGET = 10;

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

export interface RunDependencies {
  store: BumpwardenStore;
  now: () => Date;
  createFetcher: () => RunFetcher;
  createActor: (repository: WatchedRepository) => RepositoryActor | null;
  engine: BriefEngine | null;
  githubToken: string | null;
  dashboardBaseUrl: string | null;
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
  withinBudget: boolean,
  at: Date,
): Promise<BriefRecord> {
  if (!deps.engine) return noBrief(request, at, 'none', 'no Gemini API key is configured');
  if (!withinBudget) {
    return noBrief(request, at, deps.engine.model, 'over the per-run brief budget');
  }

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
    repositoryId: bump.repositoryId,
    runId,
    ruleId: rule.id,
    kind: rule.kind,
    outcome: 'skipped',
    url: null,
    number: null,
    at: at.toISOString(),
    detail: 'over the per-run action budget, carried to the next run',
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
  budgets: { brief: boolean; action: boolean },
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

async function runRepository(
  deps: RunDependencies,
  options: RunOptions,
  repository: WatchedRepository,
  runId: string,
  at: Date,
): Promise<RepositoryResult> {
  const fetcher = deps.createFetcher();
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

  const context = await loadActorContext(deps, repository, runId, at, missing);
  const scored = ingest.bumps
    .map((candidate) => ({ candidate, score: scoreBump(candidate, at) }))
    .sort((left, right) => right.score.total - left.score.total);

  const briefBudget = options.briefBudget ?? DEFAULT_BRIEF_BUDGET;
  const actionBudget = options.actionBudget ?? DEFAULT_ACTION_BUDGET;
  let actions = 0;

  for (const [index, entry] of scored.entries()) {
    const processed = await processBump(deps, repository, context, entry, {
      brief: index < briefBudget,
      action: index < actionBudget,
    });
    await deps.store.appendAction(processed.action);
    await deps.store.saveBump(processed.record);
    if (LANDED.has(processed.action.outcome)) actions += 1;
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
  });

  return result;
}

/**
 * The one run path. Cloud Scheduler's OIDC call and the dashboard's "Run now" both land here and
 * differ only in the recorded trigger, so what a judge sees after pressing the button is the same
 * artifact the nightly run produces.
 */
export async function executeRun(deps: RunDependencies, options: RunOptions): Promise<RunRecord> {
  const startedAt = deps.now();
  const id = runIdFor(startedAt, options.trigger);

  const watched = await deps.store.listWatchedRepositories();
  const repositories = options.repositoryId
    ? watched.filter((repository) => repository.id === options.repositoryId)
    : watched;

  const opened: RunRecord = {
    id,
    trigger: options.trigger,
    status: 'running',
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

  const results: RepositoryResult[] = [];
  for (const repository of repositories) {
    try {
      results.push(await runRepository(deps, options, repository, id, deps.now()));
    } catch (error) {
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
  return finished;
}
