import type { JSX } from 'hono/jsx/jsx-runtime';
import {
  LOCKFILE_POLICY,
  PER_RUN_BUDGETS,
  POLICY_RULES,
  POLICY_VERSION,
  RUN_TIME_BUDGET_SECONDS,
} from '../../core/policy.js';
import { BAND_RANGES, PUBLISHED_RUBRIC, RUBRIC_VERSION } from '../../core/rubric.js';
import {
  BRIEFS_IN_FLIGHT,
  FREE_TIER_REQUESTS_PER_DAY,
  FREE_TIER_REQUESTS_PER_MINUTE,
} from '../../core/stack.js';
import type { Band } from '../../core/types.js';
import { WORD_COLOR, verdictWord } from '../view-model.js';

const BANDS: Band[] = ['green', 'amber', 'red'];

function RubricRows(): JSX.Element[] {
  return PUBLISHED_RUBRIC.map((factor) => (
    <div key={factor.description} class="rub" role="row">
      <span role="cell">{factor.description}</span>
      <span class="s" role="cell">
        {factor.source}
      </span>
      <span class={factor.points === 0 ? 'p zero' : 'p'} role="cell">
        {factor.points}
      </span>
    </div>
  ));
}

function BandCards(): JSX.Element {
  return (
    <div class="bands">
      {BANDS.map((band) => (
        <div key={band} class="bandcard">
          <span class="rng">{BAND_RANGES[band]}</span>
          <h2 style={`color:${WORD_COLOR[band]}`}>{verdictWord(band)}</h2>
          <p>{POLICY_RULES[band].summary}</p>
          <span class="rule-id">{POLICY_RULES[band].id}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The page the whole product rests on: the verdict is arithmetic a reader can check, and the two
 * limits below are the ones a reader would otherwise discover only by being surprised, so they are
 * published rather than buried in a run log.
 */
export function PolicyPage(): JSX.Element {
  return (
    <>
      <section class="band">
        <h1>The rubric, in force and unedited.</h1>
        <p class="lede">
          Every point below is awarded by code, from a source with a link. The model never adds,
          removes or reweights a factor. When the rubric changes it gets a new version number, and
          old scores keep the version they were computed under. Rubric v{RUBRIC_VERSION}, policy v
          {POLICY_VERSION}.
        </p>
      </section>

      {/* A div, not a section: ARIA does not allow the table role on a sectioning element. */}
      <div class="list" role="table" aria-label="Scoring rubric">
        <div class="lh" role="row" style="grid-template-columns:1fr 190px 66px">
          <span role="columnheader">Factor</span>
          <span role="columnheader">Source</span>
          <span role="columnheader">Points</span>
        </div>
        {RubricRows()}
      </div>

      <section class="wrap" style="margin-top:-30px">
        <p class="panel-h">The action per band</p>
        <BandCards />

        <p class="panel-h" style="margin-top:34px">
          Standing rules
        </p>
        <div class="bands">
          <div class="card">
            <h3>bumpwarden never merges</h3>
            <p style="margin-bottom:0">
              Autonomy stops at the merge button by design. The agent opens, updates, labels and
              explains. A person presses merge. There is no configuration flag that changes this,
              because a flag that can be turned on is a promise that can be broken.
            </p>
          </div>

          <div class="card">
            <h3>At most {PER_RUN_BUDGETS.actions} actions in a run</h3>
            <p>
              Bumps are acted on riskiest first, and once {PER_RUN_BUDGETS.actions} have landed the
              rest are carried to the next run rather than dropped. Each one that waits is recorded
              in the audit log saying so, so nothing goes quiet.
            </p>
            <p>
              A first run over a long neglected repository would otherwise open dozens of issues at
              once, which is how a useful bot becomes one a maintainer blocks. The same run writes
              at most {PER_RUN_BUDGETS.briefs} briefs, and stops asking for them after{' '}
              {RUN_TIME_BUDGET_SECONDS / 60} minutes so a slow answer upstream cannot push a run
              past its deadline. A bump that misses out is still scored and still acted on, and its
              page says which limit it met.
            </p>
            <p style="margin-bottom:0">
              Briefs also go out at the model's pace, {BRIEFS_IN_FLIGHT} at a time. The free tier
              answers {FREE_TIER_REQUESTS_PER_MINUTE} requests a minute and about{' '}
              {FREE_TIER_REQUESTS_PER_DAY} a day, and a brief costs two, so a long queue waits its
              turn rather than collecting refusals, and a bump the day has no room for keeps its
              score and gets its brief on a later run. A ready brief is kept, so a repeat run over
              the same bumps asks the model for nothing.
            </p>
          </div>

          <div class="card">
            <h3>A pull request edits package.json only</h3>
            <p>
              When a clear bump earns a pull request, bumpwarden changes the version range in
              package.json and nothing else. {LOCKFILE_POLICY}
            </p>
            <p style="margin-bottom:0">
              The pull request says so in its own body and asks you to run your installer on the
              branch before merging, so the lockfile is regenerated by the tool that owns it.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
