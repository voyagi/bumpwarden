import { describe, expect, it } from 'vitest';
import { countBands, type ActionRecord } from '../core/records.js';
import { BAND_THRESHOLDS, MAX_SCORE, POINTS } from '../core/rubric.js';
import { actionRecord, runRecord, scoreOf } from '../testkit/fixtures.js';
import {
  MARK_COLOR,
  THRESHOLD_MARKS,
  WORD_COLOR,
  actionLabel,
  auditFeed,
  durationWords,
  elapsedSeconds,
  factorWidth,
  placePins,
  queueSentence,
  splitEvidence,
  topFactorSentence,
  trackWidth,
  utcStamp,
  utcTime,
  verdictWord,
} from './view-model.js';

describe('the colour law', () => {
  it('gives every band a mark colour and a word colour and never repeats across bands', () => {
    expect(new Set(Object.values(MARK_COLOR)).size).toBe(3);
    expect(new Set(Object.values(WORD_COLOR)).size).toBe(3);
  });

  it('marks the thresholds where the bands actually change', () => {
    expect(THRESHOLD_MARKS).toEqual([BAND_THRESHOLDS.greenMax, BAND_THRESHOLDS.amberMax + 1]);
  });

  it('names the bands the way the issue titles do', () => {
    expect(verdictWord('green')).toBe('Clear');
    expect(verdictWord('amber')).toBe('Caution');
    expect(verdictWord('red')).toBe('Held');
  });
});

describe('marks', () => {
  it('keeps a visible sliver for a score of zero, because zero is still a measurement', () => {
    expect(trackWidth(0)).toBe('1.5%');
  });

  it('places a score at its own value on the shared axis', () => {
    expect(trackWidth(62)).toBe('62%');
    expect(trackWidth(MAX_SCORE)).toBe('100%');
  });

  it('sizes a factor bar against the heaviest weight the rubric can award', () => {
    expect(factorWidth(POINTS.semverMajorCap)).toBe('100%');
    expect(factorWidth(POINTS.semverMajor)).toBe('66.7%');
    expect(factorWidth(0)).toBe('0');
  });

  it('alternates lanes so neighbouring labels never share a row', () => {
    const spread = placePins([
      { label: 'a', total: 0 },
      { label: 'b', total: 40 },
      { label: 'c', total: 80 },
    ]);
    expect(spread.map((entry) => entry.lane)).toEqual(['lane-a', 'lane-b', 'lane-a']);
    expect(spread.every((entry) => entry.labelled)).toBe(true);
  });

  /**
   * The measurement that matters, done the way the browser does it rather than by counting pins:
   * two labels in the same lane must not share a millimetre of the axis. A real run of 37 bumps is
   * what broke the index-alternating version, so that is the shape this is measured on.
   */
  it('never lets two labels in one lane overlap, however crowded the run', () => {
    const crowded = Array.from({ length: 37 }, (_, index) => ({
      label: `@typescript-eslint/package-${index}`,
      total: 30 + index,
    }));

    const spread = placePins(crowded);
    const labelled = spread.filter((entry) => entry.labelled);

    for (const lane of ['lane-a', 'lane-b'] as const) {
      const spans = labelled
        .filter((entry) => entry.lane === lane)
        .map((entry) => {
          const half = (1.4 + entry.pin.label.length * 0.72) / 2;
          return [entry.pin.total - half, entry.pin.total + half] as const;
        })
        .sort((left, right) => left[0] - right[0]);

      for (let index = 1; index < spans.length; index += 1) {
        expect(spans[index]?.[0]).toBeGreaterThanOrEqual(spans[index - 1]?.[1] ?? 0);
      }
    }

    expect(labelled.length).toBeGreaterThan(0);
    expect(spread).toHaveLength(37);
  });

  /** The worst bump is the one a reader came for, so it is the one that never loses its name. */
  it('keeps the highest score labelled when the axis runs out of room', () => {
    const crowded = Array.from({ length: 20 }, (_, index) => ({
      label: `dependency-number-${index}`,
      total: 60 + index * 0.5,
    }));

    const spread = placePins(crowded);
    const worst = spread[spread.length - 1];

    expect(worst?.pin.total).toBe(69.5);
    expect(worst?.labelled).toBe(true);
    expect(spread.filter((entry) => entry.labelled).length).toBeLessThan(20);
  });
});

describe('the queue sentence', () => {
  it('says nothing is pending when nothing is', () => {
    expect(queueSentence(countBands([]))).toBe('no bumps pending');
  });

  it('adds nothing to do only when nothing needs a person', () => {
    expect(queueSentence(countBands(['green', 'green']))).toBe('2 bumps: 2 clear, nothing to do');
    expect(queueSentence(countBands(['green', 'red']))).toBe('2 bumps: 1 clear, 1 held');
  });

  it('drops the bands that scored nothing rather than printing a zero', () => {
    expect(queueSentence(countBands(['amber', 'amber', 'red']))).toBe('3 bumps: 2 caution, 1 held');
  });

  it('counts one bump in the singular', () => {
    expect(queueSentence(countBands(['red']))).toBe('1 bump: 1 held');
  });
});

