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
 * A handle or an issue number inside a code span stays text: GitHub's mention filter skips `code`,
 * `pre`, `a`, `style` and `script` parents. Without this, release notes a stranger wrote decide who
 * an issue signed by this agent notifies, and which unrelated issue in the watched repository
 * collects a cross-reference. Both forms keep their preceding character out of the handle so a
 * scoped version (`pkg@2.0.0`), a path (`/@scope`) and an anchor (`notes#12`) are left alone.
 */
const MENTION =
  /(^|[^\w`/.-])@([A-Za-z\d](?:-?[A-Za-z\d]){0,38}(?:\/[A-Za-z\d_-](?:[A-Za-z\d._-]{0,58}[A-Za-z\d_-])?)?)/g;
const ISSUE_REF = /(^|[^\w`&#])#(\d{1,7})\b/g;

/**
 * Everything the model wrote about someone else's release notes passes through here. Angle brackets
 * go first: GitHub keeps a subset of raw HTML in a body, so `<h1>` from a changelog would otherwise
 * render as a heading of this agent's, and `>` at the start of a line would open a blockquote.
 */
function asText(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(MENTION, (_match, before: string, handle: string) => `${before}\`@${handle}\``)
    .replace(ISSUE_REF, (_match, before: string, digits: string) => `${before}\`#${digits}\``);
}

/**
 * The model writes these fields about release notes a package author wrote, so the author can aim
 * them. A newline is all it takes to leave the heading, the list item or the blockquote the body
 * puts them in and write markdown of their own: a fabricated verdict line, or a heading that reads
 * like bumpwarden's. Nothing here can execute on GitHub, but an issue this agent signs has to say
 * only what this agent decided.
 */
function oneLine(text: string): string {
  return asText(text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
}

/** A code span ends at the next backtick, and neither a path nor a symbol legitimately holds one. */
function code(text: string): string {
  return oneLine(text).replace(/`/g, '');
}

/**
 * A line that would open a block of its own: an ATX heading, a fence, a thematic break, or the
 * underline that turns the paragraph above it into a heading. `--` is enough for the last of those,
 * which is why the dash and equals cases are not folded into the three-character rule.
 */
const OPENS_A_BLOCK =
  /^(\s*)(#{1,6}|`{3,}|~{3,}|-+[ \t]*$|=+[ \t]*$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;

/**
 * `whatChanged` is the one field kept multi-line, because it is the only place the brief is allowed
 * more than a sentence. Paragraphs and lists are what it is for and survive; a line that would open
 * a block keeps its characters as text instead.
 */
function multiLine(text: string): string {
  return asText(text.replace(/\r\n/g, '\n'))
    .split('\n')
    .map((line) =>
      line.replace(
        OPENS_A_BLOCK,
        (_match, indent: string, opener: string) => `${indent}\\${opener}`,
      ),
    )
    .join('\n')
    .trim();
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

function briefSection(brief: BriefRecord): string {
  if (brief.status !== 'ready' || !brief.content) {
    return [
      '### Brief unavailable',
      '',
      `The agent did not return a brief that passed validation (${brief.reason ?? 'no reason recorded'}).`,
      'The verdict above stands on the deterministic score alone.',
    ].join('\n');
  }

  const content = brief.content;
  const parts = [`### ${oneLine(content.headline)}`, '', multiLine(content.whatChanged)];

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
  parts.push('', `Confidence: ${content.confidence}. Model: ${brief.model}.`);
  if (brief.truncated) {
    parts.push('Some inputs were truncated to stay inside the token budget.');
  }
  if (brief.droppedClaims > 0) {
    const plural = brief.droppedClaims === 1 ? 'claim' : 'claims';
    parts.push(
      `${brief.droppedClaims} ${plural} were dropped because the quoted text was not in the material the agent was given.`,
    );
  }
  return parts.join('\n');
}

function migrationSection(brief: BriefRecord, checklist: boolean): string {
  const steps = brief.content?.migrationSteps ?? [];
  if (steps.length === 0) return '';

  const lines = steps.map((step, index) =>
    checklist ? `- [ ] ${oneLine(step)}` : `${index + 1}. ${oneLine(step)}`,
  );
  return ['### Migration', '', ...lines].join('\n');
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

function assemble(sections: string[], key: string): string {
  const body = [marker(key), ...sections.filter((section) => section.length > 0)].join('\n\n');
  if (body.length <= MAX_BODY) return body;
  return `${body.slice(0, MAX_BODY - 80)}\n\n_Truncated to fit GitHub's body limit._`;
}

function evidenceSections(input: BodyInput, checklist: boolean): string[] {
  return [
    briefSection(input.brief),
    migrationSection(input.brief, checklist),
    scoreTable(input.score),
    footer(input),
  ];
}

/**
 * The body of an issue or a pull request bumpwarden opens itself. `manifestNote` is what the pull
 * request says about the change it made, and is empty for an issue.
 */
export function actionBody(input: BodyInput, manifestNote = ''): string {
  const checklist = input.rule.kind !== 'pull-request';
  return assemble(
    [verdictLine(input), manifestNote, ...evidenceSections(input, checklist)],
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
  return assemble([opener, ...evidenceSections(input, false)], input.bump.key);
}
