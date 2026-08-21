import type { Band } from './types.js';

/**
 * Policy v1. Like the rubric, it is versioned and published: a stored action keeps the version it
 * was decided under, so tightening a rule never rewrites what an earlier run did.
 */
export const POLICY_VERSION = '1.0.0';

export type PolicyRuleId = 'GRN-PR-1' | 'AMB-ISSUE-1' | 'RED-HOLD-1';

/**
 * Every action bumpwarden can take. There is no merge member and there is no configuration that
 * adds one: autonomy stops at the merge button, and a union with no merge in it is the only form of
 * that promise a reader can check. `policy.test.ts` asserts the union stays merge-free.
 */
export type ActionKind = 'pull-request' | 'issue' | 'hold-issue' | 'comment-on-bot-pull-request';

export const LABEL_ROOT = 'bumpwarden';

export interface PolicyRule {
  id: PolicyRuleId;
  band: Band;
  kind: Exclude<ActionKind, 'comment-on-bot-pull-request'>;
  /**
   * Two label families on purpose. `bumpwarden:<band>` is the machine-readable verdict, and
   * `bumpwarden:review` / `bumpwarden:hold` are the names the published Policy page gives these
   * rules, so a reader filtering by the label the page told them about finds the issue.
   */
  labels: string[];
  /** The sentence the Policy page publishes for this rule, kept in one place so the two agree. */
  summary: string;
}

export const POLICY_RULES: Record<Band, PolicyRule> = {
  green: {
    id: 'GRN-PR-1',
    band: 'green',
    kind: 'pull-request',
    labels: [LABEL_ROOT, `${LABEL_ROOT}:green`],
    summary:
      'Open a pull request with the bump and the brief. If Dependabot or Renovate already opened one for the same bump, comment there instead of duplicating it.',
  },
  amber: {
    id: 'AMB-ISSUE-1',
    band: 'amber',
    kind: 'issue',
    labels: [LABEL_ROOT, `${LABEL_ROOT}:amber`, `${LABEL_ROOT}:review`],
    summary:
      'Open an issue carrying the brief and a migration checklist, labelled bumpwarden:review. No pull request.',
  },
  red: {
    id: 'RED-HOLD-1',
    band: 'red',
    kind: 'hold-issue',
    labels: [LABEL_ROOT, `${LABEL_ROOT}:red`, `${LABEL_ROOT}:hold`],
    summary:
      'Open a hold issue with a migration plan, labelled bumpwarden:hold. Never open a pull request for a held bump.',
  },
};

export interface BotPullRequest {
  number: number;
  url: string;
  bot: 'dependabot' | 'renovate';
  /** True only when the PR is for this package AND this candidate version. */
  matchesCandidate: boolean;
}

export interface PolicyContext {
  botPullRequest: BotPullRequest | null;
}

export interface PolicyDecision {
  ruleId: PolicyRuleId;
  kind: ActionKind;
  labels: string[];
  rationale: string;
  /** The bot pull request to comment on, when that is the decision. */
  target: BotPullRequest | null;
}

export function ruleFor(band: Band): PolicyRule {
  return POLICY_RULES[band];
}

/**
 * The band decides the action; the only thing context can change is where a green bump's brief is
 * written. An uncertain bot match falls back to bumpwarden's own pull request, because a brief
 * commented onto the wrong pull request is worse than a duplicate a human can close.
 */
export function decideAction(
  band: Band,
  context: PolicyContext = { botPullRequest: null },
): PolicyDecision {
  const rule = ruleFor(band);
  const bot = context.botPullRequest;

  if (rule.kind === 'pull-request' && bot?.matchesCandidate) {
    return {
      ruleId: rule.id,
      kind: 'comment-on-bot-pull-request',
      labels: [],
      rationale: `${bot.bot} already opened #${bot.number} for this bump, so the brief goes there`,
      target: bot,
    };
  }

  return {
    ruleId: rule.id,
    kind: rule.kind,
    labels: rule.labels,
    rationale: rule.summary,
    target: null,
  };
}
