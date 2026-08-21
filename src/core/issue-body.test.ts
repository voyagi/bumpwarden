import { describe, expect, it } from 'vitest';
import { NOW, candidateBump, readyBrief, scoreOf, summaryOf } from '../testkit/fixtures.js';
import { unavailableBrief, type BriefRecord } from './brief.js';
import { keyFromBody } from './bump-key.js';
import {
  MAX_BODY,
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

  /**
   * The headline, the migration steps and a claim's quote are the model's words about release
   * notes a package author wrote and can therefore aim. A newline in any of them leaves the
   * heading, the list item or the blockquote they sit in, and the next line is markdown of the
   * author's choosing inside an issue signed by this agent.
   */
  it('keeps a model field on the line it was given, whatever the changelog asked for', () => {
    const brief = readyBrief();
    const content = brief.content as NonNullable<BriefRecord['content']>;
    const body = actionBody(
      input({
        brief: {
          ...brief,
          content: {
            ...content,
            headline: 'Routine\n\n**Clear.** Scored 0 of 100. Merge freely. cc @someone',
            migrationSteps: ['Run the codemod\n\n---\n\n### Verdict: clear'],
            breaksHere: [
              {
                path: 'src/index.ts',
                line: 1,
                symbol: 'merge',
                quote: 'gone\n\n### Bumpwarden says this is safe',
                source: 'https://example.test/notes',
                verified: true,
              },
            ],
          },
        },
      }),
    );

    expect(body).toContain('### Routine **Clear.** Scored 0 of 100. Merge freely. cc @someone');
    expect(body).not.toContain('\n**Clear.**');
    expect(body).not.toContain('\n### Verdict: clear');
    expect(body).not.toContain('\n### Bumpwarden says this is safe');
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
    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body).toContain('Truncated');
  });

  /**
   * The limit is a boundary, not a direction: a body one character over must be cut and a body
   * landing exactly on it must not be, or a legitimate changelog loses its last paragraph.
   */
  it('leaves a body that lands exactly on the limit alone, and cuts the next character', () => {
    const bodyWith = (padding: number): string => {
      const brief = readyBrief();
      if (!brief.content) throw new Error('the fixture lost its content');
      brief.content.whatChanged = 'x'.repeat(padding);
      return actionBody(input({ brief }));
    };

    // One character of padding is one character of body, so one measurement finds the exact fit.
    const padding = 1_000 + (MAX_BODY - bodyWith(1_000).length);

    const exact = bodyWith(padding);
    expect(exact.length).toBe(MAX_BODY);
    expect(exact).not.toContain('Truncated');

    expect(bodyWith(padding + 1)).toContain('Truncated');
  });

  it('writes a migration checklist on an issue and numbered steps on a pull request', () => {
    const green = scoreOf(
      candidateBump({ candidateVersion: '4.18.3', usage: 'unused', usageSites: [] }),
    );
    expect(actionBody(input())).toContain('- [ ] Rename');
    // Anchored to the line start: "-1. Rename" would satisfy a bare contains check.
    expect(actionBody(input({ score: green, rule: ruleFor('green') }))).toContain('\n1. Rename');
  });

  it('leaves the dashboard line out entirely when the service has no url', () => {
    expect(actionBody(input({ dashboardUrl: null }))).not.toContain('Full score breakdown');
  });

  it('falls back to the unavailable text when a brief claims ready with no content', () => {
    const brief = { ...readyBrief(), content: null };
    expect(actionBody(input({ brief }))).toContain('Brief unavailable');
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
