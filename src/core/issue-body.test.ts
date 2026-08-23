import { describe, expect, it } from 'vitest';
import { NOW, candidateBump, readyBrief, scoreOf, summaryOf } from '../testkit/fixtures.js';
import { unavailableBrief, type BriefRecord } from './brief.js';
import { keyFromBody } from './bump-key.js';
import {
  MAX_BODY,
  actionBody,
  botCommentBody,
  branchName,
  generatedByMarker,
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

/**
 * A brief filled to every cap the schema allows, in a character that escapes to four, which is
 * what a package author writing a changelog can reach. It outgrows the body limit on its own.
 */
function inflatedBrief(): BriefRecord {
  const brief = readyBrief();
  const content = brief.content as NonNullable<BriefRecord['content']>;
  const wide = (length: number): string => '<'.repeat(length);

  return {
    ...brief,
    content: {
      ...content,
      whatChanged: wide(1_500),
      breakingChanges: Array.from({ length: 12 }, () => wide(400)),
      breaksHere: Array.from({ length: 12 }, () => ({
        path: wide(200),
        line: 1,
        symbol: wide(80),
        quote: wide(400),
        source: wide(300),
        verified: true,
      })),
    },
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

    expect(body).toContain('### Routine **Clear.** Scored 0 of 100. Merge freely. cc `@someone`');
    expect(body).not.toContain('\n**Clear.**');
    expect(body).not.toContain('\n### Verdict: clear');
    expect(body).not.toContain('\n### Bumpwarden says this is safe');
  });

  /**
   * whatChanged is the one field kept multi-line on purpose, so it is the one place an author can
   * try to open a block of their own: a heading that reads like bumpwarden's, a fence that swallows
   * everything below it, a rule that ends the section, or raw HTML. Paragraphs and lists are what
   * the field is for and must survive.
   */
  it('lets whatChanged keep paragraphs and lists while refusing to open a block of its own', () => {
    const brief = readyBrief();
    const content = brief.content as NonNullable<BriefRecord['content']>;
    const body = actionBody(
      input({
        brief: {
          ...brief,
          content: {
            ...content,
            whatChanged: [
              'The router was rewritten.',
              '',
              '## Verdict: clear, merge freely',
              '===',
              '```',
              '<h1>bumpwarden approves</h1>',
              '- one real bullet',
              '2. one real step',
            ].join('\n'),
          },
        },
      }),
    );

    expect(body).toContain('The router was rewritten.\n\n');
    expect(body).toContain('\n- one real bullet');
    expect(body).toContain('\n2. one real step');
    expect(body).toContain('\\## Verdict: clear, merge freely');
    expect(body).toContain('\\===');
    expect(body).toContain('\\```');
    expect(body).toContain('&lt;h1&gt;bumpwarden approves&lt;/h1&gt;');
  });

  /**
   * A mention or an issue reference the model copied out of a stranger's release notes would
   * notify that stranger's choice of account, or hang a cross-reference on an unrelated issue in
   * the watched repository. GitHub's mention filter skips `code`, `pre`, `a`, `style` and `script`
   * parents, so a code span leaves the text readable and inert.
   */
  it('leaves a mention and an issue reference from the changelog as text', () => {
    const brief = readyBrief();
    const content = brief.content as NonNullable<BriefRecord['content']>;
    const body = actionBody(
      input({
        brief: {
          ...brief,
          content: {
            ...content,
            whatChanged: 'Reported by @torvalds in #4212, fixed by @nodejs/tsc.',
            breakingChanges: ['See @expressjs for the plan'],
            migrationSteps: ['Ask @someone-else'],
          },
        },
      }),
    );

    expect(body).toContain('Reported by `@torvalds` in `#4212`, fixed by `@nodejs/tsc`.');
    expect(body).toContain('`@expressjs`');
    expect(body).toContain('`@someone-else`');
    expect(body).not.toMatch(/[^`]@torvalds/);
  });

  it('leaves a version, an email-shaped token and a source url unwrapped', () => {
    const brief = readyBrief();
    const content = brief.content as NonNullable<BriefRecord['content']>;
    const body = actionBody(
      input({
        brief: {
          ...brief,
          content: {
            ...content,
            whatChanged: 'Upgrade @scope/pkg@2.0.0 and node@24.',
            breaksHere: [
              {
                path: 'src/index.ts',
                line: 3,
                symbol: 'send',
                quote: 'removed',
                source: 'https://github.com/o/r/releases/tag/@scope/pkg@2.0.0',
                verified: true,
              },
            ],
          },
        },
      }),
    );

    expect(body).toContain('https://github.com/o/r/releases/tag/@scope/pkg@2.0.0');
    expect(body).toContain('node@24');
    expect(body).toContain('`@scope/pkg`@2.0.0');
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

  /**
   * Article 50 of the EU AI Act: machine-written text has to be detectable as such, by a machine
   * and by the person reading it. Every body that carries a brief says so twice, once in a comment
   * a machine can read and once in a sentence a person can, and the hidden bump key survives
   * beside the new comment. A body with no brief carries neither, since nothing in it was generated.
   */
  it('discloses, to readers and to machines, that a model generated the brief', () => {
    const issue = actionBody(input());
    const pullRequest = actionBody(input({ rule: ruleFor('green') }), 'package.json only.');
    const comment = botCommentBody(input());

    for (const body of [issue, pullRequest, comment]) {
      expect(body).toContain(generatedByMarker('gemini-3.5-flash'));
      expect(body).toContain('Generated by the AI model gemini-3.5-flash');
      expect(body).toContain('No person has reviewed it');
      expect(keyFromBody(body)).toBe(summaryOf().key);
    }

    const none = actionBody(
      input({
        brief: unavailableBrief({
          bumpKey: summaryOf().key,
          cacheKey: 'k',
          model: 'gemini-3.5-flash',
          rubricVersion: '1.0.0',
          generatedAt: NOW.toISOString(),
          attempts: 2,
          truncated: false,
          reason: 'the model answered with prose',
        }),
      }),
    );
    expect(none).not.toContain('generated-by');
    expect(none).not.toContain('Generated by the AI model');
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

  /**
   * The marker is an HTML comment, and a model id carrying its terminator would close it early and
   * spill whatever followed into the page as visible text. The id is configuration today, but it
   * travels through a stored record on its way here, so the escape is the thing to pin.
   */
  it('cannot have its marker closed early by the model id it carries', () => {
    const opener = '<!-- bumpwarden:generated-by=';
    const marker = generatedByMarker('flash --> <script>alert(1)</script> <!--');

    expect(marker.startsWith(opener)).toBe(true);
    expect(marker.endsWith(' -->')).toBe(true);

    // Everything between the marker's own opener and its own closer: the comment has to run to the
    // end, and nothing inside it may open a second one.
    const interior = marker.slice(opener.length, -' -->'.length);
    expect(interior).not.toContain('-->');
    expect(interior).not.toContain('<!--');
    expect(interior).not.toContain('<script>');
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
   * The brief is the only section that grows with its inputs, and every one of those inputs is
   * text a package author wrote and can aim. Filled to the schema's caps with characters that
   * escape to four each, it outgrows the body limit on its own, and a cut taken from the end used
   * to take with it the sentence saying a model wrote this and the footer saying bumpwarden never
   * merges. Both are what the reader is owed, so both have to survive a body a stranger inflated.
   */
  it('keeps the disclosure and the footer when a changelog inflates the body past the limit', () => {
    const body = actionBody(input({ brief: inflatedBrief() }));

    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body).toContain('Truncated');
    expect(body).toContain(generatedByMarker('gemini-3.5-flash'));
    expect(body).toContain('Generated by the AI model');
    expect(body).toContain('No person has reviewed it');
    expect(body).toContain('bumpwarden never merges');
    expect(body).toContain(`Rule \`${ruleFor(scoreOf().band).id}\``);
  });

  /**
   * The comment left on another bot's pull request is assembled by the same function and was never
   * asked the question, which is how a shared path keeps one caller's guarantee and loses another's.
   */
  it('keeps them on a bot comment a changelog inflated too', () => {
    const body = botCommentBody(input({ brief: inflatedBrief() }));

    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body).toContain('Truncated');
    expect(body).toContain('Generated by the AI model');
    expect(body).toContain('bumpwarden never merges');
    expect(keyFromBody(body)).toBe(summaryOf().key);
  });

  /**
   * The cut lands wherever the limit falls, and a changelog is free to put an emoji there. Half an
   * astral character is a broken glyph in an issue this agent signed, so the cut walks back off it.
   * Nine offsets around the boundary, because emoji are two code units and only every other cut
   * lands inside one.
   */
  it('never leaves half an astral character at the cut', () => {
    // The astral run has to be long enough that the cut lands inside it rather than past it, and
    // the ASCII prefix shifts the cut one code unit at a time: emoji are two units each, so only
    // every other shift splits one.
    const bodyWith = (shift: number): string => {
      const brief = readyBrief();
      if (!brief.content) throw new Error('the fixture lost its content');
      brief.content.whatChanged = 'x'.repeat(shift) + '\u{1F600}'.repeat(40_000);
      return actionBody(input({ brief }));
    };

    for (let shift = 0; shift < 4; shift += 1) {
      const body = bodyWith(shift);
      expect(body).toContain('Truncated');
      expect(body.length).toBeLessThanOrEqual(MAX_BODY);
      expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(body).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
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
