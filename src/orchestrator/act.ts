import type { BriefRecord } from '../core/brief.js';
import { bodyCarriesKey } from '../core/bump-key.js';
import {
  actionBody,
  botCommentBody,
  branchName,
  bumpTitle,
  issueTitle,
  pullRequestTitle,
  type BodyInput,
  type BumpSummary,
} from '../core/issue-body.js';
import { bumpManifestRange } from '../core/manifest-edit.js';
import {
  LOCKFILE_POLICY,
  POLICY_VERSION,
  decideAction,
  ruleFor,
  type ActionKind,
  type BotPullRequest,
  type PolicyRuleId,
} from '../core/policy.js';
import { actionIdFor, type ActionOutcome, type ActionRecord } from '../core/records.js';
import { absoluteUrl, bumpPath } from '../core/routes.js';
import type { Score } from '../core/types.js';
import type { IssueLike, RepositoryActor } from '../io/github-actor.js';

const MANIFEST = 'package.json';

export interface ActInputs {
  bump: BumpSummary;
  score: Score;
  brief: BriefRecord;
}

export interface ActContext {
  /** Null when no token is configured at all: the run then records what it would have done. */
  actor: RepositoryActor | null;
  canWrite: boolean;
  defaultBranch: string;
  /** Issues and pull requests already carrying the bumpwarden label, read once per repository. */
  existing: IssueLike[];
  openPullRequests: IssueLike[];
  runId: string;
  at: Date;
  dashboardBaseUrl: string | null;
}

interface ActionShape {
  outcome: ActionOutcome;
  url: string | null;
  number: number | null;
  detail: string;
}

/**
 * The exact logins the two bots post under, not a substring of them. Anyone may register an
 * account containing the word "renovate" and open a pull request on a public repository, and a
 * substring match would let them redirect bumpwarden's brief onto a pull request they control
 * while the issue that should have been opened never is.
 */
const BOT_LOGINS = new Map<string, BotPullRequest['bot']>([
  ['dependabot[bot]', 'dependabot'],
  ['dependabot-preview[bot]', 'dependabot'],
  ['renovate[bot]', 'renovate'],
  ['renovate-bot', 'renovate'],
  ['mend-for-github-com[bot]', 'renovate'],
]);

