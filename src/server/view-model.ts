import { VERDICT_WORD } from '../core/issue-body.js';
import type { ActionKind } from '../core/policy.js';
import {
  totalBumps,
  type ActionRecord,
  type BandCounts,
  type RunRecord,
  type Trigger,
} from '../core/records.js';
import { bumpPath } from '../core/routes.js';
import { BAND_THRESHOLDS, POINTS } from '../core/rubric.js';
import type { Band, Score } from '../core/types.js';

/**
 * The colour law from design/ART-DIRECTION.md, in one place. A mark on the risk ramp takes the band
 * step; the band's word takes a step darker at amber so small text still clears contrast on the
 * panel it sits on. Nothing else on any page is allowed either of these values.
 */
export const MARK_COLOR: Record<Band, string> = {
  green: 'var(--r0)',
  amber: 'var(--r2)',
  red: 'var(--r4)',
};

export const WORD_COLOR: Record<Band, string> = {
  green: 'var(--r0)',
  amber: 'var(--r3)',
  red: 'var(--r4)',
};

/** Where the two band boundaries fall on a 0 to 100 axis: the last green, and the first red. */
export const THRESHOLD_MARKS = [BAND_THRESHOLDS.greenMax, BAND_THRESHOLDS.amberMax + 1] as const;

/** A score of zero is still a measurement that ran, so its track keeps a visible sliver. */
const MIN_TRACK_PERCENT = 1.5;

/** The heaviest single factor in the rubric, so a factor bar is proportional to what it could be. */
const LARGEST_FACTOR = Math.max(...Object.values(POINTS));

export function verdictWord(band: Band): string {
  return VERDICT_WORD[band];
}

export function trackWidth(total: number): string {
  return `${Math.max(total, MIN_TRACK_PERCENT)}%`;
}

export function factorWidth(points: number): string {
  if (points <= 0) return '0';
  return `${Math.round((points / LARGEST_FACTOR) * 1000) / 10}%`;
}

/** Pins alternate lanes so two labels close together on the axis never sit on top of each other. */
export function laneClass(index: number): string {
  return index % 2 === 0 ? 'lane-a' : 'lane-b';
}

export function queueSentence(counts: BandCounts): string {
  const total = totalBumps(counts);
  if (total === 0) return 'no bumps pending';

  const parts = [
    counts.green > 0 ? `${counts.green} clear` : '',
    counts.amber > 0 ? `${counts.amber} caution` : '',
    counts.red > 0 ? `${counts.red} held` : '',
  ].filter((part) => part.length > 0);

  const quiet = counts.amber + counts.red === 0 ? ', nothing to do' : '';
  return `${total} ${total === 1 ? 'bump' : 'bumps'}: ${parts.join(', ')}${quiet}`;
}

function valid(iso: string | null): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function utcTime(iso: string | null): string {
  const at = valid(iso);
  return at ? at.toISOString().slice(11, 16) : 'unknown';
}

export function utcStamp(iso: string | null): string {
  const at = valid(iso);
  return at ? `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 19)}` : 'unknown';
}

export function utcDate(iso: string | null): string {
  const at = valid(iso);
  return at ? at.toISOString().slice(0, 10) : 'unknown';
}

