import type { BriefRecord, VerifiedClaim } from './brief.js';
import { marker } from './bump-key.js';
import type { PolicyRule } from './policy.js';
import type { Band, Score } from './types.js';

/** GitHub rejects a body over 65536 characters, and a run must never fail on a long changelog. */
export const MAX_BODY = 60_000;

export const VERDICT_WORD: Record<Band, string> = {
  green: 'Clear',
  amber: 'Caution',
  red: 'Held',
};

export interface BumpSummary {
  key: string;
  repositoryId: string;
  dependency: string;
  currentVersion: string;
  candidateVersion: string;
}

export interface BodyInput {
  bump: BumpSummary;
  score: Score;
  brief: BriefRecord;
  rule: PolicyRule;
  policyVersion: string;
  runId: string;
  at: string;
  dashboardUrl: string | null;
}

/**
 * How a bump is named everywhere a reader meets it: an issue title, an audit row, a page heading.
 * The audit log stores it with the action rather than looking the bump up per row, which is what
 * keeps the page one read instead of one read per line.
 */
export function bumpTitle(bump: BumpSummary): string {
  return `${bump.dependency} ${bump.currentVersion} to ${bump.candidateVersion}`;
}

export function issueTitle(bump: BumpSummary, score: Score): string {
  const verdict = VERDICT_WORD[score.band].toLowerCase();
  return `${bumpTitle(bump)}: ${verdict}, scored ${score.total}`;
}

export function pullRequestTitle(bump: BumpSummary): string {
  return `Bump ${bump.dependency} from ${bump.currentVersion} to ${bump.candidateVersion}`;
}

