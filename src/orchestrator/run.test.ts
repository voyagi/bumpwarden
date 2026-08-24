import { describe, expect, it, vi } from 'vitest';
import type { BriefEngine } from '../agent/write-brief.js';
import { PER_RUN_BUDGETS, RUN_TIME_BUDGET_SECONDS } from '../core/policy.js';
import type { RunRecord } from '../core/records.js';
import { BRIEFS_IN_FLIGHT } from '../core/stack.js';
import { RunFetcher } from '../io/http.js';
import { createLogger } from '../io/log.js';
import { MemoryStore } from '../io/memory-store.js';
import { RUN_CLAIM_KEY, type BumpwardenStore } from '../io/store.js';
import { deferred } from '../testkit/deferred.js';
import { fakeGitHub, type FakeGitHub } from '../testkit/fake-github.js';
import { DEMO, MANIFEST_JSON, NOW } from '../testkit/fixtures.js';
import { json, routedFetch, urlContains, type Route } from '../testkit/scripted-fetch.js';
import { ROUTES, RepositoryActor } from '../io/github-actor.js';
import {
  RunInProgressError,
  budgetedBumps,
  executeRun,
  resolveBudgets,
  type RunDependencies,
} from './run.js';

const MANIFEST = {
  name: 'demo-app',
  engines: { node: '>=18' },
  dependencies: { express: '^4.18.2' },
};

const LOCK = {
  lockfileVersion: 3,
  packages: { '': { name: 'demo-app' }, 'node_modules/express': { version: '4.18.2' } },
};

const NOTES = [
  '## Breaking changes',
  'The `res.sendfile()` function has been replaced by a camel-cased version `res.sendFile()`.',
].join('\n');

const ROUTE_FILE = [
  "import express from 'express';",
  '',
  'router.get("/:name", (req, res) => {',
  '  res.sendfile(p);',
  '});',
].join('\n');

const VALID_BRIEF = JSON.stringify({
  headline: 'A removed method is called in your routes',
  whatChanged: 'Express 5 drops methods Express 4 accepted.',
  breakingChanges: ['res.sendfile is gone'],
  breaksHere: [
    {
      path: 'src/routes/files.ts',
      line: 4,
      symbol: 'res.sendfile',
      quote: 'The `res.sendfile()` function has been replaced by a camel-cased version',
      source: 'https://github.com/expressjs/express/releases',
    },
  ],
  migrationSteps: ['Rename the call to res.sendFile.'],
  confidence: 'high',
});

function base64(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
}

function contents(value: unknown) {
  return json({ content: base64(value), encoding: 'base64' });
}

function routes(): Route[] {
  return [
    {
      match: urlContains('/git/trees/'),
      step: json({
        truncated: false,
        tree: [
          { path: 'src/routes/files.ts', type: 'blob', size: 200 },
          { path: 'README.md', type: 'blob', size: 100 },
        ],
      }),
    },
    { match: urlContains('/contents/src/routes/files.ts'), step: contents(ROUTE_FILE) },
    { match: urlContains('/contents/package.json'), step: contents(MANIFEST) },
    { match: urlContains('/contents/package-lock.json'), step: contents(LOCK) },
    {
      match: urlContains('registry.npmjs.org/express/latest'),
      step: json({
        version: '5.2.1',
        engines: { node: '>= 18' },
        repository: { url: 'git+https://github.com/expressjs/express.git' },
      }),
    },
    { match: urlContains('registry.npmjs.org/express/4.18.2'), step: json({ version: '4.18.2' }) },
    {
      match: urlContains('/packages/express/versions/'),
      step: json({ publishedAt: '2025-12-01T00:00:00Z', isDeprecated: false, advisoryKeys: [] }),
    },
    {
      match: urlContains('/releases/tags/v5.2.1'),
      step: json({ body: NOTES, html_url: 'https://github.com/expressjs/express/releases' }),
    },
    {
      match: urlContains('/compare/'),
      step: json({
        total_commits: 1,
        commits: [{ commit: { message: 'feat!: remove res.sendfile' } }],
        files: [{ filename: 'lib/response.js' }],
      }),
    },
  ];
}

