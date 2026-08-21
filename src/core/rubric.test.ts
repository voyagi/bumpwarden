import { describe, expect, it } from 'vitest';
import {
  BAND_RANGES,
  BAND_THRESHOLDS,
  FOLDED_INTO_ANOTHER_ROW,
  MAX_SCORE,
  POINTS,
  PUBLISHED_RUBRIC,
  bandFor,
} from './rubric.js';

describe('the published rubric', () => {
  it('publishes every weight the scorer can award', () => {
    // The one failure this guards against: a weight added to POINTS, awarded by the scorer, and
    // never reaching the page a reader is told to check the arithmetic against.
    const published = new Set(PUBLISHED_RUBRIC.map((factor) => factor.key));
    const folded = new Set(FOLDED_INTO_ANOTHER_ROW);
    const unpublished = Object.keys(POINTS).filter(
      (key) =>
        !published.has(key as keyof typeof POINTS) && !folded.has(key as keyof typeof POINTS),
    );

    expect(unpublished).toEqual([]);
  });

  it('prints the number the scorer adds, never a copy of it', () => {
    for (const factor of PUBLISHED_RUBRIC) {
      expect(factor.points).toBe(POINTS[factor.key]);
    }
  });

  it('names a source for every factor', () => {
    for (const factor of PUBLISHED_RUBRIC) {
      expect(factor.source.length).toBeGreaterThan(0);
      expect(factor.description.length).toBeGreaterThan(0);
    }
  });

  it('lists each weight once, so no row silently shadows another', () => {
    const keys = PUBLISHED_RUBRIC.map((factor) => factor.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the published bands', () => {
  it('covers 0 to the maximum with no gap and no overlap', () => {
    expect(BAND_RANGES.green).toBe(`0 to ${BAND_THRESHOLDS.greenMax}`);
    expect(BAND_RANGES.amber).toBe(
      `${BAND_THRESHOLDS.greenMax + 1} to ${BAND_THRESHOLDS.amberMax}`,
    );
    expect(BAND_RANGES.red).toBe(`${BAND_THRESHOLDS.amberMax + 1} to ${MAX_SCORE}`);
  });

  it('agrees with the function that actually decides the band', () => {
    expect(bandFor(BAND_THRESHOLDS.greenMax)).toBe('green');
    expect(bandFor(BAND_THRESHOLDS.greenMax + 1)).toBe('amber');
    expect(bandFor(BAND_THRESHOLDS.amberMax)).toBe('amber');
    expect(bandFor(BAND_THRESHOLDS.amberMax + 1)).toBe('red');
    expect(bandFor(MAX_SCORE)).toBe('red');
  });
});
