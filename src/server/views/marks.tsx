import type { JSX } from 'hono/jsx/jsx-runtime';
import type { Band, ScoredFactor } from '../../core/types.js';
import {
  MARK_COLOR,
  THRESHOLD_MARKS,
  WORD_COLOR,
  factorWidth,
  placePins,
  splitEvidence,
  trackWidth,
  verdictWord,
} from '../view-model.js';
import { Linked } from './link.js';

/** Marks arrive one after another rather than all at once, at the art direction's 18ms step. */
const STAGGER_MS = 18;

function delay(index: number): string {
  return `animation-delay:${index * STAGGER_MS}ms`;
}

function thresholdTicks(): JSX.Element[] {
  return THRESHOLD_MARKS.map((mark) => <u key={mark} style={`left:${mark}%`} />);
}

export interface ScoreMarkProps {
  total: number;
  band: Band;
  index?: number;
  /** Home labels the mark "Worst" because the row is a repository, not one bump. */
  word?: string;
}

/**
 * The same measurement the spread shows for the whole run, one row at a time: the numeral, the
 * position on the shared scale, the two band thresholds, and the word for where it landed.
 */
export function ScoreMark(props: ScoreMarkProps): JSX.Element {
  const index = props.index ?? 0;
  return (
    <span class="g">
      <span class="n">
        <span class="sr-only">scored </span>
        {props.total}
        <span class="sr-only"> of 100,</span>
      </span>
      <span class="t">
        <i
          style={`width:${trackWidth(props.total)};background:${MARK_COLOR[props.band]};${delay(index)}`}
        />
        {thresholdTicks()}
      </span>
      <span class="w" style={`color:${WORD_COLOR[props.band]}`}>
        {props.word ?? verdictWord(props.band)}
      </span>
    </span>
  );
}

export interface Pin {
  label: string;
  total: number;
  band: Band;
}

export interface SpreadProps {
  heading: string;
  note: string;
  pins: Pin[];
}

/**
 * Every pending bump on one 0 to 100 axis. The shape of the run is legible before a single row is
 * read, and the axis scrolls sideways on a narrow screen rather than being dropped, because a
 * measurement squashed until its labels collide has stopped being a measurement.
 */
export function Spread(props: SpreadProps): JSX.Element {
  const placed = placePins(props.pins);

  return (
    <section class="spread">
      <h2>{props.heading}</h2>
      <p class="note">{props.note}</p>
      <div class="axis-scroll">
        <div class="axis">
          <div class="track" />
          {THRESHOLD_MARKS.map((mark) => (
            <div key={mark} class="thr" style={`left:${mark}%`}>
              <span>{mark}</span>
            </div>
          ))}
          {placed.map(({ pin, lane, labelled }, index) => (
            <div
              key={`${pin.label}-${pin.total}`}
              class={`pin ${lane}`}
              style={`left:${pin.total}%`}
              title={`${pin.label}, scored ${pin.total}`}
            >
              <i style={`background:${MARK_COLOR[pin.band]};${delay(index)}`} />
              <b class={labelled ? undefined : 'sr-only'}>{pin.label}</b>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Evidence(props: { evidence: string }): JSX.Element {
  const parts = splitEvidence(props.evidence);
  return (
    <>
      {', '}
      {parts.before}
      {parts.href ? <Linked href={parts.href} label={parts.label} /> : null}
      {parts.after}
    </>
  );
}

/**
 * The arithmetic, shown so a reader can add the column up. A factor that scored nothing stays on
 * the page greyed at zero rather than disappearing: knowing a factor was checked and found nothing
 * is the difference between a published rubric and a number.
 */
export function FactorRows(props: { factors: ScoredFactor[] }): JSX.Element {
  return (
    <div class="fall">
      {props.factors.map((factor, index) => (
        <div key={factor.id} class={factor.points > 0 ? 'f' : 'f z'}>
          <span>
            {factor.label}
            {factor.evidence ? <Evidence evidence={factor.evidence} /> : null}
          </span>
          <b>{factor.points}</b>
          <i
            style={
              factor.points > 0
                ? `width:${factorWidth(factor.points)};background:var(--r3);${delay(index)}`
                : ''
            }
          />
        </div>
      ))}
    </div>
  );
}