interface Harness {
  deps: RunDependencies;
  store: BumpwardenStore;
  github: FakeGitHub;
  engine: BriefEngine & { seen: number };
  saved: RunRecord[];
  advance(ms: number): void;
}

function scriptedEngine(answers: string[]): BriefEngine & { seen: number } {
  return {
    model: 'gemini-3.5-flash',
    seen: 0,
    async generate() {
      const answer = answers[Math.min(this.seen, answers.length - 1)] ?? '';
      this.seen += 1;
      return answer;
    },
  };
}

async function harness(overrides: Partial<RunDependencies> = {}): Promise<Harness> {
  const store = new MemoryStore();
  await store.putWatchedRepository(DEMO);

  const github = fakeGitHub({ files: { 'package.json': MANIFEST_JSON } });
  const engine = scriptedEngine([VALID_BRIEF]);
  const saved: RunRecord[] = [];
  let clock = NOW.getTime();

  const recording: BumpwardenStore = {
    ...store,
    saveRun: async (run) => {
      saved.push(structuredClone(run));
      await store.saveRun(run);
    },
    listWatchedRepositories: () => store.listWatchedRepositories(),
    putWatchedRepository: (repository) => store.putWatchedRepository(repository),
    claimRun: (claim) => store.claimRun(claim),
    releaseRun: (key, runId) => store.releaseRun(key, runId),
    getRun: (id) => store.getRun(id),
    listRuns: (limit) => store.listRuns(limit),
    saveBump: (bump) => store.saveBump(bump),
    getBump: (repositoryId, key) => store.getBump(repositoryId, key),
    listBumps: (query) => store.listBumps(query),
    appendAction: (action) => store.appendAction(action),
    listActions: (query) => store.listActions(query),
    getBrief: (key) => store.getBrief(key),
    putBrief: (record) => store.putBrief(record),
    putProjectSummary: (summary) => store.putProjectSummary(summary),
    listProjectSummaries: () => store.listProjectSummaries(),
  };

  const deps: RunDependencies = {
    store: recording,
    now: () => new Date(clock),
    createFetcher: () =>
      new RunFetcher({ fetchImpl: routedFetch(routes()).impl, sleep: async () => undefined }),
    createActor: (repository) =>
      new RepositoryActor(
        github.request,
        { owner: repository.owner, repo: repository.repo },
        { minWriteIntervalMs: 0, sleep: async () => undefined },
      ),
    engine,
    githubToken: 'token',
    dashboardBaseUrl: null,
    ...overrides,
  };

  return {
    deps,
    store: recording,
    github,
    engine,
    saved,
    advance: (ms) => {
      clock += ms;
    },
  };
}