describe('times', () => {
  it('prints UTC and never a local rendering of it', () => {
    expect(utcTime('2026-08-21T06:04:11.000Z')).toBe('06:04');
    expect(utcStamp('2026-08-21T06:04:11.000Z')).toBe('2026-08-21 06:04:11');
  });

  it('says unknown rather than inventing a date', () => {
    expect(utcTime(null)).toBe('unknown');
    expect(utcStamp('not a date')).toBe('unknown');
    expect(durationWords('2026-08-21T06:00:00Z', null)).toBe('unknown');
  });

  it('reads a duration the way an operator reads a log line', () => {
    expect(durationWords('2026-08-21T06:00:00Z', '2026-08-21T06:00:01.900Z')).toBe('1.9s');
    expect(durationWords('2026-08-21T06:00:00Z', '2026-08-21T06:04:11Z')).toBe('4m 11s');
  });

  it('never reports negative elapsed time from a clock that moved', () => {
    expect(elapsedSeconds('2026-08-21T06:00:00Z', new Date('2026-08-21T05:00:00Z'))).toBe(0);
  });
});

describe('evidence', () => {
  it('leaves plain evidence alone', () => {
    expect(splitEvidence('one major')).toEqual({
      before: 'one major',
      href: null,
      label: '',
      after: '',
    });
  });

  it('shows a url as its host and keeps the address on the link', () => {
    const parts = splitEvidence('https://github.com/expressjs/express/releases/tag/v5.0.0');
    expect(parts.label).toBe('github.com');
    expect(parts.href).toBe('https://github.com/expressjs/express/releases/tag/v5.0.0');
  });

  it('keeps the words around an embedded url', () => {
    const parts = splitEvidence('removal wording in https://github.com/a/b');
    expect(parts.before).toBe('removal wording in ');
    expect(parts.label).toBe('github.com');
  });

  it('falls back to plain text on a url it cannot parse', () => {
    const parts = splitEvidence('see http://');
    expect(parts.href).toBeNull();
    expect(parts.before).toBe('see http://');
  });

  it('answers with the heaviest factor when there is no brief', () => {
    const sentence = topFactorSentence(scoreOf());
    expect(sentence).toContain('Semver distance');
  });

  it('says so plainly when every factor scored zero', () => {
    expect(
      topFactorSentence({ total: 0, band: 'green', rubricVersion: '1.0.0', factors: [] }),
    ).toBe('No factor scored above zero.');
  });
});

describe('action labels', () => {
  const label = (over: Partial<ActionRecord>) => actionLabel(actionRecord(over));

  it('names the artefact and its number', () => {
    expect(label({ kind: 'hold-issue', number: 41 })).toBe('Hold issue #41');
    expect(label({ kind: 'pull-request', number: 33 })).toBe('Pull request #33');
    expect(label({ kind: 'issue', number: 35 })).toBe('Issue #35');
  });

  it('says what happened when nothing was written', () => {
    expect(label({ outcome: 'dry-run' })).toBe('Dry run, no write access');
    expect(label({ outcome: 'skipped' })).toBe('Carried to the next run');
    expect(label({ outcome: 'failed' })).toBe('Action failed');
  });
});

describe('the audit feed', () => {
  it('writes a start and an end line for a finished run', () => {
    const rows = auditFeed([runRecord()], [], 50);
    expect(rows.map((row) => row.chip)).toEqual(['RUN-END', 'RUN-START']);
  });

  it('writes only a start line while a run is still going', () => {
    const rows = auditFeed([runRecord({ status: 'running', finishedAt: null })], [], 50);
    expect(rows.map((row) => row.chip)).toEqual(['RUN-START']);
  });

  it('marks a failed run as failed and carries its reason', () => {
    const rows = auditFeed(
      [runRecord({ status: 'failed', error: 'GitHub refused the token' })],
      [],
      50,
    );
    expect(rows[0]?.chip).toBe('RUN-FAILED');
    expect(rows[0]?.detail).toContain('GitHub refused the token');
  });

  it('interleaves actions and runs newest first', () => {
    const rows = auditFeed([runRecord()], [actionRecord({ at: '2026-08-21T06:01:00.000Z' })], 50);
    const times = rows.map((row) => row.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('links a bump row to its detail page and its action to GitHub', () => {
    const rows = auditFeed([], [actionRecord()], 50);
    expect(rows[0]?.titleHref).toContain('/bumps/');
    expect(rows[0]?.detailHref).toContain('github.com');
    expect(rows[0]?.detail.startsWith('O')).toBe(true);
  });

  it('honours the limit so one long-running instance cannot render a thousand rows', () => {
    const actions = Array.from({ length: 20 }, (_, index) =>
      actionRecord({
        id: `a${index}`,
        at: `2026-08-21T06:00:${String(index).padStart(2, '0')}.000Z`,
      }),
    );
    expect(auditFeed([runRecord()], actions, 5)).toHaveLength(5);
  });
});
