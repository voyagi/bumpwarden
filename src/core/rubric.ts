import type { Band } from './types.js';

/**
 * Bumping this string is the only way a score changes meaning. Stored scores keep the version they
 * were computed under, so a rubric change never silently rewrites history.
 */
export const RUBRIC_VERSION = '1.0.0';

export const BAND_THRESHOLDS = {
  greenMax: 30,
  amberMax: 60,
} as const;

export const MAX_SCORE = 100;

export const POINTS = {
  semverPatch: 0,
  semverMinor: 8,
  semverMajor: 30,
  semverPerExtraMajor: 6,
  semverMajorCap: 45,

  ageUnder7Days: 12,
  age7To14Days: 6,
  ageOver14Days: 0,

  advisoryCriticalOrHigh: 25,
  advisoryModerateOrLow: 12,

  currentDeprecated: 10,
  candidateDeprecated: 30,

  breakingMarker: 12,
  removalWording: 6,

  engineRangeRaised: 15,
  peerRangeChanged: 8,

  usageChangedSymbol: 20,
  usagePackageOnly: 8,
  usageUnused: 0,

  notesUnavailable: 6,
} as const;

export const AGE_DAYS = {
  fresh: 7,
  settling: 14,
} as const;

export function bandFor(total: number): Band {
  if (total <= BAND_THRESHOLDS.greenMax) return 'green';
  if (total <= BAND_THRESHOLDS.amberMax) return 'amber';
  return 'red';
}