describe('one run over one repository', () => {
  it('records the run before the work starts, so a poll sees it running', async () => {
    const context = await harness();
    await executeRun(context.deps, { trigger: 'scheduled' });

    expect(context.saved[0]).toMatchObject({ status: 'running', finishedAt: null });
    expect(context.saved.at(-1)).toMatchObject({ status: 'finished' });
    expect(context.saved.at(-1)?.finishedAt).not.toBeNull();
  });

  /**
   * The dashboard's run button is public and unauthenticated, so this is not a theoretical race:
   * five POSTs in the same tick all read "nothing is running" and, before the lease, all five ran.
   * Each run spends the Gemini budget, the GitHub write budget and the Firestore quota again, and
   * two of them opening an issue for the same bump defeats the idempotency marker as well.
   */
  it('lets one of five simultaneous runs through and refuses the rest', async () => {
    const context = await harness();
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => executeRun(context.deps, { trigger: 'manual' })),
    );

    const started = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const refused = attempts.filter(
      (attempt) => attempt.status === 'rejected' && attempt.reason instanceof RunInProgressError,
    );

    expect(started).toHaveLength(1);
    expect(refused).toHaveLength(4);
    expect(await context.store.listRuns(10)).toHaveLength(1);
  });

  it('hands the lease back when a run fails, so the next press is not locked out', async () => {
    const context = await harness();
    context.deps.store.listWatchedRepositories = async () => {
      throw new Error('the store is unreachable');
    };

    await expect(executeRun(context.deps, { trigger: 'manual' })).rejects.toThrow('unreachable');

    const claimed = await context.store.claimRun({
      key: RUN_CLAIM_KEY,
      holder: 'someone-else',
      runId: 'run-someone-else',
      claimedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });
    expect(claimed).toBe(true);
  });

  /**
   * A rejection inside the release would replace whatever the run returned, so a finished run
   * would reach the endpoint as a store error and be answered 500. The lease expires by itself.
   */
  it('still returns the run when handing the lease back fails', async () => {
    const context = await harness();
    context.deps.store.releaseRun = async () => {
      throw new Error('firestore is unreachable');
    };

    const run = await executeRun(context.deps, { trigger: 'manual' });
    expect(run.status).toBe('finished');
  });

  it('scores the bump, writes the brief and opens the action', async () => {
    const context = await harness();
    const run = await executeRun(context.deps, { trigger: 'scheduled' });

    expect(run.counts).toEqual({ green: 0, amber: 0, red: 1 });
    expect(run.actionsTaken).toBe(1);

    const [bump] = await context.store.listBumps({ repositoryId: DEMO.id, limit: 10 });
    expect(bump?.dependency).toBe('express');
    expect(bump?.brief.status).toBe('ready');
    expect(bump?.brief.content?.breaksHere[0]?.verified).toBe(true);
    expect(bump?.action?.outcome).toBe('opened');
  });

  it('stops asking for briefs once the run is out of time, and still scores and acts', async () => {
    const context = await harness();
    // Two calls open the run and the repository; every call after them lands past the budget, which
    // is the shape of a run whose first briefs were slow.
    let calls = 0;
    context.deps.now = () => {
      calls += 1;
      const overtime = calls > 2 ? RUN_TIME_BUDGET_SECONDS * 1000 + 1_000 : 0;
      return new Date(NOW.getTime() + overtime);
    };

    await executeRun(context.deps, { trigger: 'scheduled' });

    const [bump] = await context.store.listBumps({ repositoryId: DEMO.id, limit: 10 });
    expect(bump?.brief.status).toBe('unavailable');
    expect(bump?.brief.reason).toContain('time budget');
    expect(bump?.score.band).toBe('red');
    expect(bump?.action?.outcome).toBe('opened');
    expect(context.engine.seen).toBe(0);
  });

  it('narrates the run as structured lines that carry no credential', async () => {
    const lines: string[] = [];
    const context = await harness({
      logger: createLogger({ write: (line) => lines.push(line) }),
      githubToken: `ghp_${'B7c2D9e1F3'.repeat(4)}`,
    });
    await executeRun(context.deps, { trigger: 'scheduled' });

    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.message)).toEqual([
      'run started',
      'repository read',
      'bump handled',
      'run finished',
    ]);
    expect(entries[1]).toMatchObject({
      repository: DEMO.id,
      dependencies: 1,
      bumps: 1,
      calls: expect.any(Number),
      bytes: expect.any(Number),
      seconds: expect.any(Number),
    });
    expect(entries[2]).toMatchObject({ band: 'red', rule: 'RED-HOLD-1', outcome: 'opened' });
    expect(entries[3]).toMatchObject({ counts: { green: 0, amber: 0, red: 1 }, actionsTaken: 1 });
    expect(lines.join('\n')).not.toContain('ghp_');
  });

  it('writes the audit entry with the rule that fired and the issue URL', async () => {
    const context = await harness();
    await executeRun(context.deps, { trigger: 'scheduled' });

    const [action] = await context.store.listActions({ limit: 10 });
    expect(action?.ruleId).toBe('RED-HOLD-1');
    expect(action?.url).toContain('/issues/');
  });

  it('updates the project summary with the counts the dashboard reads', async () => {
    const context = await harness();
    const run = await executeRun(context.deps, { trigger: 'scheduled' });

    const [summary] = await context.store.listProjectSummaries();
    expect(summary).toMatchObject({
      lastRunId: run.id,
      lastRunStatus: 'finished',
      counts: { green: 0, amber: 0, red: 1 },
      actions: 1,
    });
  });

  it('records the sources it could not read instead of pretending they were clean', async () => {
    const context = await harness({
      createFetcher: () =>
        new RunFetcher({
          fetchImpl: routedFetch(routes().filter((route) => !route.match('/compare/'))).impl,
          sleep: async () => undefined,
        }),
    });

    const run = await executeRun(context.deps, { trigger: 'scheduled' });
    const missing = run.repositories[0]?.missing.map((entry) => entry.what) ?? [];
    expect(missing.some((what) => what.includes('tag compare'))).toBe(true);
  });
});

