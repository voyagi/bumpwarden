import { describe, expect, it } from 'vitest';
import {
  LABEL_ROOT,
  POLICY_RULES,
  POLICY_VERSION,
  decideAction,
  ruleFor,
  type ActionKind,
  type BotPullRequest,
} from './policy.js';
import type { Band } from './types.js';

function bot(overrides: Partial<BotPullRequest> = {}): BotPullRequest {
  return {
    number: 42,
    url: 'https://github.com/demo/app/pull/42',
    bot: 'dependabot',
    matchesCandidate: true,
    ...overrides,
  };
}

describe('policy v1', () => {
  const table: Array<[Band, string, ActionKind]> = [
    ['green', 'GRN-PR-1', 'pull-request'],
    ['amber', 'AMB-ISSUE-1', 'issue'],
    ['red', 'RED-HOLD-1', 'hold-issue'],
  ];

  it.each(table)('%s fires %s and takes the %s action', (band, ruleId, kind) => {
    const decision = decideAction(band);
    expect(decision.ruleId).toBe(ruleId);
    expect(decision.kind).toBe(kind);
    expect(ruleFor(band).id).toBe(ruleId);
  });

  it('is versioned, so a stored action can be read against the policy that decided it', () => {
    expect(POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(table)('labels a %s action with the root label and the band', (band) => {
    const labels = decideAction(band).labels;
    expect(labels).toContain(LABEL_ROOT);
    expect(labels).toContain(`${LABEL_ROOT}:${band}`);
  });

  it('carries the label names the published policy page tells a reader to filter by', () => {
    expect(POLICY_RULES.amber.labels).toContain('bumpwarden:review');
    expect(POLICY_RULES.red.labels).toContain('bumpwarden:hold');
  });

  it('has no merge among the actions it can take, and cannot grow one silently', () => {
    // Exhaustive by construction: adding a member to ActionKind fails to compile until it is
    // listed here, and this assertion then decides whether the new member is allowed to exist.
    const every: Record<ActionKind, true> = {
      'pull-request': true,
      issue: true,
      'hold-issue': true,
      'comment-on-bot-pull-request': true,
    };
    expect(Object.keys(every).filter((kind) => /merge/i.test(kind))).toEqual([]);
  });
});

describe('an existing bot pull request', () => {
  it('takes the brief as a comment instead of a second pull request', () => {
    const decision = decideAction('green', { botPullRequest: bot() });
    expect(decision.kind).toBe('comment-on-bot-pull-request');
    expect(decision.target?.number).toBe(42);
    expect(decision.ruleId).toBe('GRN-PR-1');
  });

  it('applies no labels to a pull request bumpwarden does not own', () => {
    expect(decideAction('green', { botPullRequest: bot() }).labels).toEqual([]);
  });

  it('falls back to its own pull request when the bot match is uncertain', () => {
    const decision = decideAction('green', { botPullRequest: bot({ matchesCandidate: false }) });
    expect(decision.kind).toBe('pull-request');
    expect(decision.target).toBeNull();
  });

  it('does not change an amber or red verdict, which never open a pull request anyway', () => {
    expect(decideAction('amber', { botPullRequest: bot() }).kind).toBe('issue');
    expect(decideAction('red', { botPullRequest: bot() }).kind).toBe('hold-issue');
  });
});
