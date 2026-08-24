import type { JSX } from 'hono/jsx/jsx-runtime';
import type { MissingSource } from '../../core/types.js';

export interface StateProps {
  heading: string;
  lines: string[];
  action?: { label: string; href: string };
  /**
   * 1 when this panel IS the page, which is the whole of a 404 and of an empty home. A page whose
   * only heading is an h2 leaves a screen reader with no top-level heading to jump to.
   */
  level?: 1 | 2;
}

/**
 * One shape for every state that is not a full page of data: nothing watched yet, an empty queue,
 * a page that does not exist, a request that failed. Each says what happened and what to do next,
 * because a blank panel and a broken page look identical to the person reading them.
 */
export function StatePanel(props: StateProps): JSX.Element {
  return (
    <section class="state">
      {props.level === 1 ? <h1>{props.heading}</h1> : <h2>{props.heading}</h2>}
      {props.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {props.action ? (
        <p>
          <a class="plain" href={props.action.href}>
            {props.action.label}
          </a>
        </p>
      ) : null}
    </section>
  );
}

/**
 * A source the run could not read. It is shown rather than swallowed: the rubric scores a missing
 * changelog as a risk, so hiding the gap would hide part of the score's reason.
 */
export function MissingSources(props: { missing: MissingSource[] }): JSX.Element | null {
  if (props.missing.length === 0) return null;

  return (
    <div class="card">
      <p class="kick">What could not be read</p>
      <div class="missing">
        {props.missing.map((source) => (
          <div key={`${source.what}|${source.why}`}>
            <b>{source.what}</b>: {source.why}
          </div>
        ))}
      </div>
    </div>
  );
}
