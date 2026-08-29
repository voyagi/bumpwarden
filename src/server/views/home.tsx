import type { JSX } from 'hono/jsx/jsx-runtime';
import { PER_RUN_BUDGETS } from '../../core/policy.js';
import {
  totalBumps,
  worstBand,
  type ActionRecord,
  type BandCounts,
  type ProjectSummary,
} from '../../core/records.js';
import { projectPath } from '../../core/routes.js';
import { BAND_RANGES, MAX_SCORE, PUBLISHED_RUBRIC } from '../../core/rubric.js';
import { MARK_COLOR, queueSentence, trackWidth, utcTime } from '../view-model.js';
import { ScoreMark } from './marks.js';
import { StatePanel } from './states.js';

export interface HomeProps {
  projects: ProjectSummary[];
  actions: ActionRecord[];
  totals: BandCounts;
}

/**
 * Generates the headline text for the home page based on project count and bump status.
 */
export function homeHeadline(projects: number, counts: BandCounts): string {
  const watched = `${projects} ${projects === 1 ? 'repository' : 'repositories'} watched.`;
  if (counts.red === 0) {
    return totalBumps(counts) === 0 ? `${watched} Nothing pending.` : `${watched} Nothing held.`;
  }
  return `${watched} ${counts.red} ${counts.red === 1 ? 'bump' : 'bumps'} held.`;
}

function ProjectRow(props: { project: ProjectSummary; index: number }): JSX.Element {
  const { project } = props;
  const acted = `${project.actions} ${project.actions === 1 ? 'action' : 'actions'}`;

  return (
    <div class="r">
      <span class="nm">
        <a class="stretch" href={projectPath(project.repository.id)}>
          {project.repository.repo}
        </a>
      </span>
      <span class="mv">
        {project.lastRunAt ? (
          <>
            <b>{utcTime(project.lastRunAt)}</b> UTC &#183; {acted}
          </>
        ) : (
          'no run yet'
        )}
      </span>
      <span class="wy">{queueSentence(project.counts)}</span>
      {totalBumps(project.counts) === 0 ? (
        // A zero drawn on the ramp reads as a score of zero, which is a very different claim from
        // a repository that has nothing pending to place on the scale at all.
        <span class="g idle">nothing to place</span>
      ) : (
        <ScoreMark
          total={project.worstScore}
          band={worstBand(project.counts)}
          index={props.index}
          word="Worst"
        />
      )}
    </div>
  );
}

function LatestActions(props: { actions: ActionRecord[] }): JSX.Element {
  if (props.actions.length === 0) {
    return (
      <div class="card">
        <p class="kick">Latest actions</p>
        <p>
          Nothing has been opened yet. The first scheduled run writes here, and every entry names
          the rule that fired it.
        </p>
      </div>
    );
  }

  return (
    <div class="card">
      <p class="kick">Latest actions</p>
      <div class="fall">
        {props.actions.map((action, index) => (
          <div key={action.id} class={action.score > 0 ? 'f' : 'f z'}>
            <span>
              <span class="lead">{action.bumpTitle}</span> &#183;{' '}
              {action.detail.charAt(0).toUpperCase() + action.detail.slice(1)}
            </span>
            <b>{action.score}</b>
            <i
              style={`width:${trackWidth(action.score)};background:${MARK_COLOR[action.band]};animation-delay:${index * 18}ms`}
            />
          </div>
        ))}
      </div>
      <p style="margin-top:16px">
        <a class="plain" href="/audit">
          Read the full audit log
        </a>
      </p>
    </div>
  );
}

/**
 * Home answers the one question an operator opens the dashboard with: is anything waiting for me.
 * The count comes first, in words, then one row per repository carrying its own worst reading on
 * the same scale every other page uses.
 */
export function HomePage(props: HomeProps): JSX.Element {
  if (props.projects.length === 0) {
    return (
      <StatePanel
        level={1}
        heading="No repository is being watched yet."
        lines={[
          'bumpwarden reads a watch list from its store. Add a repository and the next scheduled run picks it up, or set DEMO_REPO before the service boots and it arrives already watching that one.',
          'Everything else on this instance works without it: the rubric and the action policy are published whether or not a run has ever happened.',
        ]}
        action={{ label: 'Read the published rubric', href: '/rubric' }}
      />
    );
  }

  return (
    <>
      <section class="band">
        <h1>{homeHeadline(props.projects.length, props.totals)}</h1>
        <p class="lede">
          bumpwarden reads what each of your dependencies released, scores the risk of taking it
          with a published rubric, and acts on GitHub. It explains itself and it never merges.
        </p>
      </section>

      <section class="list" aria-label="Watched repositories">
        <div class="lh" aria-hidden="true">
          <span>Repository</span>
          <span>Last run</span>
          <span>Pending</span>
          <span>Spread</span>
        </div>
        {props.projects.map((project, index) => (
          <ProjectRow key={project.repository.id} project={project} index={index} />
        ))}
      </section>

      <section class="foot">
        <LatestActions actions={props.actions} />
        <div class="card">
          <p class="kick">How it decides</p>
          <p>
            {PUBLISHED_RUBRIC.length} factors, each computed from a source you can open, summed and
            capped at {MAX_SCORE}. The band decides the action: a pull request at{' '}
            {BAND_RANGES.green}, an issue at {BAND_RANGES.amber}, a hold at {BAND_RANGES.red}, and
            at most {PER_RUN_BUDGETS.actions} actions in one run.
          </p>
          <p>
            The model reads the release notes and explains what breaks in your code. It never moves
            the number, holds no GitHub tool, and cannot reach the part that writes.
          </p>
          <p>
            <a class="plain" href="/rubric">
              Read the published rubric
            </a>
          </p>
        </div>
      </section>
    </>
  );
}
