import { describe, expect, it } from 'vitest';
import { NOW, candidateBump, readyBrief, scoreOf, summaryOf } from '../testkit/fixtures.js';
import { unavailableBrief, type BriefRecord } from './brief.js';
import { keyFromBody } from './bump-key.js';
import {
  actionBody,
  botCommentBody,
  branchName,
  issueTitle,
  pullRequestTitle,
  type BodyInput,
} from './issue-body.js';
import { POLICY_VERSION, ruleFor } from './policy.js';

function input(overrides: Partial<BodyInput> = {}): BodyInput {
  const score = scoreOf();
  return {
    bump: summaryOf(),
    score,
    brief: readyBrief(),
    rule: ruleFor(score.band),
    policyVersion: POLICY_VERSION,
    runId: 'run-20260821T100000000Z-scheduled',
    at: NOW.toISOString(),
    dashboardUrl: null,
    ...overrides,
  };
}

describe('the issue body', () => {
  it('carries the hidden bump key, which is how a re-run finds it', () => {
    expect(keyFromBody(actionBody(input()))).toBe(summaryOf().key);
  });

  it('states the verdict, the score and both versions', () => {
    const body = actionBody(input());
    expect(body).toContain('Held.');
    expect(body).toContain('of 100');
    expect(body).toContain('4.18.2 to 5.0.0');
  });

  it('shows every factor that scored, with its evidence', () => {
    const body = actionBody(input());
    expect(body).toContain('Semver distance');
    expect(body).toContain('src/routes/files.ts:18');
  });

  it('does not list factors that scored nothing', () => {
    expect(actionBody(input())).not.toContain('Peer dependency range');
  });

  it('names the rule that fired and says bumpwarden never merges', () => {
    const body = actionBody(input());
    expect(body).toContain('RED-HOLD-1');
    expect(body).toContain('never merges');
  });

  it('links the dashboard when the service knows its own URL', () => {
    const body = actionBody(input({ dashboardUrl: 'https://bumpwarden.example.run/x' }));
    expect(body).toContain('https://bumpwarden.example.run/x');
  });

  it('labels an unverified claim in the text a reader sees', () => {
    const brief = readyBrief();
    const claim = brief.content?.breaksHere[0];
    if (!claim || !brief.content) throw new Error('the fixture lost its claim');
    brief.content.breaksHere = [{ ...claim, verified: false }];

    expect(actionBody(input({ brief }))).toContain('unverified');
  });

  it('says so plainly when there is no brief, and shows the score anyway', () => {
    const brief: BriefRecord = unavailableBrief({
      bumpKey: summaryOf().key,
      cacheKey: 'k',
      model: 'gemini-3.5-flash',
      rubricVersion: '1.0.0',
      generatedAt: NOW.toISOString(),
      attempts: 2,
      truncated: false,
      reason: 'the model answered with prose',
    });

    const body = actionBody(input({ brief }));
    expect(body).toContain('Brief unavailable');
    expect(body).toContain('the model answered with prose');
    expect(body).toContain('How this was scored');
  });

  it('reports truncated inputs and dropped claims rather than hiding them', () => {
    const brief = readyBrief({ truncated: true, droppedClaims: 2 });
    const body = actionBody(input({ brief }));
    expect(body).toContain('truncated');
    expect(body).toContain('2 claims were dropped');
  });

  it('stays inside the size GitHub accepts for a body', () => {
    const brief = readyBrief();
    if (!brief.content) throw new Error('the fixture lost its content');
    brief.content.whatChanged = 'x'.repeat(100_000);

    const body = actionBody(input({ brief }));
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body).toContain('Truncated');
  });

  it('writes a migration checklist on an issue and numbered steps on a pull request', () => {
    const green = scoreOf(
      candidateBump({ candidateVersion: '4.18.3', usage: 'unused', usageSites: [] }),
    );
    expect(actionBody(input())).toContain('- [ ] Rename');
    expect(actionBody(input({ score: green, rule: ruleFor('green') }))).toContain('1. Rename');
  });
});

describe('titles and branch names', () => {
  it('titles an issue with the verdict and the score', () => {
    expect(issueTitle(summaryOf(), scoreOf())).toContain('express 4.18.2 to 5.0.0');
    expect(issueTitle(summaryOf(), scoreOf())).toContain('held');
  });

  it('titles a pull request the way a bump pull request reads', () => {
    expect(pullRequestTitle(summaryOf())).toBe('Bump express from 4.18.2 to 5.0.0');
  });

  it('derives one branch name per bump, legal as a git ref', () => {
    expect(branchName(summaryOf())).toBe('bumpwarden/express-5.0.0');
    expect(branchName({ ...summaryOf(), dependency: '@types/node' })).toBe(
      'bumpwarden/-types-node-5.0.0',
    );
  });
});

describe('the comment on a bot pull request', () => {
  it('explains why it is a comment and carries the same marker', () => {
    const body = botCommentBody(input());
    expect(body).toContain('rather than opening a second pull request');
    expect(keyFromBody(body)).toBe(summaryOf().key);
  });
});