function botOf(login: string): BotPullRequest['bot'] | null {
  return BOT_LOGINS.get(login.toLowerCase()) ?? null;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A package name inside a longer package name is the trap here, and it is not a rare shape:
 * `react` sits inside `react-dom` and inside `preact`, `lodash` inside `lodash.merge`. A substring
 * test therefore reads a bot's pull request for the neighbour as one for this package. The
 * characters below are the ones that can carry a name onward, so a match touching any of them is a
 * match inside something else. A slash is among them: a title says "update dependency express",
 * with spaces, and only a branch name puts a prefix in front of it.
 */
const NAME_EDGE = '[\\w@./-]';

/**
 * Versions have the same trap and a worse one, because `5.0.0` sits inside `15.0.0` and inside
 * `5.0.0-rc1`, and the second is a different release rather than a longer name.
 */
const VERSION_EDGE = '[\\d.+-]';

function mentions(haystack: string, needle: string, edge: string): boolean {
  return new RegExp(`(?<!${edge})${escapeForRegex(needle)}(?!${edge})`, 'i').test(haystack);
}

/**
 * A bot pull request only counts when it is for this package AND this exact version. Renovate often
 * titles a major bump "to v5" with no patch version, and a brief commented onto the wrong pull
 * request is worse than bumpwarden opening its own, so an inexact match is treated as no match.
 * That preference decides the boundary rules above too: they are strict enough to miss a real
 * match written in an unusual way, which costs a duplicate pull request somebody can see, rather
 * than loose enough to comment on a neighbour's, which costs a brief filed under the wrong package.
 */
/**
 * Finds an existing pull request from Dependabot or Renovate for the given dependency.
 * Returns information about the PR if found, including whether it matches the candidate version.
 */
export function findBotPullRequest(
  pulls: IssueLike[],
  dependency: string,
  candidateVersion: string,
): BotPullRequest | null {
  for (const pull of pulls) {
    const bot = botOf(pull.author);
    if (!bot) continue;

    const haystack = `${pull.title} ${pull.headRef ?? ''}`;
    if (!mentions(haystack, dependency, NAME_EDGE)) continue;

    return {
      number: pull.number,
      url: pull.url,
      bot,
      matchesCandidate: mentions(haystack, candidateVersion, VERSION_EDGE),
    };
  }
  return null;
}

function bodyInput(context: ActContext, inputs: ActInputs): BodyInput {
  return {
    bump: inputs.bump,
    score: inputs.score,
    brief: inputs.brief,
    rule: ruleFor(inputs.score.band),
    policyVersion: POLICY_VERSION,
    runId: context.runId,
    at: context.at.toISOString(),
    dashboardUrl: absoluteUrl(
      context.dashboardBaseUrl,
      bumpPath(inputs.bump.repositoryId, inputs.bump.key),
    ),
  };
}

/**
 * What the audit row says beyond the action itself. Both cases belong there: a marker under another
 * login is either a comment from a token that has since been replaced or somebody trying to have
 * the brief written into text they can rewrite afterwards, and a login this token cannot read is
 * the reason a re-run left a second comment instead of editing the first.
 */
function markerNote(selfLogin: string | null, carrying: number, mine: boolean): string {
  if (!selfLogin) {
    return carrying > 0 ? '; the login this token acts under could not be read' : '';
  }

  const others = carrying - (mine ? 1 : 0);
  if (others === 0) return '';
  return `; ${others} ${others === 1 ? 'comment carries' : 'comments carry'} the same marker under another login`;
}

/**
 * The marker says which bump a comment is about. It does not say who wrote it: it is an HTML
 * comment in a body anyone who can comment on the bot's pull request may copy, so treating the
 * marker as proof handed the agent away. A stranger who planted one first would have had the brief
 * written into their comment on every run, bumpwarden would have left none of its own, and the url
 * in the audit log would point at text they can rewrite the moment the run ends. The login decides
 * and the marker only narrows, which is what makes `mine` its name.
 */
async function commentOnBotPullRequest(
  actor: RepositoryActor,
  target: BotPullRequest,
  input: BodyInput,
): Promise<ActionShape> {
  const body = botCommentBody(input);
  const selfLogin = await actor.selfLogin();
  const carrying = (await actor.listComments(target.number)).filter((comment) =>
    bodyCarriesKey(comment.body, input.bump.key),
  );
  const mine = selfLogin
    ? carrying.find((comment) => comment.author.toLowerCase() === selfLogin.toLowerCase())
    : undefined;

  const comment = mine
    ? await actor.updateComment(mine.id, body)
    : await actor.createComment(target.number, body);

  const note = markerNote(selfLogin, carrying.length, mine !== undefined);
  return {
    outcome: 'commented',
    url: comment.url || target.url,
    number: target.number,
    detail: `${mine ? 'updated' : 'left'} a comment on ${target.bot} #${target.number}${note}`,
  };
}

async function upsertIssue(
  actor: RepositoryActor,
  existing: IssueLike | undefined,
  input: BodyInput,
  labels: string[],
): Promise<ActionShape> {
  const payload = { title: issueTitle(input.bump, input.score), body: actionBody(input), labels };

  if (existing) {
    const updated = await actor.updateIssue(existing.number, payload);
    return {
      outcome: 'updated',
      url: updated.url || existing.url,
      number: existing.number,
      detail: `updated issue #${existing.number}`,
    };
  }

  const opened = await actor.createIssue(payload);
  return {
    outcome: 'opened',
    url: opened.url,
    number: opened.number,
    detail: `opened issue #${opened.number}`,
  };
}

function manifestNote(from: string, to: string, dependency: string): string {
  return [
    `\`${MANIFEST}\`: \`${dependency}\` moves from \`${from}\` to \`${to}\`.`,
    LOCKFILE_POLICY,
    'Run `npm install` on this branch before merging so the lockfile matches.',
  ].join(' ');
}

/**
 * Opens the pull request for a green bump. Returns null when the manifest range is one the editor
 * refuses to touch (a git url, a workspace protocol, a dist-tag), so the caller can fall back to an
 * issue rather than opening a pull request that changes nothing.
 */
async function openBumpPullRequest(
  actor: RepositoryActor,
  context: ActContext,
  input: BodyInput,
  labels: string[],
): Promise<ActionShape | null> {
  const branch = branchName(input.bump);
  const baseSha = await actor.headSha(context.defaultBranch);
  await actor.ensureBranch(branch, baseSha);

  const file = await actor.readFile(MANIFEST, branch);
  const edit = bumpManifestRange(file.text, input.bump.dependency, input.bump.candidateVersion);
  if (!edit) return null;

  if (edit.text !== file.text) {
    await actor.writeFile({
      path: MANIFEST,
      text: edit.text,
      sha: file.sha,
      branch,
      message: pullRequestTitle(input.bump),
    });
  }

  const note = manifestNote(edit.from, edit.to, input.bump.dependency);
  const pull = await actor.createPullRequest({
    title: pullRequestTitle(input.bump),
    body: actionBody(input, note),
    head: branch,
    base: context.defaultBranch,
  });

  await actor.addLabels(pull.number, labels);
  return {
    outcome: 'opened',
    url: pull.url,
    number: pull.number,
    detail: `opened pull request #${pull.number} on ${branch}`,
  };
}

function dryRun(kind: string, input: BodyInput): ActionShape {
  return {
    outcome: 'dry-run',
    url: null,
    number: null,
    detail: `would ${kind}: ${issueTitle(input.bump, input.score)}`,
  };
}

interface PerformedAction {
  shape: ActionShape;
  ruleId: PolicyRuleId;
  kind: ActionKind;
}

async function perform(
  context: ActContext,
  inputs: ActInputs,
  input: BodyInput,
): Promise<PerformedAction> {
  const existing = context.existing.find((item) => bodyCarriesKey(item.body, inputs.bump.key));
  const bot = findBotPullRequest(
    context.openPullRequests,
    inputs.bump.dependency,
    inputs.bump.candidateVersion,
  );
  const decision = decideAction(inputs.score.band, { botPullRequest: bot });
  const actor = context.actor;

  if (!actor || !context.canWrite) {
    return { shape: dryRun(decision.kind, input), ruleId: decision.ruleId, kind: decision.kind };
  }

  if (decision.kind === 'comment-on-bot-pull-request' && decision.target) {
    const shape = await commentOnBotPullRequest(actor, decision.target, input);
    return { shape, ruleId: decision.ruleId, kind: decision.kind };
  }

  if (decision.kind === 'pull-request' && !existing) {
    const shape = await openBumpPullRequest(actor, context, input, decision.labels);
    if (shape) return { shape, ruleId: decision.ruleId, kind: decision.kind };

    const fallback = await upsertIssue(actor, undefined, input, decision.labels);
    return {
      shape: {
        ...fallback,
        detail: `${fallback.detail}; the manifest range is not one bumpwarden edits`,
      },
      ruleId: decision.ruleId,
      kind: 'issue',
    };
  }

  const shape = await upsertIssue(actor, existing, input, decision.labels);
  return { shape, ruleId: decision.ruleId, kind: decision.kind };
}

/**
 * One bump, one action, recorded whatever happens. A GitHub failure becomes a recorded failed
 * action rather than an exception, because a run that stops at the first unlucky repository leaves
 * the operator with no verdicts at all.
 */
export async function actOnBump(context: ActContext, inputs: ActInputs): Promise<ActionRecord> {
  const input = bodyInput(context, inputs);
  const at = context.at.toISOString();

  const base = {
    id: actionIdFor(context.runId, inputs.bump.key),
    bumpKey: inputs.bump.key,
    bumpTitle: bumpTitle(inputs.bump),
    repositoryId: inputs.bump.repositoryId,
    runId: context.runId,
    at,
    score: inputs.score.total,
    band: inputs.score.band,
  };

  try {
    const { shape, ruleId, kind } = await perform(context, inputs, input);
    return {
      ...base,
      ruleId,
      kind,
      outcome: shape.outcome,
      url: shape.url,
      number: shape.number,
      detail: shape.detail,
    };
  } catch (error) {
    return {
      ...base,
      ruleId: ruleFor(inputs.score.band).id,
      kind: ruleFor(inputs.score.band).kind,
      outcome: 'failed',
      url: null,
      number: null,
      detail: error instanceof Error ? error.message : 'the GitHub action failed',
    };
  }
}
