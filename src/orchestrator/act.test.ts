import { describe, expect, it } from 'vitest';
import { keyFromBody, marker } from '../core/bump-key.js';
import { LABEL_ROOT } from '../core/policy.js';
import type { Score } from '../core/types.js';
import { ROUTES, RepositoryActor, VIEWER_ROUTE } from '../io/github-actor.js';
import { fakeGitHub, type FakeGitHub, type FakeGitHubOptions } from '../testkit/fake-github.js';
import {
  DEMO,
  MANIFEST_JSON,
  NOW,
  candidateBump,
  readyBrief,
  scoreOf,
  summaryOf,
} from '../testkit/fixtures.js';
import { actOnBump, findBotPullRequest, type ActContext, type ActInputs } from './act.js';

const RED = scoreOf();
const GREEN = scoreOf(
  candidateBump({
    candidateVersion: '4.18.3',
    usage: 'unused',
    usageSites: [],
    release: { notes: 'Routine maintenance.', notesSource: 'release', commitSubjects: [] },
  }),
);
const AMBER = scoreOf(
  candidateBump({
    candidateVersion: '5.0.0',
    usage: 'package-only',
    usageSites: [],
    release: {
      notes: 'The `res.sendfile()` helper was removed.',
      notesSource: 'release',
      commitSubjects: [],
    },
  }),
);

function github(options: FakeGitHubOptions = {}): FakeGitHub {
  return fakeGitHub({ files: { 'package.json': MANIFEST_JSON }, ...options });
}

async function contextFor(fake: FakeGitHub, overrides: Partial<ActContext> = {}) {
  const actor = new RepositoryActor(
    fake.request,
    { owner: DEMO.owner, repo: DEMO.repo },
    {
      minWriteIntervalMs: 0,
      sleep: async () => undefined,
    },
  );
  const facts = await actor.facts();

  const context: ActContext = {
    actor,
    canWrite: facts.canWrite,
    defaultBranch: facts.defaultBranch,
    existing: await actor.listBumpwardenIssues(LABEL_ROOT),
    openPullRequests: await actor.listOpenPullRequests(),
    runId: 'run-20260821T060000000Z-scheduled',
    at: NOW,
    dashboardBaseUrl: null,
    ...overrides,
  };
  return context;
}

function inputs(score: Score = RED): ActInputs {
  return { bump: summaryOf(), score, brief: readyBrief() };
}

function writeCalls(fake: FakeGitHub): string[] {
  const writes: string[] = [
    ROUTES.createIssue,
    ROUTES.updateIssue,
    ROUTES.createComment,
    ROUTES.updateComment,
    ROUTES.createPull,
    ROUTES.writeFile,
    ROUTES.createRef,
    ROUTES.createLabel,
    ROUTES.addLabels,
  ];
  return fake.calls.map((call) => call.route).filter((route) => writes.includes(route));
}

describe('acting on a red bump', () => {
  it('opens a hold issue carrying the labels, the marker and the rule', async () => {
    const fake = github();
    const action = await actOnBump(await contextFor(fake), inputs());

    expect(action.outcome).toBe('opened');
    expect(action.ruleId).toBe('RED-HOLD-1');
    expect(action.kind).toBe('hold-issue');
    expect(action.url).toContain('/issues/');
    expect(action.at).toBe(NOW.toISOString());

    const issue = fake.issues.at(-1);
    expect(issue?.labels).toEqual(['bumpwarden', 'bumpwarden:red', 'bumpwarden:hold']);
    expect(keyFromBody(issue?.body ?? '')).toBe(summaryOf().key);
    expect(issue?.isPullRequest).toBe(false);
  });

  it('never opens a pull request for a held bump', async () => {
    const fake = github();
    await actOnBump(await contextFor(fake), inputs());
    expect(writeCalls(fake)).not.toContain(ROUTES.createPull);
  });
});

