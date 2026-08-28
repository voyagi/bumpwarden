import type { RunRecord, WatchedRepository } from '../core/records.js';
import { durationWords, elapsedSeconds, utcStamp } from './view-model.js';

/**
 * Long enough that a visitor cannot queue a second run behind one still finishing, short enough
 * that a judge who wants to watch it twice is not locked out for the afternoon. A run over the demo
 * repository takes about two minutes.
 */
export const RUN_NOW_COOLDOWN_MS = 5 * 60_000;

/** How far back the state looks. Runs are newest first, so this only has to cover one cooldown. */
export const RUN_LOOKBACK = 20;

export type RunNowState = 'ready' | 'running' | 'cooling' | 'unavailable';

export interface RunNowStatus {
  state: RunNowState;
  /** One plain sentence, printed next to the button and returned from the poll endpoint. */
  message: string;
  runId: string | null;
  elapsedSeconds: number;
  retryAfterSeconds: number;
}

/**
 * A timestamp that does not parse leaves the arithmetic as NaN, and every comparison against NaN
 * is false, so the wait would read as zero and the cooldown would simply not exist. The whole
 * cooldown is charged instead: a stored run record this service cannot read is a reason to hold
 * the button, not to open it.
 */
function secondsUntil(finishedAt: string, now: Date): number {
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(finished)) return RUN_NOW_COOLDOWN_MS / 1000;

  const ready = finished + RUN_NOW_COOLDOWN_MS;
  return Math.max(0, Math.ceil((ready - now.getTime()) / 1000));
}

function waitWords(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A run with no scope covers the whole watch list, so it is busy for every project in it. */
function activeRun(runs: RunRecord[], repositoryId: string): RunRecord | undefined {
  return runs.find(
    (run) => run.status === 'running' && (run.scope === null || run.scope === repositoryId),
  );
}

/**
 * A run that stepped over this repository because another run held it never read it, so it cannot
 * date the project. A repository that was read and failed still counts: something looked, and the
 * failure is the run's own to report.
 */
function lastFinished(runs: RunRecord[], repositoryId: string): RunRecord | undefined {
  return runs.find(
    (run) =>
      run.finishedAt !== null &&
      (run.scope === repositoryId ||
        run.repositories.some(
          (result) => result.repositoryId === repositoryId && result.skipped !== true,
        )),
  );
}

function finishedSentence(run: RunRecord | undefined): string {
  if (!run || !run.finishedAt) return 'No run has covered this project yet.';
  return `Last run finished ${utcStamp(run.finishedAt)} UTC in ${durationWords(run.startedAt, run.finishedAt)}.`;
}

/**
 * Pure over the run history, so the button's three states are provable without a clock or a store.
 * The cooldown is keyed on the project rather than on the visitor: this instance has no accounts,
 * and an IP is personal data bumpwarden has no reason to hold.
 */
export function runNowStatus(
  repository: WatchedRepository | null,
  runs: RunRecord[],
  now: Date,
): RunNowStatus {
  const base = { runId: null, elapsedSeconds: 0, retryAfterSeconds: 0 };

  if (!repository || !repository.demo) {
    return {
      ...base,
      state: 'unavailable',
      message: 'Run now is enabled on the demo project only. Every other project runs on schedule.',
    };
  }

  const active = activeRun(runs, repository.id);
  if (active) {
    return {
      ...base,
      state: 'running',
      runId: active.id,
      elapsedSeconds: elapsedSeconds(active.startedAt, now),
      message: `Running since ${utcStamp(active.startedAt)} UTC.`,
    };
  }

  const previous = lastFinished(runs, repository.id);
  const manual = runs.find(
    (run) => run.trigger === 'manual' && run.scope === repository.id && run.finishedAt !== null,
  );
  const wait = manual?.finishedAt ? secondsUntil(manual.finishedAt, now) : 0;

  if (wait > 0) {
    return {
      ...base,
      state: 'cooling',
      runId: manual?.id ?? null,
      retryAfterSeconds: wait,
      message: `${finishedSentence(previous)} Run now is available again in ${waitWords(wait)}.`,
    };
  }

  return { ...base, state: 'ready', message: finishedSentence(previous) };
}

/** What a refused POST answers with. Matching the state to a status code keeps the two honest. */
export const REFUSAL_STATUS = {
  unavailable: 403,
  running: 409,
  cooling: 429,
} as const;