describe('the trigger', () => {
  it('produces the same artifact whether the scheduler or a person started it', async () => {
    const scheduled = await harness();
    const manual = await harness();

    const first = await executeRun(scheduled.deps, { trigger: 'scheduled' });
    const second = await executeRun(manual.deps, { trigger: 'manual' });

    expect(second.trigger).toBe('manual');
    expect(first.trigger).toBe('scheduled');
    expect({ ...second, id: first.id, trigger: first.trigger }).toEqual(first);
  });

  it('scopes a run to one project when asked', async () => {
    const context = await harness();
    await context.store.putWatchedRepository({ ...DEMO, id: 'demo/other', repo: 'other' });

    const run = await executeRun(context.deps, { trigger: 'manual', repositoryId: DEMO.id });
    expect(run.repositories.map((result) => result.repositoryId)).toEqual([DEMO.id]);
  });
});

describe('a second run', () => {
  it('updates the issue the first run opened instead of opening a duplicate', async () => {
    const context = await harness();
    await executeRun(context.deps, { trigger: 'scheduled' });
    context.advance(86_400_000);
    await executeRun(context.deps, { trigger: 'scheduled' });

    expect(
      context.github.issues.filter((issue) => issue.labels.includes('bumpwarden')),
    ).toHaveLength(1);

    const actions = await context.store.listActions({ limit: 10 });
    expect(actions[0]?.outcome).toBe('updated');
    expect(actions).toHaveLength(2);
  });

  it('reuses the cached brief rather than spending tokens again', async () => {
    const context = await harness();
    await executeRun(context.deps, { trigger: 'scheduled' });
    context.advance(86_400_000);
    await executeRun(context.deps, { trigger: 'scheduled' });

    expect(context.engine.seen).toBe(1);
  });

  it('keeps the date the bump was first seen', async () => {
    const context = await harness();
    await executeRun(context.deps, { trigger: 'scheduled' });
    context.advance(86_400_000);
    await executeRun(context.deps, { trigger: 'scheduled' });

    const [bump] = await context.store.listBumps({ repositoryId: DEMO.id, limit: 10 });
    expect(bump?.firstSeenAt).toBe(NOW.toISOString());
    expect(bump?.updatedAt).not.toBe(NOW.toISOString());
  });
});

/**
 * On a repository with more pending bumps than the action budget, score order alone decided who
 * got it, so the same top few had their open issues refreshed every run and the ones below them
 * were "carried to the next run" for ever. Nobody was ever told about them.
 */