describe('acting on an amber bump', () => {
  it('opens an issue with the review label and no pull request', async () => {
    const fake = github();
    const action = await actOnBump(await contextFor(fake), inputs(AMBER));

    expect(action.ruleId).toBe('AMB-ISSUE-1');
    expect(fake.issues.at(-1)?.labels).toContain('bumpwarden:review');
    expect(writeCalls(fake)).not.toContain(ROUTES.createPull);
  });
});

describe('acting on a green bump', () => {
  it('opens a pull request that edits the manifest on its own branch', async () => {
    const fake = github();
    const action = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(action.outcome).toBe('opened');
    expect(action.ruleId).toBe('GRN-PR-1');
    expect(fake.branches.has('bumpwarden/express-5.0.0')).toBe(true);
    expect(fake.fileOn('bumpwarden/express-5.0.0', 'package.json')).toContain(
      '"express": "^5.0.0"',
    );
    expect(fake.fileOn('main', 'package.json')).toBe(MANIFEST_JSON);
  });

  it('labels the pull request it opened', async () => {
    const fake = github();
    await actOnBump(await contextFor(fake), inputs(GREEN));
    expect(fake.issues.at(-1)?.labels).toContain('bumpwarden:green');
  });

  it('says in the body that the lockfile still needs a refresh', async () => {
    const fake = github();
    await actOnBump(await contextFor(fake), inputs(GREEN));
    expect(fake.issues.at(-1)?.body).toContain('npm install');
  });

  it('opens an issue instead when the manifest range is one it will not rewrite', async () => {
    const fake = github({ files: { 'package.json': '{ "dependencies": { "express": "*" } }' } });
    const action = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(action.kind).toBe('issue');
    expect(action.detail).toContain('not one bumpwarden edits');
    expect(fake.issues.at(-1)?.isPullRequest).toBe(false);
  });
});

describe('a second run over the same bump', () => {
  it('updates the issue the first run opened instead of opening another', async () => {
    const fake = github();
    const first = await actOnBump(await contextFor(fake), inputs());
    const second = await actOnBump(await contextFor(fake), inputs());

    expect(second.outcome).toBe('updated');
    expect(second.number).toBe(first.number);
    expect(fake.issues.filter((issue) => issue.labels.includes('bumpwarden'))).toHaveLength(1);
  });

  it('updates the pull request the first run opened instead of opening another', async () => {
    const fake = github();
    const first = await actOnBump(await contextFor(fake), inputs(GREEN));
    const second = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(second.number).toBe(first.number);
    expect(fake.issues.filter((issue) => issue.isPullRequest)).toHaveLength(1);
  });

  it('finds its own issue by the hidden key, not by the title', async () => {
    const fake = github();
    await actOnBump(await contextFor(fake), inputs());
    const opened = fake.issues.at(-1);
    if (!opened) throw new Error('the first run opened nothing');
    opened.title = 'a maintainer renamed this issue';

    const second = await actOnBump(await contextFor(fake), inputs());
    expect(second.outcome).toBe('updated');
  });
});

