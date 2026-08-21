import semver from 'semver';
import { AGE_DAYS, MAX_SCORE, POINTS, RUBRIC_VERSION, bandFor } from './rubric.js';
import { semverDistance } from './semver-distance.js';
import type { CandidateBump, Score, ScoredFactor } from './types.js';

const MS_PER_DAY = 86_400_000;

const EXPLICIT_BREAKING = /breaking[ -]?change|^[a-z]+(\([^)]*\))?!:/im;
const REMOVAL_WORDING =
  /\bremoved\b|\bdropped support\b|\bno longer supported\b|\bdrops support\b/i;

function factor(
  id: string,
  label: string,
  points: number,
  evidence: string,
  locks: string,
): ScoredFactor {
  return { id, label, points, evidence, locks };
}

function semverFactor(bump: CandidateBump): ScoredFactor {
  const distance = semverDistance(bump.currentVersion, bump.candidateVersion);
  const note = distance.zeroMajorRule ? ' (0.x rule: a minor is treated as breaking)' : '';

  if (distance.kind === 'major') {
    const extra = Math.max(0, distance.majorSteps - 1) * POINTS.semverPerExtraMajor;
    const points = Math.min(POINTS.semverMajor + extra, POINTS.semverMajorCap);
    const steps = distance.majorSteps === 1 ? 'one major' : `${distance.majorSteps} majors`;
    return factor('semver', 'Semver distance', points, `${steps}${note}`, 'auto-merge');
  }

  if (distance.kind === 'minor') {
    return factor('semver', 'Semver distance', POINTS.semverMinor, `minor${note}`, 'nothing');
  }

  if (distance.kind === 'unknown') {
    return factor(
      'semver',
      'Semver distance',
      POINTS.semverMinor,
      'version strings could not be parsed, scored as a minor',
      'auto-merge',
    );
  }

  return factor('semver', 'Semver distance', POINTS.semverPatch, distance.kind, 'nothing');
}

function ageFactor(bump: CandidateBump, now: Date): ScoredFactor {
  const published = new Date(bump.candidatePublishedAt);
  if (Number.isNaN(published.getTime())) {
    return factor('age', 'Candidate release age', 0, 'publish time unknown', 'nothing');
  }

  const days = Math.floor((now.getTime() - published.getTime()) / MS_PER_DAY);
  const evidence = `published ${bump.candidatePublishedAt.slice(0, 10)}, ${days} days ago`;

  if (days < AGE_DAYS.fresh) {
    return factor('age', 'Candidate release age', POINTS.ageUnder7Days, evidence, 'auto-merge');
  }
  if (days < AGE_DAYS.settling) {
    return factor('age', 'Candidate release age', POINTS.age7To14Days, evidence, 'nothing');
  }
  return factor('age', 'Candidate release age', POINTS.ageOver14Days, evidence, 'nothing');
}

function advisoryFactor(bump: CandidateBump): ScoredFactor {
  const severe = bump.advisories.some((s) => s === 'critical' || s === 'high');
  const any = bump.advisories.length > 0;
  const points = severe ? POINTS.advisoryCriticalOrHigh : any ? POINTS.advisoryModerateOrLow : 0;
  const evidence = any ? bump.advisories.join(', ') : 'none on the candidate';
  return factor(
    'advisory',
    'Advisories on the candidate',
    points,
    evidence,
    any ? 'pull request' : 'nothing',
  );
}

function deprecationFactor(bump: CandidateBump): ScoredFactor {
  if (bump.candidateDeprecated) {
    return factor(
      'deprecation',
      'Deprecation',
      POINTS.candidateDeprecated,
      'the candidate version is deprecated',
      'pull request',
    );
  }
  if (bump.currentDeprecated) {
    return factor(
      'deprecation',
      'Deprecation',
      POINTS.currentDeprecated,
      'the installed version is deprecated',
      'nothing',
    );
  }
  return factor('deprecation', 'Deprecation', 0, 'neither version is deprecated', 'nothing');
}

