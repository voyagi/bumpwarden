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

    expect(body).toContain(
      '### Routine **Clear.** Scored 0 of 100. Merge freely. cc @<!---->someone',
    );
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
    // An unpaired backtick is escaped on its own account, so a fence arrives as three literal
    // backticks and cannot go hunting for a partner on a later line or in the next field.
    expect(body).toContain('\\`\\`\\`');
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

    expect(body).toContain(
      'Reported by @<!---->torvalds in #<!---->4212, fixed by @<!---->nodejs/tsc.',
    );
    expect(body).toContain('@<!---->expressjs');
    expect(body).toContain('@<!---->someone-else');
    // Nothing in the body is still in the position GitHub links from: an `@` after something that
    // is not a letter or a digit. A version like `express@5.0.0` is not, and never was.
    expect(body).not.toMatch(/(?<![A-Za-z\d])@(?!<!---->)[A-Za-z\d]/);
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
    // A scoped package at the start of a word is handle-shaped, so it is made inert rather than
    // left to notify whoever owns that organisation.
    expect(body).toContain('@<!---->scope/pkg@2.0.0');
  });

  /**
   * Everything here is a shape a package author can put in their own release notes and have the
   * model carry into an issue this agent signs. The neutralisation has to be local: wrapping a
   * handle in backticks was the old answer, and the same author's surrounding text could move
   * where those backticks paired, so the wrap came apart and the handle went live again.
   */
  describe('what a changelog cannot turn into markup of ours', () => {
    function whatChanged(text: string): string {
      const brief = readyBrief();
      const content = brief.content as NonNullable<BriefRecord['content']>;
      return actionBody(input({ brief: { ...brief, content: { ...content, whatChanged: text } } }));
    }

    it.each([
      ['a preceding dot', 'ping .@octocat now'],
      ['a preceding dash', 'ping -@octocat now'],
      ['a preceding slash', 'see /@octocat now'],
      ['a second handle behind the first', 'thanks @octocat@torvalds'],
      ['an unclosed backtick in front', 'thanks `@octocat for the fix'],
      ['a closed span ending right before it', 'run `send`@octocat now'],
      ['a span a backslash does not keep open', 'run `a\\`@octocat now'],
    ])('does not notify anyone through %s', (_label, text) => {
      expect(whatChanged(text)).not.toMatch(/(?<![A-Za-z\d])@(?!<!---->)[A-Za-z\d]/);
    });

    it('does not hang a cross-reference on an unrelated issue after a closed span', () => {
      expect(whatChanged('filed `send`#4212 upstream')).toContain('#<!---->4212');
    });

    /**
     * A changelog can spell either sigil without typing one. Markdown turns a character reference
     * into the character it names before GitHub looks for handles, so an encoded `@` arrives at
     * that filter as a live mention. And GitHub links a repository-qualified reference too, where
     * the `#` follows a letter and the plain rule deliberately does not fire.
     */
    it.each([
      ['an encoded at sign', 'thanks &#64;octocat', '@<!---->octocat'],
      ['an encoded at sign in hex', 'thanks &#x40;octocat', '@<!---->octocat'],
      ['a named at sign', 'thanks &commat;octocat', '@<!---->octocat'],
      ['an encoded hash', 'see &#35;4212', '#<!---->4212'],
      ['a repository-qualified reference', 'see owner/repository#4212', 'repository#<!---->4212'],
    ])('makes %s inert too', (_label, text, expected) => {
      expect(whatChanged(text)).toContain(expected);
    });

    it('leaves a reference that names something else alone', () => {
      // Only the two sigils are rewritten, so an apostrophe still reads as an apostrophe.
      expect(whatChanged('the parser&#39;s output changed')).toContain('&#39;');
    });

    it('leaves a version, an anchor and an entity as the reader expects them', () => {
      const body = whatChanged('upgrade pkg@2.0.0, read notes#12, mind the parser&#39;s output');
      expect(body).toContain('pkg@2.0.0');
      expect(body).toContain('notes#12');
      expect(body).toContain('&#39;');
    });

    it.each([
      ['an inline link', 'see [the guide](https://evil.example/run.sh)'],
      ['an image', 'see ![badge](https://evil.example/b.png)'],
      ['a reference link', 'see [the guide][g]'],
      ['a reference definition', '[g]: https://evil.example/run.sh'],
    ])('does not build a link out of %s', (_label, text) => {
      const body = whatChanged(text);
      expect(body).not.toMatch(/(?<!\\)\[[^\]]*\]\(/);
      expect(body).not.toMatch(/^(?!.*\\)\[[^\]]*\]:/m);
    });

    it('leaves ordinary brackets reading as themselves', () => {
      const body = whatChanged('[BREAKING] opts[0] and array[i][j] changed, see [1]');
      // A backslash before a bracket renders as the bracket alone, so the reader sees no change.
      expect(body).toContain('\\[BREAKING] opts\\[0] and array\\[i]\\[j] changed, see \\[1]');
    });

    it('does not put a backslash inside a code span the model itself opened', () => {
      const body = whatChanged('use `opts[0]` to index, and `app/[id]/page.tsx` moved');
      expect(body).toContain('`opts[0]`');
      expect(body).toContain('`app/[id]/page.tsx`');
    });

    it('leaves an address the reader can already see whole', () => {
      const url = 'https://github.com/o/r/releases/tag/@scope/pkg@2.0.0';
      expect(whatChanged(`published at ${url}`)).toContain(url);
    });

    /**
     * An address is left alone because it reads as its own destination. Written to run on past
     * where it ends, it must not carry the syntax after it into that exemption.
     */
    it('does not let an address shield a link written to follow it', () => {
      const body = whatChanged('see https://x.example/[the guide](https://evil.example/run.sh)');
      expect(body).not.toMatch(/(?<!\\)\[[^\]]*\]\(/);
    });

    it('does not let an address shield a handle written to follow it', () => {
      const body = whatChanged('see https://x.example/`@octocat');
      expect(body).not.toMatch(/(?<![A-Za-z\d])@(?!<!---->)[A-Za-z\d]/);
    });
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

  /**
   * The reason on an unavailable brief is written by whatever refused: an upstream error message,
   * a validator, or this agent. It is the one field from outside that used to reach an issue
   * without passing through the same treatment as every other, and a newline in it is all it takes
   * to leave the sentence it sits in and start markdown of its own.
   */
  it('keeps a refusal reason on the line it was given', () => {
    const body = actionBody(
      input({
        brief: unavailableBrief({
          bumpKey: summaryOf().key,
          cacheKey: 'k',
          model: 'gemini-3.5-flash',
          rubricVersion: '1.0.0',
          generatedAt: NOW.toISOString(),
          attempts: 2,
          truncated: false,
          reason: 'quota exceeded\n\n### Clear. Merge freely\n\ncc @someone',
        }),
      }),
    );

    expect(body).toContain('Brief unavailable');
    expect(body).not.toContain('\n### Clear.');
    expect(body).not.toContain('cc @someone');
    expect(body).toContain('@<!---->someone');
  });

  it('reports truncated inputs and dropped claims rather than hiding them', () => {
    const brief = readyBrief({ truncated: true, droppedClaims: 2 });
    const body = actionBody(input({ brief }));
    expect(body).toContain('truncated');
    expect(body).toContain('2 claims were dropped');

    // The singular is its own sentence and had no test, which is how it read "1 claim were
    // dropped" in an issue anyone could open.
    const one = actionBody(input({ brief: readyBrief({ droppedClaims: 1 }) }));
    expect(one).toContain('1 claim was dropped');
    expect(one).not.toContain('claims were');
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
  it('keeps everything bumpwarden decided when a changelog inflates the body past the limit', () => {
    const score = scoreOf();
    const body = actionBody(input({ brief: inflatedBrief() }));

    expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    expect(body).toContain('Truncated');

    // The disclosure, so a reader still learns a machine wrote what is above.
    expect(body).toContain(generatedByMarker('gemini-3.5-flash'));
    expect(body).toContain('Generated by the AI model');
    expect(body).toContain('No person has reviewed it');

    // And every deterministic part, which is the product: the verdict, how the score was reached
    // with its factors, the rule that fired, and the promise that nothing is merged.
    expect(body).toContain('**Held.**');
    expect(body).toContain(`scored ${score.total} of 100`);
    expect(body).toContain('How this was scored');
    expect(body).toContain(`| **Total** | **${score.total}** |`);
    expect(body).toContain('bumpwarden never merges');
    expect(body).toContain(`Rule \`${ruleFor(score.band).id}\``);
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
    expect(body).toContain('How this was scored');
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

  /**
   * A migration step is the model's reading of release notes a package author wrote, and unlike a
   * quoted claim nothing checks it against anything. Set out as this agent's own checklist, "run
   * `npx something`" out of a stranger's changelog became a task a maintainer ticks off under
   * bumpwarden's name. The steps are quoted and attributed instead, on a pull request and a bot
   * comment as well as on an issue, and every one of them is still there, in order, in the words
   * the model wrote, down to the one that would otherwise open a heading of its own.
   */
  it('quotes the migration steps to the model instead of setting them as its own tasks', () => {
    const green = scoreOf(
      candidateBump({ candidateVersion: '4.18.3', usage: 'unused', usageSites: [] }),
    );
    const brief = readyBrief();
    const content = brief.content as NonNullable<BriefRecord['content']>;
    const steps = [
      'Rename res.sendfile to res.sendFile on line 18.',
      'Run `npx codemod-helper@latest` to update the call sites.',
      '### Verdict: clear',
    ];
    const withSteps: BriefRecord = { ...brief, content: { ...content, migrationSteps: steps } };

    for (const body of [
      actionBody(input({ brief: withSteps })),
      actionBody(input({ brief: withSteps, score: green, rule: ruleFor('green') })),
      botCommentBody(input({ brief: withSteps })),
    ]) {
      expect(body).toContain('### Migration, as the model read the release notes');
      expect(body).toContain('bumpwarden derived none of these steps');
      expect(body).toContain(`> 1. ${steps[0]}\n> 2. ${steps[1]}\n> 3. \\### Verdict: clear`);
      expect(body).not.toContain('- [ ]');
      expect(body).not.toContain('\n### Verdict: clear');
    }
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