/** How long a run took, in the same units an operator reads in a log line. */
export function durationWords(fromIso: string | null, toIso: string | null): string {
  const from = valid(fromIso);
  const to = valid(toIso);
  if (!from || !to) return 'unknown';

  const seconds = (to.getTime() - from.getTime()) / 1000;
  if (seconds < 0) return 'unknown';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function elapsedSeconds(fromIso: string | null, now: Date): number {
  const from = valid(fromIso);
  if (!from) return 0;
  return Math.max(0, Math.round((now.getTime() - from.getTime()) / 1000));
}

export function triggerWords(trigger: Trigger): string {
  return trigger === 'scheduled' ? 'Cloud Scheduler' : 'the dashboard';
}

/**
 * What a row says when the agent wrote no brief. The heaviest factor is the honest short answer to
 * "why is this here", and it is the same string the score breakdown shows, so the two agree.
 */
export function topFactorSentence(score: Score): string {
  const heaviest = [...score.factors].sort((left, right) => right.points - left.points)[0];
  if (!heaviest || heaviest.points === 0) return 'No factor scored above zero.';
  const evidence = splitEvidence(heaviest.evidence);
  const tail = `${evidence.before}${evidence.label}${evidence.after}`.trim();
  return tail.length > 0 ? `${heaviest.label}, ${tail}` : heaviest.label;
}

const ACTION_NOUN: Record<ActionKind, string> = {
  'pull-request': 'Pull request',
  issue: 'Issue',
  'hold-issue': 'Hold issue',
  'comment-on-bot-pull-request': 'Comment on',
};

/** Short enough to scan down a column. The full sentence lives in the audit log, which has room. */
export function actionLabel(action: ActionRecord): string {
  if (action.outcome === 'dry-run') return 'Dry run, no write access';
  if (action.outcome === 'skipped') return 'Carried to the next run';
  if (action.outcome === 'failed') return 'Action failed';
  if (action.number === null) return ACTION_NOUN[action.kind];
  return `${ACTION_NOUN[action.kind]} #${action.number}`;
}

/**
 * The only schemes a link on a page may carry. Every href that is not a literal arrives from
 * outside: a GitHub API response, a deps.dev advisory, or the agent's own answer about release
 * notes a stranger wrote and can therefore aim. JSX escapes an attribute's characters without
 * judging its scheme, so `javascript:` in any one of those fields would be a script this page runs
 * on a click. Anything that is not http, https or one of this site's own paths loses its link and
 * is shown as text, because dropping the evidence would hide what the agent actually said.
 */
const LINKABLE = new Set(['http:', 'https:']);

export function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  // A single leading slash is a path this repository built. `//host` is a protocol-relative url,
  // and `/\host` is the same thing spelled the way a browser normalises rather than the way a
  // reader parses: both are somebody else's host wearing one of our paths.
  if (value.startsWith('/')) {
    return value[1] === '/' || value[1] === '\\' ? null : value;
  }

  try {
    return LINKABLE.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

const URL_IN_TEXT = /https?:\/\/\S+/;

export interface EvidenceParts {
  before: string;
  href: string | null;
  label: string;
  after: string;
}

/**
 * A factor's evidence often IS a url, and the rubric promises every factor links to its source. A
 * raw url printed in a table cell is also the one string wide enough to push the points column off
 * the card, so the link keeps the address and shows only the host.
 */
export function splitEvidence(evidence: string): EvidenceParts {
  const match = URL_IN_TEXT.exec(evidence);
  if (!match) return { before: evidence, href: null, label: '', after: '' };

  const found = match[0];
  let label: string;
  try {
    label = new URL(found).hostname.replace(/^www\./, '');
  } catch {
    // A malformed url is still evidence: show it as text rather than dropping the whole factor.
    return { before: evidence, href: null, label: '', after: '' };
  }

  return {
    before: evidence.slice(0, match.index),
    href: found,
    label,
    after: evidence.slice(match.index + found.length),
  };
}

function sentence(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ''}${text.slice(1)}`;
}

export interface FeedRow {
  id: string;
  at: string;
  title: string;
  titleHref: string | null;
  detail: string;
  detailHref: string | null;
  chip: string;
}

function actionRow(action: ActionRecord): FeedRow {
  return {
    id: action.id,
    at: action.at,
    title: action.bumpTitle,
    titleHref: bumpPath(action.repositoryId, action.bumpKey),
    detail: sentence(action.detail),
    detailHref: action.url,
    chip: action.ruleId,
  };
}

function runRows(run: RunRecord): FeedRow[] {
  const scope = run.scope ?? 'all watched repositories';
  const rows: FeedRow[] = [
    {
      id: `${run.id}|start`,
      at: run.startedAt,
      title: scope,
      titleHref: null,
      detail: `Run started, triggered by ${triggerWords(run.trigger)}`,
      detailHref: null,
      chip: 'RUN-START',
    },
  ];

  if (run.status === 'running' || !run.finishedAt) return rows;

  const scored = totalBumps(run.counts);
  const acted = run.actionsTaken === 0 ? 'no action needed' : `${run.actionsTaken} acted on`;
  rows.push({
    id: `${run.id}|end`,
    at: run.finishedAt,
    title: scope,
    titleHref: null,
    detail:
      run.status === 'failed'
        ? `Run failed. ${run.error ?? 'no reason recorded'}`
        : `Run finished in ${durationWords(run.startedAt, run.finishedAt)}. ${scored} scored, ${acted}`,
    detailHref: null,
    chip: run.status === 'failed' ? 'RUN-FAILED' : 'RUN-END',
  });
  return rows;
}

/**
 * One stream, newest first, of what the agent did and of the runs themselves. A run that changed
 * nothing still writes its two lines, so a quiet day and a dead scheduler never look alike, which
 * is the whole point of publishing this page.
 */
export function auditFeed(runs: RunRecord[], actions: ActionRecord[], limit: number): FeedRow[] {
  const rows = [...actions.map(actionRow), ...runs.flatMap(runRows)];
  return rows.sort((left, right) => right.at.localeCompare(left.at)).slice(0, limit);
}
