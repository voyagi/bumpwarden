import type { JSX } from 'hono/jsx/jsx-runtime';
import { utcStamp, type FeedRow } from '../view-model.js';
import { StatePanel } from './states.js';

export interface AuditProps {
  rows: FeedRow[];
}

function Row(props: { row: FeedRow }): JSX.Element {
  const { row } = props;

  return (
    <div class="reg" role="row">
      <span class="t" role="cell">
        {utcStamp(row.at)}
      </span>
      <span class="who" role="cell">
        {row.titleHref ? (
          <a class="plain" href={row.titleHref}>
            {row.title}
          </a>
        ) : (
          row.title
        )}
      </span>
      <span role="cell">
        {row.detailHref ? (
          <a class="plain" href={row.detailHref} rel="noreferrer">
            {row.detail}
          </a>
        ) : (
          row.detail
        )}
      </span>
      <span role="cell">
        <span class="chip">{row.chip}</span>
      </span>
    </div>
  );
}

/**
 * Actions and runs in one stream. A run that changed nothing still writes its own two lines, so a
 * quiet day and a scheduler that stopped firing never look alike, which is the only reason to
 * publish an audit log rather than a list of successes.
 */
export function AuditPage(props: AuditProps): JSX.Element {
  if (props.rows.length === 0) {
    return (
      <StatePanel
        level={1}
        heading="Nothing has happened yet."
        lines={[
          'Every run writes a line here when it starts and another when it finishes, and every issue, pull request or comment writes one of its own with the policy rule that fired it.',
          'An empty log means no run has completed, not that a run found nothing.',
        ]}
        action={{ label: 'Read the action policy', href: '/rubric' }}
      />
    );
  }

  return (
    <>
      <section class="band">
        <h1>Every action, and the rule that fired it.</h1>
        <p class="lede">
          One line per action, newest first, written only once the action succeeded. Lines marked
          RUN-START and RUN-END are the runs themselves rather than policy rules, so a run that
          changed nothing is still visible here.
        </p>
      </section>

      {/* A div, not a section: ARIA does not allow the table role on a sectioning element. */}
      <div class="list" role="table" aria-label="Audit log">
        <div class="lh" role="row" style="grid-template-columns:172px 190px 1fr 132px">
          <span role="columnheader">Time, UTC</span>
          <span role="columnheader">Bump</span>
          <span role="columnheader">Action</span>
          <span role="columnheader">Rule</span>
        </div>
        {props.rows.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </div>
    </>
  );
}