describe('which bumps the action budget reaches', () => {
  const queued = (total: number, score: number) =>
    Array.from({ length: total }, (_unused, index) => ({
      score: { total: score - index },
    })) as never;

  const reportedAt = (total: number, indices: number[]) =>
    Array.from({ length: total }, (_unused, index) =>
      indices.includes(index) ? ({ action: { outcome: 'opened' } } as never) : null,
    );

  it('gives it to nobody when there is none left', () => {
    expect(budgetedBumps(queued(3, 90), reportedAt(3, []), 0)).toEqual(new Set());
  });

  it('gives it to everyone when there is enough for all of them', () => {
    expect(budgetedBumps(queued(3, 90), reportedAt(3, [0]), 5)).toEqual(new Set([0, 1, 2]));
  });

  it('reaches a bump nobody has been told about before one that already has an issue', () => {
    // Index 0 is the riskiest and already reported. Index 2 has never been acted on, and with one
    // action left it is the one that gets it: the reader already has the first one.
    expect(budgetedBumps(queued(3, 90), reportedAt(3, [0, 1]), 1)).toEqual(new Set([2]));
  });

  it('keeps riskiest first inside each group', () => {
    // 0 and 1 reported, 2 and 3 not. Two actions left go to the unreported pair in score order.
    expect(budgetedBumps(queued(4, 90), reportedAt(4, [0, 1]), 2)).toEqual(new Set([2, 3]));
    // Four left reaches the reported pair too, and reaches the worse of them first.
    expect(budgetedBumps(queued(4, 90), reportedAt(4, [0, 1]), 3)).toEqual(new Set([2, 3, 0]));
  });
});

