import { describe, expect, it } from 'vitest';
import { semverDistance, type DistanceKind } from './semver-distance.js';

describe('semver distance', () => {
  const table: Array<[string, string, DistanceKind, number, boolean]> = [
    ['1.2.3', '1.2.3', 'none', 0, false],
    ['1.2.3', '1.2.4', 'patch', 0, false],
    ['1.2.3', '1.3.0', 'minor', 0, false],
    ['1.2.3', '2.0.0', 'major', 1, false],
    ['4.1.2', '6.0.0', 'major', 2, false],
    ['8.1.0', '13.0.6', 'major', 5, false],
    ['0.4.0', '0.5.0', 'major', 1, true],
    ['0.4.0', '0.4.1', 'minor', 0, true],
    ['workspace:*', '1.0.0', 'unknown', 0, false],
    ['1.0.0', 'latest', 'unknown', 0, false],
  ];

  it.each(table)('%s to %s is a %s move', (current, candidate, kind, majorSteps, zeroMajorRule) => {
    expect(semverDistance(current, candidate)).toEqual({ kind, majorSteps, zeroMajorRule });
  });

  it('counts the same distance in either direction, so a downgrade is not read as a patch', () => {
    expect(semverDistance('6.0.0', '4.1.2')).toEqual({
      kind: 'major',
      majorSteps: 2,
      zeroMajorRule: false,
    });
  });
});