export function branchName(bump: BumpSummary): string {
  const slug = `${bump.dependency}-${bump.candidateVersion}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `bumpwarden/${slug}`;
}

function verdictLine(input: BodyInput): string {
  const { score, bump } = input;
  return [
    `**${VERDICT_WORD[score.band]}.** ${bump.dependency} ${bump.currentVersion} to ${bump.candidateVersion}`,
    `scored ${score.total} of 100 under rubric v${score.rubricVersion}, policy v${input.policyVersion}.`,
  ].join(' ');
}

function scoreTable(score: Score): string {
  const rows = score.factors
    .filter((factor) => factor.points > 0)
    .map((factor) => `| ${factor.label} | ${factor.points} | ${cell(factor.evidence)} |`);

  if (rows.length === 0) {
    return ['### How this was scored', '', 'No factor scored above zero.'].join('\n');
  }

  return [
    '### How this was scored',
    '',
    '| Factor | Points | Evidence |',
    '| --- | ---: | --- |',
    ...rows,
    `| **Total** | **${score.total}** | rubric v${score.rubricVersion} |`,
  ].join('\n');
}

/**
 * Release notes a stranger wrote would otherwise decide who an issue signed by this agent
 * notifies, and which unrelated issue in the watched repository collects a cross-reference.
 *
 * This is an empty HTML comment. GitHub keeps it in the body, shows nothing for it, and it ends
 * the text node it sits in. The mention and reference filters only match at the start of one, so
 * neither ever sees a handle to link. A backslash escape and a numeric entity both fail here,
 * because CommonMark resolves them before those filters run and the filters then see a bare `@`.
 * The tool's own markers are read back out of live issue bodies, so a comment surviving a round
 * trip through GitHub is something this code already depends on elsewhere.
 */
const INERT = '<!---->';

/**
 * GitHub links a handle after any character that is not a letter or a digit, so this asks the same
 * question rather than a narrower one. The old form excluded a dot, a dash, a slash and a backtick
 * as well, and a changelog reading `ping -@octocat` therefore notified a stranger from an issue
 * this agent signed. A preceding letter or digit still leaves `pkg@2.0.0` and `notes#12` alone,
 * and the lookbehind consumes nothing, so `@a@b` cannot hide its second handle behind its first.
 *
 * `&` stays excluded for a reference, so a numeric entity a changelog wrote (`&#39;`) still reads
 * as the character it names rather than as its own source.
 */
const MENTION =
  /(?<![A-Za-z\d])@([A-Za-z\d](?:-?[A-Za-z\d]){0,38}(?:\/[A-Za-z\d_-](?:[A-Za-z\d._-]{0,58}[A-Za-z\d_-])?)?)/g;
const ISSUE_REF = /(?<![A-Za-z\d&#])#(\d{1,7})\b/g;
/** Every markdown link and image opens with this, so escaping it is what stops the whole family. */
const LINK_OPENER = /(\\*)\[/g;
/**
 * A bare address GitHub turns into a link of its own, whose text is its destination, so there is
 * nothing in it to disguise and nothing here should rewrite it.
 *
 * A bracket or a backtick ends it. Without that, an address written to run on past its own end
 * (`https://x.example/[label](https://elsewhere`) would be read as one long address, and the
 * bracket inside it would be carried across as a stretch not to touch: the address would end up
 * shielding the very syntax this file escapes.
 */
const AUTOLINKED = /https?:\/\/[^\s<>[\]`]*[^\s<>[\]`.,:;"')]/g;

/**
 * The runs of backticks that really pair, the way CommonMark pairs them: a run opens, and the next
 * run of the same length closes it, found by a plain forward scan. Backslashes are deliberately
 * ignored, because a backslash escape does not work inside a code span, and a rule that pretended
 * otherwise read `` `a\` `` as still open and left what followed exposed.
 */
function codeSpans(line: string): Array<[number, number]> {
  const runs: Array<{ start: number; length: number }> = [];
  for (let index = 0; index < line.length;) {
    if (line[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < line.length && line[end] === '`') end += 1;
    runs.push({ start: index, length: end - index });
    index = end;
  }

  const spans: Array<[number, number]> = [];
  for (let open = 0; open < runs.length; open += 1) {
    const opener = runs[open];
    if (!opener) continue;
    const close = runs.findIndex((run, at) => at > open && run.length === opener.length);
    if (close === -1) continue;
    const closer = runs[close];
    if (!closer) continue;
    spans.push([opener.start, closer.start + closer.length]);
    open = close;
  }
  return spans;
}

/** Stretches of a line that already read as their own destination and must not be rewritten. */
function leaveAlone(line: string): Array<[number, number]> {
  const urls = [...line.matchAll(AUTOLINKED)].map((match): [number, number] => [
    match.index,
    match.index + match[0].length,
  ]);
  return [...codeSpans(line), ...urls].sort((left, right) => left[0] - right[0]);
}

/**
 * The prose between the stretches above, where a package author's words could otherwise become
 * markup of this agent's. Every neutralisation here is local: it changes the characters it is
 * given and nothing around them, so surrounding text the same author wrote cannot shift what it
 * does. Wrapping in backticks was the alternative and it could be shifted, which is why it is gone.
 */
function neutralised(text: string): string {
  return text
    .replace(/`/g, '\\`')
    .replace(MENTION, (_match, handle: string) => `@${INERT}${handle}`)
    .replace(ISSUE_REF, (_match, digits: string) => `#${INERT}${digits}`)
    .replace(LINK_OPENER, (match, escapes: string) =>
      // An odd run of backslashes already escaped this bracket, so it opens nothing and adding
      // another would only show the reader a backslash it did not have.
      escapes.length % 2 === 1 ? match : `${escapes}\\[`,
    );
}

/**
 * Everything the model wrote about someone else's release notes passes through here. Angle brackets
 * go first: GitHub keeps a subset of raw HTML in a body, so `<h1>` from a changelog would otherwise
 * render as a heading of this agent's, and `>` at the start of a line would open a blockquote.
 */
function asText(text: string): string {
  const escaped = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return escaped
    .split('\n')
    .map((line) => {
      let out = '';
      let at = 0;
      for (const [start, end] of leaveAlone(line)) {
        if (start < at) continue;
        out += neutralised(line.slice(at, start)) + line.slice(start, end);
        at = end;
      }
      return out + neutralised(line.slice(at));
    })
    .join('\n');
}

/** Collapses a field to one line without deciding anything about its characters. */
function flattened(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * The model writes these fields about release notes a package author wrote, so the author can aim
 * them. A newline is all it takes to leave the heading, the list item or the blockquote the body
 * puts them in and write markdown of their own: a fabricated verdict line, or a heading that reads
 * like bumpwarden's. Nothing here can execute on GitHub, but an issue this agent signs has to say
 * only what this agent decided.
 */
function oneLine(text: string): string {
  return asText(flattened(text));
}

/**
 * A path or a symbol goes inside a code span this file opens, where a bracket starts nothing and a
 * handle links to nobody, so it keeps its own characters and `src/app/[id]/page.tsx` reads as
 * itself. Only the backticks that would end that span early are taken out.
 */
function code(text: string): string {
  return flattened(text).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '');
}

/**
 * A line that would open a block of its own: an ATX heading, a fence, a thematic break, or the
 * underline that turns the paragraph above it into a heading. `--` is enough for the last of those,
 * which is why the dash and equals cases are not folded into the three-character rule.
 */
const OPENS_A_BLOCK =
  /^(\s*)(#{1,6}|`{3,}|~{3,}|-+[ \t]*$|=+[ \t]*$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/** A line that would open a block of its own keeps its characters as text instead. */
function keepAsText(line: string): string {
  return line.replace(
    OPENS_A_BLOCK,
    (_match, indent: string, opener: string) => `${indent}\\${opener}`,
  );
}

/**
 * `whatChanged` is the one field kept multi-line, because it is the only place the brief is allowed
 * more than a sentence. Paragraphs and lists are what it is for and survive; a line that would open
 * a block keeps its characters as text instead.
 */
function multiLine(text: string): string {
  return asText(text.replace(/\r\n/g, '\n')).split('\n').map(keepAsText).join('\n').trim();
}

/** A pipe ends a table cell, and a factor's evidence can carry a path or a quote from upstream. */
function cell(text: string): string {
  return oneLine(text).replace(/\|/g, '\\|');
}

function claimLine(claim: VerifiedClaim): string {
  const label = claim.verified ? '' : ' _(unverified: no matching call site was found)_';
  return [
    `- \`${code(claim.path)}:${claim.line}\` uses \`${code(claim.symbol)}\`${label}`,
    `  > ${oneLine(claim.quote)}`,
    `  Source: ${oneLine(claim.source)}`,
  ].join('\n');
}

/**
 * Article 50 of the EU AI Act asks that machine-written text be detectable as such, by a machine
 * and by the person reading it. The comment is the machine's copy and renders nowhere; the
 * sentence is the reader's, and it says who wrote the brief, from what, and that nobody has read
 * it yet. The bump key's marker stays separate, so a re-run still finds its own issue.
 */
export function generatedByMarker(model: string): string {
  return `<!-- bumpwarden:generated-by=${code(model)} -->`;
}

/**
 * Every clause here has to be true of what the code does. It named the diff, and the model is
 * given commit subjects and changed file names rather than one; it said the brief was checked,
 * and only a quoted claim is, which is why that clause now says which part. Overstating either is
 * worse than saying nothing, because the sentence exists to tell a reader how far to trust the
 * text under it.
 */
function disclosure(model: string, confidence: string): string {
  return [
    // Prose, not a code span, so this takes the full neutralisation rather than `code`. The model
    // id is a constant today and carries nothing of anyone else's, but a name that only holds
    // because of what happens to be assigned to it is the kind that stops holding quietly.
    `Generated by the AI model ${oneLine(model)} through bumpwarden, from this release's notes, its`,
    'commit subjects and the names of the files it changed. Quoted claims about this repository',
    'were checked against the call sites; nothing else in it was. No person has reviewed it: read',
    `it before acting on it. Confidence: ${confidence}.`,
  ].join(' ');
}

function briefSection(brief: BriefRecord): string {
  if (brief.status !== 'ready' || !brief.content) {
    // The reason is written by whatever refused: an upstream error message, a validator, or this
    // agent. Every other field from outside goes through here before it becomes part of an issue,
    // and there is no reason for this one to be the exception.
    return [
      '### Brief unavailable',
      '',
      `The agent did not return a brief that passed validation (${oneLine(brief.reason ?? 'no reason recorded')}).`,
      'The verdict above stands on the deterministic score alone.',
    ].join('\n');
  }

  const content = brief.content;
  // Both halves of the disclosure open the section, ahead of the model's own words rather than
  // under them: a reader meets "a machine wrote this" before the text it is about, and neither
  // half can be pushed off the end of the body by a long changelog.
  const parts = [
    generatedByMarker(brief.model),
    disclosure(brief.model, content.confidence),
    '',
    `### ${oneLine(content.headline)}`,
    '',
    multiLine(content.whatChanged),
  ];

  if (content.breakingChanges.length > 0) {
    parts.push(
      '',
      '**Breaking changes**',
      ...content.breakingChanges.map((line) => `- ${oneLine(line)}`),
    );
  }
  if (content.breaksHere.length > 0) {
    parts.push('', '**What breaks here**', ...content.breaksHere.map(claimLine));
  }

  const notes: string[] = [];
  if (brief.truncated) {
    notes.push('Some inputs were truncated to stay inside the token budget.');
  }
  if (brief.droppedClaims > 0) {
    const plural = brief.droppedClaims === 1 ? 'claim was' : 'claims were';
    notes.push(
      `${brief.droppedClaims} ${plural} dropped because the quoted text was not in the material the agent was given.`,
    );
  }
  if (notes.length > 0) parts.push('', ...notes);

  return parts.join('\n');
}

/**
 * The sentence the migration section opens with. Like the disclosure above it, every clause has to
 * be true of what the code does: the steps are the model's reading of someone else's notes, only a
 * quoted claim is checked against this repository, and this agent is asking for nothing.
 */
const MIGRATION_SOURCE = [
  "The model's account of what this release asks of a consumer, from the notes and the commits it",
  'was given. bumpwarden derived none of these steps and checked none of them against this',
  'repository, and nothing below is this agent asking for a command to be run.',
].join(' ');

/**
 * A migration step is the model's reading of release notes a package author wrote, and unlike a
 * quoted claim nothing checks it against anything. Set out as this agent's own checklist, "run
 * `npx something`" out of a stranger's changelog reads as a step bumpwarden worked out and stands
 * behind, which is an issue saying more than this agent decided. So the section says whose account
 * the steps are and quotes them instead of assigning them. Nothing is dropped, reworded or
 * reordered: an ordinal is the only markup added to someone else's words, a step that would open a
 * block of its own keeps its characters as text the way `whatChanged` does, and the heading and
 * the sentence open the section, so a cut for length cannot leave the steps standing without them.
 */
function migrationSection(brief: BriefRecord): string {
  const steps = brief.content?.migrationSteps ?? [];
  if (steps.length === 0) return '';

  const heading = '### Migration, as the model read the release notes';
  const quoted = steps.map((step, index) => `> ${index + 1}. ${keepAsText(oneLine(step))}`);
  return [heading, '', MIGRATION_SOURCE, '', ...quoted].join('\n');
}

function footer(input: BodyInput): string {
  const lines = [
    '---',
    `Rule \`${input.rule.id}\`: ${input.rule.summary}`,
    'bumpwarden never merges. It opens, updates, labels and explains; a person presses merge.',
    `Run \`${input.runId}\` at ${input.at}.`,
  ];
  if (input.dashboardUrl) {
    lines.push(`Full score breakdown and action log: ${input.dashboardUrl}`);
  }
  return lines.join('\n');
}

const TRUNCATION_NOTE = "_Truncated to fit GitHub's body limit._";

/** What separates two blocks of a body, and therefore what a length calculation has to allow for. */
const SEPARATOR = '\n\n';

/**
 * A cut lands wherever the limit falls, which can be between the two halves of an astral character:
 * an emoji in a changelog, or any character outside the basic plane. Half of one is a broken glyph
 * in an issue this agent signed, so the orphaned half goes with the rest.
 */
function cutAt(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Only the model's half of a body grows with its inputs, and every one of those inputs is text a
 * package author wrote. So the deterministic half is measured first and kept whole: the verdict,
 * how the score was reached, the rule that fired, and the sentence saying a person presses merge.
 * Whatever room is left goes to the model, and the cut lands there. Cutting the assembled body
 * from its end instead would have let a long changelog decide how much of bumpwarden's own
 * reasoning the reader ever saw.
 */
function assemble(
  leading: string[],
  fromTheModel: string[],
  trailing: string[],
  key: string,
): string {
  const present = (sections: string[]): string[] =>
    sections.filter((section) => section.length > 0);

  const head = [marker(key), ...present(leading)];
  const tail = present(trailing);
  const model = present(fromTheModel).join(SEPARATOR);

  const whole = [...head, ...(model.length > 0 ? [model] : []), ...tail].join(SEPARATOR);
  if (whole.length <= MAX_BODY) return whole;

  // Measured rather than predicted. The skeleton is this same body with the note standing where
  // the model's half would be, so every deterministic section is already counted inside it, and
  // what the limit leaves over is the room the model gets. The separator comes off as well,
  // because the kept text is joined to the note below it by one blank line.
  const skeleton = [...head, TRUNCATION_NOTE, ...tail].join(SEPARATOR);
  const room = MAX_BODY - skeleton.length - SEPARATOR.length;
  const shown = room > 0 ? cutAt(model, room) : '';

  const cut = shown.length > 0 ? `${shown}${SEPARATOR}${TRUNCATION_NOTE}` : TRUNCATION_NOTE;
  return [...head, cut, ...tail].join(SEPARATOR);
}

/** What the model wrote: the one part of a body a package author can lengthen. */
function modelSections(input: BodyInput): string[] {
  return [briefSection(input.brief), migrationSection(input.brief)];
}

/** What bumpwarden decided, which no changelog gets to shorten. */
function verdictSections(input: BodyInput): string[] {
  return [scoreTable(input.score), footer(input)];
}

/**
 * The body of an issue or a pull request bumpwarden opens itself. `manifestNote` is what the pull
 * request says about the change it made, and is empty for an issue.
 */
export function actionBody(input: BodyInput, manifestNote = ''): string {
  return assemble(
    [verdictLine(input), manifestNote],
    modelSections(input),
    verdictSections(input),
    input.bump.key,
  );
}

/**
 * The comment left on a Dependabot or Renovate pull request. It carries the same marker so a
 * re-run edits this comment instead of adding another, and it says out loud that the bump itself
 * belongs to the other bot.
 */
export function botCommentBody(input: BodyInput): string {
  const verdict = VERDICT_WORD[input.score.band].toLowerCase();
  const opener = `bumpwarden scored this bump ${input.score.total} of 100 (${verdict}) and is commenting here rather than opening a second pull request.`;
  return assemble([opener], modelSections(input), verdictSections(input), input.bump.key);
}
