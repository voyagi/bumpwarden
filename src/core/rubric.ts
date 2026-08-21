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

export type PointsKey = keyof typeof POINTS;

export interface PublishedFactor {
  key: PointsKey;
  description: string;
  source: string;
  points: number;
}

/**
 * Weights that have no row of their own because another row's description carries them, or because
 * they are the zero case a reader infers from its opposite. Anything not here must be published:
 * `rubric.test.ts` fails when a new weight is added to POINTS and never reaches the page.
 */
export const FOLDED_INTO_ANOTHER_ROW: PointsKey[] = [
  'semverPerExtraMajor',
  'semverMajorCap',
  'ageOver14Days',
  'usageUnused',
];

/**
 * The rubric as a reader meets it on the Policy page. Every weight is the constant the scorer
 * actually adds, so a published number cannot drift from a scored one: change POINTS and the page
 * changes with it, which is the only version of "published" worth the word.
 */
export const PUBLISHED_RUBRIC: PublishedFactor[] = [
  {
    key: 'semverPatch',
    description: 'Semver distance: patch',
    source: 'npm registry',
    points: POINTS.semverPatch,
  },
  {
    key: 'semverMinor',
    description: 'Semver distance: minor',
    source: 'npm registry',
    points: POINTS.semverMinor,
  },
  {
    key: 'semverMajor',
    description: `Semver distance: major, plus ${POINTS.semverPerExtraMajor} for each further major, capped at ${POINTS.semverMajorCap}`,
    source: 'npm registry',
    points: POINTS.semverMajor,
  },
  {
    key: 'ageUnder7Days',
    description: `Candidate published less than ${AGE_DAYS.fresh} days ago`,
    source: 'npm registry time',
    points: POINTS.ageUnder7Days,
  },
  {
    key: 'age7To14Days',
    description: `Candidate published ${AGE_DAYS.fresh} to ${AGE_DAYS.settling} days ago`,
    source: 'npm registry time',
    points: POINTS.age7To14Days,
  },
  {
    key: 'advisoryCriticalOrHigh',
    description: 'Advisory on the candidate: critical or high',
    source: 'deps.dev, OSV',
    points: POINTS.advisoryCriticalOrHigh,
  },
  {
    key: 'advisoryModerateOrLow',
    description: 'Advisory on the candidate: moderate or low',
    source: 'deps.dev, OSV',
    points: POINTS.advisoryModerateOrLow,
  },
  {
    key: 'currentDeprecated',
    description: 'Installed version is deprecated',
    source: 'npm registry, deps.dev',
    points: POINTS.currentDeprecated,
  },
  {
    key: 'candidateDeprecated',
    description: 'Candidate version is deprecated',
    source: 'npm registry, deps.dev',
    points: POINTS.candidateDeprecated,
  },
  {
    key: 'breakingMarker',
    description: 'Explicit breaking marker in release notes or commit subjects',
    source: 'GitHub releases, compare',
    points: POINTS.breakingMarker,
  },
  {
    key: 'removalWording',
    description: 'Softer removal wording: removed, dropped support',
    source: 'GitHub releases, compare',
    points: POINTS.removalWording,
  },
  {
    key: 'engineRangeRaised',
    description: 'Engine range raised above the range your manifest declares',
    source: 'package.json engines',
    points: POINTS.engineRangeRaised,
  },
  {
    key: 'peerRangeChanged',
    description: 'Peer dependency range changed',
    source: 'npm registry',
    points: POINTS.peerRangeChanged,
  },
  {
    key: 'usageChangedSymbol',
    description: 'Your code imports a symbol the release notes say changed',
    source: 'your repository',
    points: POINTS.usageChangedSymbol,
  },
  {
    key: 'usagePackageOnly',
    description: 'Your code imports the package but no changed symbol matched',
    source: 'your repository',
    points: POINTS.usagePackageOnly,
  },
  {
    key: 'notesUnavailable',
    description: 'Release notes for the candidate could not be read',
    source: 'recorded as missing',
    points: POINTS.notesUnavailable,
  },
];

export const BAND_RANGES: Record<Band, string> = {
  green: `0 to ${BAND_THRESHOLDS.greenMax}`,
  amber: `${BAND_THRESHOLDS.greenMax + 1} to ${BAND_THRESHOLDS.amberMax}`,
  red: `${BAND_THRESHOLDS.amberMax + 1} to ${MAX_SCORE}`,
};