describe('when a bot already opened a pull request for the same bump', () => {
  const dependabot = {
    number: 42,
    title: 'Bump express from 4.18.2 to 5.0.0',
    isPullRequest: true,
    author: 'dependabot[bot]',
    headRef: 'dependabot/npm_and_yarn/express-5.0.0',
    labels: ['dependencies'],
  };

  /** A comment somebody else left on that pull request, carrying this bump's marker. */
  const planted = {
    id: 700,
    issueNumber: 42,
    author: 'a-stranger',
    body: `${marker(summaryOf().key)}\nnothing to see here`,
  };

  it('comments the brief there instead of opening a second pull request', async () => {
    const fake = github({ issues: [dependabot] });
    const action = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(action.outcome).toBe('commented');
    expect(action.number).toBe(42);
    expect(fake.comments).toHaveLength(1);
    expect(writeCalls(fake)).not.toContain(ROUTES.createPull);
  });

  it('edits its own comment on a re-run rather than adding another', async () => {
    const fake = github({ issues: [dependabot] });
    await actOnBump(await contextFor(fake), inputs(GREEN));
    await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(fake.comments).toHaveLength(1);
  });

  it('leaves the bot pull request unlabelled, since bumpwarden does not own it', async () => {
    const fake = github({ issues: [dependabot] });
    await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(fake.issues.find((issue) => issue.number === 42)?.labels).toEqual(['dependencies']);
  });

  /**
   * The marker is an HTML comment, and the watched repository is public, so anyone who can comment
   * on the bot's pull request can put the same one in a comment of their own. Editing whatever
   * carried it handed the agent away: the brief went into a stranger's comment on every run, and
   * the url in the audit log pointed at text they can rewrite once the run has ended.
   */
  it('leaves a comment carrying its marker under another login alone', async () => {
    const fake = github({ issues: [dependabot], comments: [planted] });
    const action = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(fake.comments).toHaveLength(2);
    expect(fake.comments[0]?.body).toBe(planted.body);
    expect(writeCalls(fake)).not.toContain(ROUTES.updateComment);
    expect(action.detail).toContain('under another login');
  });

  it('edits its own comment even when a stranger planted one first', async () => {
    const fake = github({ issues: [dependabot], comments: [planted] });
    await actOnBump(await contextFor(fake), inputs(GREEN));
    const second = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(fake.comments).toHaveLength(2);
    expect(fake.comments[0]?.body).toBe(planted.body);
    expect(second.detail).toContain('updated a comment');
  });

  it('writes a new comment when it cannot read the login it acts under', async () => {
    const fake = github({
      issues: [dependabot],
      comments: [{ ...planted, author: 'bumpwarden' }],
      failures: { [VIEWER_ROUTE]: 403 },
    });
    const action = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(fake.comments).toHaveLength(2);
    expect(action.detail).toContain('could not be read');
  });

  it('opens its own pull request when the bot is on a different version', async () => {
    const older = { ...dependabot, title: 'Bump express from 4.18.0 to 4.18.2', headRef: 'x' };
    const fake = github({ issues: [older] });
    const action = await actOnBump(await contextFor(fake), inputs(GREEN));

    expect(action.outcome).toBe('opened');
    expect(action.kind).toBe('pull-request');
  });
});

