import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  totalBumps,
  type BandCounts,
  type BumpRecord,
  type ProjectSummary,
  type RunRecord,
} from '../../core/records.js';
import { bumpPath, projectPath } from '../../core/routes.js';
import type { Band, MissingSource } from '../../core/types.js';
import type { RunNowStatus } from '../run-now.js';
import {
  WORD_COLOR,
  actionLabel,
  durationWords,
  queueSentence,
  topFactorSentence,
  utcTime,
  verdictWord,
} from '../view-model.js';
import { ScoreMark, Spread } from './marks.js';
import { MissingSources, StatePanel } from './states.js';

export interface QueueProps {
  project: ProjectSummary;
  /** Counted from the bumps on this page rather than from the run tally, so a filter never lies. */
  counts: BandCounts;
  lastRun: RunRecord | null;
  bumps: BumpRecord[];
  /** Every bump in the project, whatever the filter, so the spread and the counts stay honest. */
  all: BumpRecord[];
  band: Band | null;
  runNow: RunNowStatus;
  missing: MissingSource[];
}

const BANDS: Band[] = ['green', 'amber', 'red'];

function filterHref(repositoryId: string, band: Band | null): string {
  return band ? `${projectPath(repositoryId)}?verdict=${band}` : projectPath(repositoryId);
}

function Filters(props: {
  repositoryId: string;
  counts: BandCounts;
  active: Band | null;
}): JSX.Element {
  return (
    <nav class="filters" aria-label="Filter the queue by verdict">
      <a
        href={filterHref(props.repositoryId, null)}
        {...(props.active === null ? { 'aria-current': 'page' } : {})}
      >
        All <b>{totalBumps(props.counts)}</b>
      </a>
      {BANDS.map((band) => (
        <a
          key={band}
          href={filterHref(props.repositoryId, band)}
          style={`color:${WORD_COLOR[band]}`}
          {...(props.active === band ? { 'aria-current': 'page' } : {})}
        >
          {verdictWord(band)} <b>{props.counts[band]}</b>
        </a>
      ))}
    </nav>
  );
}

/**
 * The button posts a form, so it works with no JavaScript at all: the request simply holds until
 * the run finishes and the page comes back with the result. Where scripting is available,
 * run-now.js takes the same form over and polls the status endpoint instead of blocking on it.
 */
function RunNow(props: { project: ProjectSummary; status: RunNowStatus }): JSX.Element | null {
  if (props.status.state === 'unavailable') return null;
  const busy = props.status.state !== 'ready';

  return (
    <form
      class="run"
      method="post"
      action={`${projectPath(props.project.repository.id)}/run`}
      data-run-now={props.project.repository.id}
    >
      <button class="btn" type="submit" {...(busy ? { disabled: true } : {})}>
        Run now
      </button>
      <p class="status" data-run-status role="status">
        {props.status.message}
      </p>
    </form>
  );
}

function QueueRow(props: { bump: BumpRecord; index: number }): JSX.Element {
  const { bump } = props;
  const action = bump.action;

  return (
    <div class="r">
      <span class="nm">
        <a class="stretch" href={bumpPath(bump.repositoryId, bump.key)}>
          {bump.dependency}
        </a>
      </span>
      <span class="mv">
        <b>{bump.currentVersion}</b> &#8594; <b>{bump.candidateVersion}</b>
      </span>
      <span class="wy">
        {bump.brief.content?.headline ?? topFactorSentence(bump.score)}
        <br />
        {action?.url ? (
          <a class="out" href={action.url} rel="noreferrer">
            {actionLabel(action)}
          </a>
        ) : (
          <span class="none">{action ? actionLabel(action) : 'No action recorded'}</span>
        )}
      </span>
      <ScoreMark total={bump.score.total} band={bump.score.band} index={props.index} />
    </div>
  );
}

export function QueuePage(props: QueueProps): JSX.Element {
  const { project, lastRun } = props;
  const ran = lastRun
    ? `last run ${utcTime(lastRun.startedAt)} UTC in ${durationWords(lastRun.startedAt, lastRun.finishedAt)}`
    : 'no run yet';

  return (
    <>
      <section class="band">
        <p class="crumb">
          {project.repository.id} &#183; {project.repository.ref} &#183; {ran}
        </p>
        <h1>{headline(props)}</h1>
        <p class="lede">
          The score is arithmetic from a published rubric, not an opinion. The model reads the
          release notes and explains what breaks in your code. It never moves the number and it
          never merges.
        </p>
        <RunNow project={project} status={props.runNow} />
      </section>

      {props.all.length > 0 ? (
        <Spread
          heading="This run, placed on the rubric"
          note="Every pending bump on the same 0 to 100 axis, so the shape of the run is visible before you read a single row."
          pins={props.all.map((bump) => ({
            label: bump.dependency,
            total: bump.score.total,
            band: bump.score.band,
          }))}
        />
      ) : null}

      {props.all.length > 0 ? (
        <Filters repositoryId={project.repository.id} counts={props.counts} active={props.band} />
      ) : null}

      {props.bumps.length === 0 ? (
        <StatePanel
          heading={props.all.length === 0 ? 'Nothing scored here yet.' : 'No bump in that band.'}
          lines={
            props.all.length === 0
              ? [
                  'The queue fills the first time a run reads this repository. A run reads the manifest, resolves every candidate version, scores each one, and writes what it found here.',
                  'Nothing is hidden while that happens: a source that could not be read is recorded as missing and scored as missing.',
                ]
              : [`This project has ${queueSentence(props.counts)}. Clear the filter to see them.`]
          }
          action={
            props.all.length === 0
              ? { label: 'Read the published rubric', href: '/rubric' }
              : { label: 'Show every bump', href: projectPath(project.repository.id) }
          }
        />
      ) : (
        <section class="list" aria-label="Pending bumps">
          <div class="lh" aria-hidden="true">
            <span>Dependency</span>
            <span>Move</span>
            <span>Why, and what was done</span>
            <span>Score</span>
          </div>
          {props.bumps.map((bump, index) => (
            <QueueRow key={bump.key} bump={bump} index={index} />
          ))}
        </section>
      )}

      {props.missing.length > 0 ? (
        <section class="wrap">
          <MissingSources missing={props.missing} />
        </section>
      ) : null}
    </>
  );
}

function headline(props: QueueProps): string {
  const total = props.all.length;
  if (total === 0) return `Nothing pending on ${props.project.repository.repo}.`;
  return `${total} ${total === 1 ? 'bump' : 'bumps'}, scored on one scale you can read.`;
}
