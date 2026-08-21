import semver from 'semver';

export type DistanceKind = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

export interface SemverDistance {
  kind: DistanceKind;
  /** Majors crossed, counted from the current version. A 4 to 6 move is 2. */
  majorSteps: number;
  /** True when 0.x rules applied, so a minor move was treated as breaking. */
  zeroMajorRule: boolean;
}

/**
 * Under 0.x, npm's own caret range refuses to cross a minor, because a 0.x minor is where the
 * ecosystem puts breaking changes. So a 0.4 to 0.5 move is scored as a major, not a minor.
 */
export function semverDistance(current: string, candidate: string): SemverDistance {
  const from = semver.coerce(current);
  const to = semver.coerce(candidate);
  if (!from || !to) return { kind: 'unknown', majorSteps: 0, zeroMajorRule: false };

  if (semver.eq(from, to)) return { kind: 'none', majorSteps: 0, zeroMajorRule: false };

  if (to.major !== from.major) {
    return {
      kind: 'major',
      majorSteps: Math.abs(to.major - from.major),
      zeroMajorRule: false,
    };
  }

  const zeroMajor = from.major === 0;
  if (to.minor !== from.minor) {
    return {
      kind: zeroMajor ? 'major' : 'minor',
      majorSteps: zeroMajor ? 1 : 0,
      zeroMajorRule: zeroMajor,
    };
  }

  return {
    kind: zeroMajor ? 'minor' : 'patch',
    majorSteps: 0,
    zeroMajorRule: zeroMajor,
  };
}