describe('finding a bot pull request', () => {
  const pull = (over: Record<string, unknown>) => ({
    number: 1,
    url: 'u',
    title: '',
    body: '',
    state: 'open',
    labels: [],
    isPullRequest: true,
    author: 'dependabot[bot]',
    headRef: null,
    ...over,
  });

  it('recognises dependabot and renovate', () => {
    expect(
      findBotPullRequest([pull({ title: 'Bump express to 5.0.0' })], 'express', '5.0.0')?.bot,
    ).toBe('dependabot');
    expect(
      findBotPullRequest(
        [pull({ author: 'renovate[bot]', title: 'Update dependency express to v5' })],
        'express',
        '5.0.0',
      )?.bot,
    ).toBe('renovate');
  });

  it('treats a version it cannot confirm as an uncertain match', () => {
    const found = findBotPullRequest(
      [pull({ author: 'renovate[bot]', title: 'Update dependency express to v5' })],
      'express',
      '5.0.0',
    );
    expect(found?.matchesCandidate).toBe(false);
  });

  it('ignores a pull request a person opened', () => {
    expect(
      findBotPullRequest(
        [pull({ author: 'a-maintainer', title: 'Bump express to 5.0.0' })],
        'express',
        '5.0.0',
      ),
    ).toBeNull();
  });

  /**
   * A name inside a longer name is the whole hazard, and these are the real shapes it takes. A
   * substring test read every one of the first five as a match, so a brief about `react` would have
   * gone onto the bot's `react-dom` pull request and bumpwarden would have opened none of its own.
   */
  it.each([
    ['a longer sibling', 'Bump react-dom to 19.0.0', 'react'],
    ['a longer prefix', 'Bump preact to 10.0.0', 'react'],
    ['a dotted sibling', 'Bump lodash.merge to 4.6.2', 'lodash'],
    ['a scoped sibling', 'Bump @types/express to 5.0.0', 'express'],
    ['a suffixed sibling', 'Bump eslint-plugin-import to 2.0.0', 'eslint'],
  ])('does not read %s as this package', (_label, title, dependency) => {
    expect(findBotPullRequest([pull({ title })], dependency, '19.0.0')).toBeNull();
  });

  it.each([
    ['a plain title', 'Bump react to 19.0.0', null],
    ['a scoped name', 'Bump @types/node to 24.0.0', null],
    ['a renovate branch beside the title', 'Update dependency react to v19', 'renovate/react-19.x'],
  ])('still finds this package in %s', (_label, title, headRef) => {
    const dependency = title.includes('@types/node') ? '@types/node' : 'react';
    expect(findBotPullRequest([pull({ title, headRef })], dependency, '19.0.0')).not.toBeNull();
  });

  /** `5.0.0` sits inside `15.0.0`, and inside `5.0.0-rc1`, which is a different release. */
  it.each([
    ['a larger major', 'Bump express to 15.0.0'],
    ['a prerelease of the same version', 'Bump express to 5.0.0-rc1'],
  ])('does not confirm the candidate from %s', (_label, title) => {
    expect(findBotPullRequest([pull({ title })], 'express', '5.0.0')?.matchesCandidate).toBe(false);
  });

  it('ignores a bot pull request for a different package', () => {
    expect(
      findBotPullRequest([pull({ title: 'Bump hono to 4.14.0' })], 'express', '5.0.0'),
    ).toBeNull();
  });

  /**
   * The watched repository is public, so anyone can open a pull request on it under any account
   * name they registered. Matching the login as a substring handed them the agent: bumpwarden
   * would comment its brief onto their pull request and open no issue of its own, which both
   * lends the brief to a stranger's change and loses the record the policy promises.
   */
  const impostors = [
    'notdependabot',
    'dependabot-evil',
    'renovate-impostor',
    'my-renovate[bot]',
    'RENOVATEBOT-x',
  ];

  it.each(impostors)('does not take %s for the bot whose name it borrowed', (author) => {
    expect(
      findBotPullRequest([pull({ author, title: 'Bump express to 5.0.0' })], 'express', '5.0.0'),
    ).toBeNull();
  });

  it('still recognises the real logins, whatever case GitHub returns them in', () => {
    for (const author of ['dependabot[bot]', 'Dependabot[bot]', 'renovate[bot]', 'renovate-bot']) {
      expect(
        findBotPullRequest([pull({ author, title: 'Bump express to 5.0.0' })], 'express', '5.0.0'),
        author,
      ).not.toBeNull();
    }
  });
});

describe('when bumpwarden cannot write', () => {
  it('records what it would have done and touches nothing', async () => {
    const fake = github({ canPush: false });
    const action = await actOnBump(await contextFor(fake), inputs());

    expect(action.outcome).toBe('dry-run');
    expect(action.detail).toContain('would hold-issue');
    expect(action.url).toBeNull();
    expect(writeCalls(fake)).toEqual([]);
  });

  it('records a dry run when there is no token at all', async () => {
    const fake = github();
    const context = await contextFor(fake, { actor: null });
    const action = await actOnBump(context, inputs());

    expect(action.outcome).toBe('dry-run');
    expect(action.ruleId).toBe('RED-HOLD-1');
  });
});

describe('when GitHub refuses', () => {
  it('records a failed action instead of ending the run', async () => {
    const fake = github({ failures: { [ROUTES.createIssue]: 403 } });
    const action = await actOnBump(await contextFor(fake), inputs());

    expect(action.outcome).toBe('failed');
    expect(action.detail).toContain('403');
    expect(action.ruleId).toBe('RED-HOLD-1');
  });
});
