import { describe, expect, it, vi } from 'vitest';
import { MANIFEST_JSON } from '../testkit/fixtures.js';
import { fakeGitHub } from '../testkit/fake-github.js';
import { ROUTES, RepositoryActor, VIEWER_ROUTE } from './github-actor.js';

const TARGET = { owner: 'demo', repo: 'app' };

function actorOver(github = fakeGitHub()) {
  return {
    github,
    actor: new RepositoryActor(github.request, TARGET, {
      minWriteIntervalMs: 0,
      sleep: async () => undefined,
    }),
  };
}

describe('the route table', () => {
  const routes = Object.values(ROUTES);

  it('has no way to merge anything', () => {
    expect(routes.filter((route) => /merge/i.test(route))).toEqual([]);
  });

  it('names owner and repo in every route, so no call can leave the target repository', () => {
    expect(routes.filter((route) => !route.includes('/repos/{owner}/{repo}'))).toEqual([]);
  });

  it('lists each route once', () => {
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('uses a read verb for every route that is not a write', () => {
    expect(routes.filter((route) => route.startsWith('DELETE'))).toEqual([]);
  });

  /**
   * The one route outside the table, so the property the tests above pin for every other route is
   * pinned for this one too: it reads, and it holds no parameter a caller could aim somewhere.
   */
  it('reads the token’s own identity through a route with nothing in it to aim', () => {
    expect(VIEWER_ROUTE.startsWith('GET ')).toBe(true);
    expect(VIEWER_ROUTE).not.toContain('{');
  });
});

describe('the login the token acts under', () => {
  it('reads it once, however often it is asked', async () => {
    const github = fakeGitHub({ viewer: 'bumpwarden-bot' });
    const { actor } = actorOver(github);

    expect(await actor.selfLogin()).toBe('bumpwarden-bot');
    expect(await actor.selfLogin()).toBe('bumpwarden-bot');
    expect(github.calls.filter((call) => call.route === VIEWER_ROUTE)).toHaveLength(1);
  });

  /**
   * A token that may not read its own identity can still open issues and comment, so a refusal is
   * an answer rather than a failure. The caller treats it as reason not to edit a comment it cannot
   * prove is its own.
   */
  it('answers null when GitHub will not say, instead of failing the run', async () => {
    const { actor } = actorOver(fakeGitHub({ failures: { [VIEWER_ROUTE]: 403 } }));
    expect(await actor.selfLogin()).toBeNull();
  });
});

describe('every call the actor makes', () => {
  it('carries the owner and repository it was constructed with', async () => {
    const github = fakeGitHub({
      issues: [{ number: 10, labels: ['bumpwarden'] }],
      comments: [{ id: 800, issueNumber: 10 }],
      files: { 'package.json': MANIFEST_JSON },
    });
    const { actor } = actorOver(github);

    await actor.facts();
    await actor.listBumpwardenIssues('bumpwarden');
    await actor.listOpenPullRequests();
    await actor.listComments(10);
    await actor.createIssue({ title: 't', body: 'b', labels: ['bumpwarden'] });
    await actor.updateIssue(10, { title: 't', body: 'b', labels: ['bumpwarden'] });
    await actor.addLabels(10, ['bumpwarden:red']);
    await actor.createComment(10, 'hello');
    await actor.updateComment(800, 'hello again');
    const sha = await actor.headSha('main');
    await actor.ensureBranch('bumpwarden/express-5.0.0', sha);
    const file = await actor.readFile('package.json', 'bumpwarden/express-5.0.0');
    await actor.writeFile({
      path: 'package.json',
      text: file.text,
      sha: file.sha,
      branch: 'bumpwarden/express-5.0.0',
      message: 'bump',
    });
    await actor.createPullRequest({ title: 't', body: 'b', head: 'x', base: 'main' });

    expect(github.calls.length).toBeGreaterThan(10);
    const foreign = github.calls.filter(
      (call) => call.params.owner !== 'demo' || call.params.repo !== 'app',
    );
    expect(foreign).toEqual([]);
  });
});

/**
 * These three lists answer one question: has this bump been reported already. A page boundary in
 * that answer is not a display limit, it is a wrong answer, and a marker sitting on page two opens
 * a second issue for a bump that already has one.
 */
describe('reading a list that decides idempotency', () => {
  const many = (count: number, make: (index: number) => Record<string, unknown>) =>
    Array.from({ length: count }, (_unused, index) => make(index));

  it('reads every page of the labelled issues, not just the first', async () => {
    const github = fakeGitHub({
      issues: many(250, (index) => ({
        number: 1000 + index,
        labels: ['bumpwarden'],
        body: `<!-- bumpwarden:key=demo/app#pkg-${index}@1.0.0 -->`,
      })),
    });
    const { actor } = actorOver(github);

    const found = await actor.listBumpwardenIssues('bumpwarden');

    expect(found).toHaveLength(250);
    // The marker that only exists on the third page is the one a single read would have missed.
    expect(found.some((issue) => issue.body.includes('pkg-249@1.0.0'))).toBe(true);
    expect(github.calls.filter((call) => call.route === ROUTES.issues)).toHaveLength(3);
  });

  it('reads every page of the open pull requests', async () => {
    const github = fakeGitHub({
      issues: many(150, (index) => ({ number: 2000 + index, isPullRequest: true })),
    });
    expect(await actorOver(github).actor.listOpenPullRequests()).toHaveLength(150);
  });

  it('reads every page of one issue’s comments', async () => {
    const github = fakeGitHub({
      comments: many(120, (index) => ({ id: 5000 + index, issueNumber: 41 })),
    });
    expect(await actorOver(github).actor.listComments(41)).toHaveLength(120);
  });

  /**
   * A short page is what ends the read, so a source that never returns one has to end it some
   * other way. Going quiet with a partial list would be the one outcome worse than failing.
   */
  it('fails loudly rather than returning a partial list', async () => {
    const endless = { status: 200, data: many(100, (index) => ({ number: index })) };
    const actor = new RepositoryActor(async () => endless, TARGET, { minWriteIntervalMs: 0 });

    await expect(actor.listBumpwardenIssues('bumpwarden')).rejects.toThrow(/did not finish inside/);
  });
});

describe('repository facts', () => {
  it('reports write access when the token can push', async () => {
    const { actor } = actorOver(fakeGitHub({ canPush: true, defaultBranch: 'trunk' }));
    expect(await actor.facts()).toEqual({ defaultBranch: 'trunk', canWrite: true });
  });

  it('reports no write access for a read-only token', async () => {
    const { actor } = actorOver(fakeGitHub({ canPush: false }));
    expect((await actor.facts()).canWrite).toBe(false);
  });

  it('throws a readable error when GitHub refuses the read', async () => {
    const { actor } = actorOver(fakeGitHub({ failures: { [ROUTES.repository]: 404 } }));
    await expect(actor.facts()).rejects.toThrow('reading the repository failed with 404');
  });
});

describe('labels', () => {
  it('creates a label once per actor, however many issues use it', async () => {
    const { actor, github } = actorOver();
    await actor.createIssue({ title: 'a', body: 'a', labels: ['bumpwarden'] });
    await actor.createIssue({ title: 'b', body: 'b', labels: ['bumpwarden'] });

    const created = github.calls.filter((call) => call.route === ROUTES.createLabel);
    expect(created).toHaveLength(1);
  });

  it('treats a label that already exists as ordinary, not as a failure', async () => {
    const { actor } = actorOver();
    await actor.ensureLabels(['bumpwarden']);
    await expect(actor.ensureLabels(['bumpwarden'])).resolves.toBeUndefined();
  });
});

describe('branches and files', () => {
  it('reports that a branch was already there instead of failing the run', async () => {
    const { actor } = actorOver(fakeGitHub({ files: { 'package.json': MANIFEST_JSON } }));
    const sha = await actor.headSha('main');

    expect(await actor.ensureBranch('bumpwarden/express-5.0.0', sha)).toBe(true);
    expect(await actor.ensureBranch('bumpwarden/express-5.0.0', sha)).toBe(false);
  });

  it('reads a file as text and writes it back as text', async () => {
    const github = fakeGitHub({ files: { 'package.json': MANIFEST_JSON } });
    const { actor } = actorOver(github);

    const file = await actor.readFile('package.json', 'main');
    expect(file.text).toBe(MANIFEST_JSON);

    await actor.writeFile({
      path: 'package.json',
      text: '{"name":"changed"}',
      sha: file.sha,
      branch: 'main',
      message: 'bump',
    });
    expect(github.fileOn('main', 'package.json')).toBe('{"name":"changed"}');
  });

  it('refuses a file that is not base64, rather than writing something corrupt back', async () => {
    const { actor } = actorOver(fakeGitHub({ failures: { [ROUTES.readFile]: 200 } }));
    await expect(actor.readFile('package.json', 'main')).rejects.toThrow('not base64');
  });
});

describe('write pacing', () => {
  it('waits between writes, because GitHub answers a burst with a secondary rate limit', async () => {
    const sleep = vi.fn(async () => undefined);
    let clock = 0;
    const github = fakeGitHub();
    const actor = new RepositoryActor(github.request, TARGET, {
      minWriteIntervalMs: 1000,
      sleep,
      now: () => clock,
    });

    await actor.ensureLabels(['one']);
    clock = 200;
    await actor.ensureLabels(['two']);

    expect(sleep).toHaveBeenCalledWith(800);
  });

  it('does not wait before the first write of a run', async () => {
    const sleep = vi.fn(async () => undefined);
    const github = fakeGitHub();
    const actor = new RepositoryActor(github.request, TARGET, {
      minWriteIntervalMs: 1000,
      sleep,
      now: () => 5000,
    });

    await actor.ensureLabels(['one']);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not pace reads, which have their own generous limit', async () => {
    const sleep = vi.fn(async () => undefined);
    const github = fakeGitHub();
    const actor = new RepositoryActor(github.request, TARGET, {
      minWriteIntervalMs: 1000,
      sleep,
      now: () => 0,
    });

    await actor.listOpenPullRequests();
    await actor.listOpenPullRequests();
    expect(sleep).not.toHaveBeenCalled();
  });
});
