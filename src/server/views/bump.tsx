import type { JSX } from 'hono/jsx/jsx-runtime';
import type { BriefRecord } from '../../core/brief.js';
import { ruleFor } from '../../core/policy.js';
import type { ActionRecord, BumpRecord } from '../../core/records.js';
import { projectPath } from '../../core/routes.js';
import { utcStamp, utcTime, verdictWord } from '../view-model.js';
import { FactorRows, Spread } from './marks.js';

export interface BumpProps {
  bump: BumpRecord;
  /** A few other bumps from the same run, so the reading has a scale around it. */
  context: BumpRecord[];
  actions: ActionRecord[];
}

/** Enough neighbours to give the axis meaning without turning the detail page into the queue. */
const CONTEXT_PINS = 4;

function Claims(props: { brief: BriefRecord }): JSX.Element | null {
  const claims = props.brief.content?.breaksHere ?? [];
  if (claims.length === 0) return null;

  return (
    <>
      {claims.map((claim) => (
        <div key={`${claim.path}:${claim.line}:${claim.symbol}`} class="claim">
          <p class="c1">
            <code>
              {claim.path}:{claim.line}
            </code>{' '}
            uses <code>{claim.symbol}</code>
            {claim.verified ? null : (
              <span class="flag"> (unverified: no matching call site was found)</span>
            )}
          </p>
          <p class="c2">
            {`"${claim.quote}"`}{' '}
            <a class="src" href={claim.source} rel="noreferrer">
              {claim.source}
            </a>
          </p>
        </div>
      ))}
    </>
  );
}

function Provenance(props: { brief: BriefRecord }): JSX.Element {
  const { brief } = props;
  const content = brief.content;
  const verified = (content?.breaksHere ?? []).filter((claim) => claim.verified).length;
  const dropped =
    brief.droppedClaims === 0
      ? 'none dropped'
      : `${brief.droppedClaims} dropped as unquotable from the material`;

  return (
    <p class="c2" style="margin-top:18px">
      Confidence {content?.confidence ?? 'unknown'}. Model {brief.model}. {verified} of{' '}
      {content?.breaksHere.length ?? 0} claims matched a call site the mechanical matcher also
      found, {dropped}.
      {brief.truncated ? ' Some inputs were truncated to fit the token budget.' : ''}
    </p>
  );
}

function Brief(props: { brief: BriefRecord }): JSX.Element {
  const content = props.brief.content;

  if (props.brief.status !== 'ready' || !content) {
    return (
      <div class="card">
        <p class="kick">Machine explanation, not verdict</p>
        <h3>Brief unavailable</h3>
        <p>
          The agent did not return an explanation that passed validation:{' '}
          {props.brief.reason ?? 'no reason was recorded'}. Nothing was invented in its place.
        </p>
        <p style="margin-bottom:0">
          The verdict on the right stands on its own. It is arithmetic over the rubric and never
          depended on the model.
        </p>
      </div>
    );
  }

  return (
    <div class="card">
      <p class="kick">Machine explanation, not verdict</p>
      <h3>{content.headline}</h3>
      <p>{content.whatChanged}</p>

      {content.breakingChanges.length > 0 ? (
        <ul class="steps">
          {content.breakingChanges.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      <Claims brief={props.brief} />

      {content.migrationSteps.length > 0 ? (
        <>
          <p class="kick" style="margin-top:20px">
            Migration
          </p>
          <ol class="steps">
            {content.migrationSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      ) : null}

      <Provenance brief={props.brief} />
    </div>
  );
}

function ActionLog(props: { bump: BumpRecord; actions: ActionRecord[] }): JSX.Element {
  const rule = ruleFor(props.bump.score.band);

  return (
    <div class="card" style="margin-top:20px">
      <p class="kick">What was done</p>
      <div class="fall">
        {props.actions.map((action) => (
          <div key={action.id} class="f" style="grid-template-columns:1fr auto">
            <span>
              {action.url ? (
                <a class="plain" href={action.url} rel="noreferrer">
                  {action.detail}
                </a>
              ) : (
                action.detail
              )}
            </span>
            <b>{utcTime(action.at)}</b>
          </div>
        ))}
        <div class="f z" style="grid-template-columns:1fr auto">
          <span>
            Scored {props.bump.score.total}, rubric v{props.bump.score.rubricVersion}
          </span>
          <b>{utcTime(props.bump.updatedAt)}</b>
        </div>
      </div>
      <p style="margin-top:14px;font-size:13.5px">
        Rule <span class="chip">{rule.id}</span> {rule.summary}
      </p>
    </div>
  );
}

export function BumpPage(props: BumpProps): JSX.Element {
  const { bump } = props;
  const pins = [bump, ...props.context.filter((other) => other.key !== bump.key)]
    .slice(0, CONTEXT_PINS + 1)
    .map((entry) => ({
      label: `${entry.dependency} ${entry.score.total}`,
      total: entry.score.total,
      band: entry.score.band,
    }));

  return (
    <>
      <section class="band">
        <p class="crumb">
          <a class="plain" href={projectPath(bump.repositoryId)}>
            {bump.repositoryId}
          </a>{' '}
          / {bump.dependency}
        </p>
        <h1>
          {bump.dependency} {bump.currentVersion} to {bump.candidateVersion}
        </h1>
        <p class="lede">
          Scored {bump.score.total} of 100, which is {verdictWord(bump.score.band).toLowerCase()}.
          Every factor below is computed from a source you can open, and the sum decides the band.
          Nothing here is a judgement call.
        </p>
      </section>

      <Spread
        heading="Where this sits"
        note="The same axis as the queue, so this bump's place in the run is legible."
        pins={pins}
      />

      <section class="foot" style="margin-top:26px">
        <div>
          <Brief brief={bump.brief} />
          <div class="card" style="margin-top:20px">
            <p class="kick">Provenance</p>
            <dl class="facts">
              <dt>Run</dt>
              <dd>{bump.runId}</dd>
              <dt>First seen</dt>
              <dd>{utcStamp(bump.firstSeenAt)} UTC</dd>
              <dt>Last scored</dt>
              <dd>{utcStamp(bump.updatedAt)} UTC</dd>
              <dt>Rubric</dt>
              <dd>v{bump.score.rubricVersion}</dd>
              <dt>Bump key</dt>
              <dd>{bump.key}</dd>
            </dl>
          </div>
        </div>
        <div>
          <div class="card">
            <p class="kick">How {bump.score.total} was reached</p>
            <FactorRows factors={bump.score.factors} />
            <div class="total">
              <span>Total</span>
              <span>{bump.score.total}</span>
            </div>
          </div>

          <ActionLog bump={bump} actions={props.actions} />
        </div>
      </section>
    </>
  );
}