describe('budgets and failures', () => {
  it('spends exactly what the Policy page publishes when a caller names no budget', () => {
    // The page tells a reader a run takes at most this many actions. A default that drifted from
    // it would make the published policy a claim about nothing.
    expect(resolveBudgets({ trigger: 'scheduled' })).toEqual({
      brief: PER_RUN_BUDGETS.briefs,
      action: PER_RUN_BUDGETS.actions,
    });
  });

  it('lets a caller ask for less, including none at all', () => {
    expect(resolveBudgets({ trigger: 'manual', briefBudget: 0, actionBudget: 3 })).toEqual({
      brief: 0,
      action: 3,
    });
  });

  /**
   * The published numbers say "in a run", and a scheduled run covers the whole watch list. Each
   * repository used to resolve the budget for itself, so the promise held for one project and was
   * multiplied by the length of the list for any more than that.
   */
  it('shares one brief budget across the whole watch list', async () => {
    const context = await harness();
    await context.store.putWatchedRepository({ ...DEMO, id: 'demo/second', repo: 'second' });

    await executeRun(context.deps, { trigger: 'scheduled', briefBudget: 1 });

    expect(context.engine.seen).toBe(1);
  });

  it('shares one action budget across the whole watch list', async () => {
    const context = await harness();
    await context.store.putWatchedRepository({ ...DEMO, id: 'demo/second', repo: 'second' });

    await executeRun(context.deps, { trigger: 'scheduled', actionBudget: 1 });

    const actions = await context.store.listActions({ limit: 50 });
    expect(actions).toHaveLength(2);
    expect(actions.filter((action) => action.outcome === 'skipped')).toHaveLength(1);
    expect(actions.filter((action) => action.outcome === 'opened')).toHaveLength(1);
  });

  /**
   * `facts()` answering first meant a listing that threw afterwards left the run believing it could
   * write, with an empty list of what already exists. An empty list matches no bump marker, so the
   * run would have opened a second issue for every bump that already had one, on a transient read
   * failure. The repository is a dry run instead.
   */
  it('makes a repository a dry run when its issues cannot be listed', async () => {
    const upstream = fakeGitHub({ files: { 'package.json': MANIFEST_JSON } });
    const context = await harness({
      createActor: (repository) =>
        new RepositoryActor(
          async (route, params) => {
            if (route === ROUTES.issues) throw new Error('secondary rate limit hit');
            return upstream.request(route, params);
          },
          { owner: repository.owner, repo: repository.repo },
          { minWriteIntervalMs: 0, sleep: async () => undefined },
        ),
    });

    await executeRun(context.deps, { trigger: 'scheduled' });

    const [bump] = await context.store.listBumps({ repositoryId: DEMO.id, limit: 10 });
    expect(bump?.action?.outcome).toBe('dry-run');
    expect(upstream.issues.filter((issue) => !issue.isPullRequest)).toEqual([]);

    // The reason names the read that failed, not the token, because the token may be fine.
    const [result] = context.saved.at(-1)?.repositories ?? [];
    expect(result?.missing.map((source) => source.why)).toContain('secondary rate limit hit');
    expect(result?.missing.map((source) => source.why)).not.toContain(
      'the token cannot push to this repository, so actions are dry runs',
    );
  });

  it('records a brief as unavailable when no Gemini key is configured', async () => {
    const context = await harness({ engine: null });
    await executeRun(context.deps, { trigger: 'scheduled' });

    const [bump] = await context.store.listBumps({ repositoryId: DEMO.id, limit: 10 });
    expect(bump?.brief.status).toBe('unavailable');
    expect(bump?.brief.reason).toContain('no Gemini API key');
    expect(bump?.action?.outcome).toBe('opened');
  });

  it('names the brief budget when it stops briefing, rather than going quiet', async () => {
    const context = await harness();
    await executeRun(context.deps, { trigger: 'scheduled', briefBudget: 0 });

    const [bump] = await context.store.listBumps({ repositoryId: DEMO.id, limit: 10 });
    expect(bump?.brief.reason).toContain('brief budget');
    expect(context.engine.seen).toBe(0);
  });

  it('skips an action over the action budget and says it will carry over', async () => {
    const context = await harness();
    const run = await executeRun(context.deps, { trigger: 'scheduled', actionBudget: 0 });

    const [action] = await context.store.listActions({ limit: 10 });
    expect(action?.outcome).toBe('skipped');
    expect(action?.detail).toContain('carried to the next run');
    expect(run.actionsTaken).toBe(0);
    expect(context.github.issues).toHaveLength(0);
  });

  it('records a repository that could not be processed and keeps the run alive', async () => {
    const context = await harness({
      createFetcher: () => {
        throw new Error('the network is gone');
      },
    });

    const run = await executeRun(context.deps, { trigger: 'scheduled' });
    expect(run.status).toBe('finished');
    expect(run.repositories[0]?.error).toBe('the network is gone');
  });

  it('records dry runs when the token cannot push', async () => {
    const github = fakeGitHub({ canPush: false, files: { 'package.json': MANIFEST_JSON } });
    const context = await harness({
      createActor: (repository) =>
        new RepositoryActor(
          github.request,
          { owner: repository.owner, repo: repository.repo },
          { minWriteIntervalMs: 0, sleep: async () => undefined },
        ),
    });

    const run = await executeRun(context.deps, { trigger: 'scheduled' });
    const [action] = await context.store.listActions({ limit: 10 });

    expect(action?.outcome).toBe('dry-run');
    expect(run.actionsTaken).toBe(0);
    expect(github.issues).toHaveLength(0);
  });

  it('runs with no watched repositories at all without failing', async () => {
    const context = await harness();
    const empty = { ...context.deps, store: new MemoryStore() };

    const run = await executeRun(empty, { trigger: 'scheduled' });
    expect(run.repositories).toEqual([]);
    expect(run.counts).toEqual({ green: 0, amber: 0, red: 0 });
  });
});

/**
 * Five dependencies at five distances, so the queue has a riskiest bump and an order. The engine
 * counts how many briefs are open at one moment and slows the riskiest one so it finishes last.
 */