function breakingMarkerFactor(bump: CandidateBump): ScoredFactor {
  const haystack = [bump.release.notes ?? '', ...bump.release.commitSubjects].join('\n');

  if (EXPLICIT_BREAKING.test(haystack)) {
    return factor(
      'breaking-marker',
      'Breaking marker in release evidence',
      POINTS.breakingMarker,
      bump.release.notesSource ?? 'commit subjects',
      'pull request',
    );
  }
  if (REMOVAL_WORDING.test(haystack)) {
    return factor(
      'breaking-marker',
      'Breaking marker in release evidence',
      POINTS.removalWording,
      `removal wording in ${bump.release.notesSource ?? 'commit subjects'}`,
      'nothing',
    );
  }
  return factor(
    'breaking-marker',
    'Breaking marker in release evidence',
    0,
    'none found',
    'nothing',
  );
}

function minimumNode(range: string | null): semver.SemVer | null {
  if (!range) return null;
  try {
    return semver.minVersion(range);
  } catch {
    return null;
  }
}

function engineFactor(bump: CandidateBump): ScoredFactor {
  const candidateMin = minimumNode(bump.candidateEngines);
  const repoMin = minimumNode(bump.repoEngines);

  if (!candidateMin || !repoMin) {
    return factor('engines', 'Engine range', 0, 'no comparable engines range', 'nothing');
  }
  if (semver.gt(candidateMin, repoMin)) {
    return factor(
      'engines',
      'Engine range',
      POINTS.engineRangeRaised,
      `candidate needs Node ${candidateMin.version}, you declare ${repoMin.version}`,
      'pull request',
    );
  }
  return factor(
    'engines',
    'Engine range',
    0,
    `candidate needs Node ${candidateMin.version}, you declare ${repoMin.version}`,
    'nothing',
  );
}

function peerFactor(bump: CandidateBump): ScoredFactor {
  const points = bump.peerDependenciesChanged ? POINTS.peerRangeChanged : 0;
  const evidence = bump.peerDependenciesChanged ? 'peer range changed' : 'peer range unchanged';
  return factor('peers', 'Peer dependency range', points, evidence, 'nothing');
}

function usageFactor(bump: CandidateBump): ScoredFactor {
  if (bump.usage === 'changed-symbol') {
    const where = bump.usageSites.map((s) => `${s.path}:${s.line}`).join(', ');
    return factor(
      'usage',
      'Your code touches a changed symbol',
      POINTS.usageChangedSymbol,
      where || 'matched in this repository',
      'pull request',
    );
  }
  if (bump.usage === 'package-only') {
    return factor(
      'usage',
      'Your code imports the package',
      POINTS.usagePackageOnly,
      'imported, but no changed symbol matched',
      'nothing',
    );
  }
  return factor(
    'usage',
    'Your code imports the package',
    POINTS.usageUnused,
    'not imported',
    'nothing',
  );
}

function notesFactor(bump: CandidateBump): ScoredFactor {
  if (bump.release.notes === null) {
    return factor(
      'notes-missing',
      'Release notes for the candidate',
      POINTS.notesUnavailable,
      'could not be read, recorded as missing',
      'pull request',
    );
  }
  return factor(
    'notes-missing',
    'Release notes for the candidate',
    0,
    bump.release.notesSource ?? 'read',
    'nothing',
  );
}

/**
 * Pure by construction: the only ambient input is `now`, which is passed in. Two runs over the same
 * evidence at the same instant produce byte-identical output, which is what the published rubric
 * promises a reader.
 */
export function scoreBump(bump: CandidateBump, now: Date): Score {
  const factors = [
    semverFactor(bump),
    usageFactor(bump),
    breakingMarkerFactor(bump),
    advisoryFactor(bump),
    deprecationFactor(bump),
    engineFactor(bump),
    ageFactor(bump, now),
    peerFactor(bump),
    notesFactor(bump),
  ];

  const raw = factors.reduce((sum, f) => sum + f.points, 0);
  const total = Math.min(raw, MAX_SCORE);

  return { total, band: bandFor(total), rubricVersion: RUBRIC_VERSION, factors };
}