function crowdedRoutes(): Route[] {
  const latest: Record<string, string> = {
    alpha: '2.0.0',
    bravo: '1.4.0',
    charlie: '1.0.3',
    delta: '1.2.0',
    echo: '1.1.0',
  };
  const names = Object.keys(latest);
  return [
    { match: urlContains('/git/trees/'), step: json({ truncated: false, tree: [] }) },
    {
      match: urlContains('/contents/package.json'),
      step: contents({ dependencies: Object.fromEntries(names.map((name) => [name, '^1.0.0'])) }),
    },
    {
      match: urlContains('/contents/package-lock.json'),
      step: contents({
        lockfileVersion: 3,
        packages: Object.fromEntries(
          names.map((name) => [`node_modules/${name}`, { version: '1.0.0' }]),
        ),
      }),
    },
    ...names.flatMap((name): Route[] => [
      {
        match: urlContains(`registry.npmjs.org/${name}/latest`),
        step: json({
          version: latest[name],
          repository: { url: `git+https://github.com/demo/${name}.git` },
        }),
      },
      { match: urlContains(`registry.npmjs.org/${name}/1.0.0`), step: json({ version: '1.0.0' }) },
    ]),
    {
      match: urlContains('/versions/'),
      step: json({ publishedAt: '2025-12-01T00:00:00Z', isDeprecated: false, advisoryKeys: [] }),
    },
    {
      match: urlContains('/compare/'),
      step: json({ total_commits: 1, commits: [{ commit: { message: 'fix: a thing' } }] }),
    },
  ];
}

interface MeteredEngine extends BriefEngine {
  peak: () => number;
  finished: string[];
  /** Lets the one held brief answer. */
  release: () => void;
}

/** Every brief answers at once except the held one, which waits for the test to let it go. */
function meteredEngine(held: string): MeteredEngine {
  let open = 0;
  let peak = 0;
  const finished: string[] = [];
  const gate = deferred<void>();
  return {
    model: 'gemini-3.5-flash',
    peak: () => peak,
    finished,
    release: () => gate.resolve(),
    async generate(request) {
      open += 1;
      peak = Math.max(peak, open);
      if (request.dependency === held) await gate.promise;
      else await new Promise((resolve) => setImmediate(resolve));
      open -= 1;
      finished.push(request.dependency);
      return VALID_BRIEF;
    },
  };
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000; turn += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the run never reached the expected state');
}

describe('the briefs of a run', () => {
  /**
   * A brief depends on nothing but its own material, so asking for them one after another cost
   * the demo's seven bumps a minute and a half of a judge's wait. The riskiest brief is held open
   * until every other has answered, which only a run that asks for several at once can do, and
   * the actions must still land in score order whatever order the model answered in.
   */
  it('asks the model for several at once, riskiest first, and still acts in score order', async () => {
    const lines: string[] = [];
    const engine = meteredEngine('alpha');
    const context = await harness({
      engine,
      logger: createLogger({ write: (line) => lines.push(line) }),
      createFetcher: () =>
        new RunFetcher({
          fetchImpl: routedFetch(crowdedRoutes()).impl,
          sleep: async () => undefined,
        }),
    });

    const running = executeRun(context.deps, { trigger: 'scheduled' });
    await eventually(() => engine.finished.length === 4);
    engine.release();
    const run = await running;

    const handled = lines
      .map((line) => JSON.parse(line) as { message: string; bump?: string; score?: number })
      .filter((entry) => entry.message === 'bump handled');
    const scores = handled.map((entry) => entry.score ?? -1);

    expect(run.counts.green + run.counts.amber + run.counts.red).toBe(5);
    expect(engine.peak()).toBe(BRIEFS_IN_FLIGHT);
    expect(engine.finished.at(-1)).toBe('alpha');
    expect(handled[0]?.bump).toContain('alpha');
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });
});

describe('the fetcher', () => {
  it('gets one budget per repository rather than one for the whole run', async () => {
    const createFetcher = vi.fn(
      () => new RunFetcher({ fetchImpl: routedFetch(routes()).impl, sleep: async () => undefined }),
    );
    const context = await harness({ createFetcher });
    await context.store.putWatchedRepository({ ...DEMO, id: 'demo/other', repo: 'other' });

    await executeRun(context.deps, { trigger: 'scheduled' });
    expect(createFetcher).toHaveBeenCalledTimes(2);
  });
});
