/**
 * Risk band classification for a bump: green (low risk), amber (medium risk), or red (high risk).
 */
export type Band = 'green' | 'amber' | 'red';

/**
 * Security advisory severity levels.
 */
export type AdvisorySeverity = 'critical' | 'high' | 'moderate' | 'low';

/**
 * Result of matching changed symbols in a release against repository usage.
 */
export type UsageMatch = 'changed-symbol' | 'package-only' | 'unused';

/**
 * A specific location in the codebase where a dependency symbol is used.
 */
export interface UsageSite {
  path: string;
  line: number;
  symbol: string;
  text: string;
}

/**
 * `notes` is null when the source could not be read, never an empty string standing in for
 * absence: a missing changelog is a scored risk factor, and the two must not collapse.
 */
export interface ReleaseEvidence {
  notes: string | null;
  notesSource: string | null;
  commitSubjects: string[];
  /**
   * File paths the upstream diff touched. Optional because it exists only when the tag compare
   * succeeded, and no factor scores it: it is material for the brief, not evidence for the score.
   */
  changedFiles?: string[];
}

/**
 * All information about a candidate dependency bump, including versions, advisories, and usage analysis.
 */
export interface CandidateBump {
  dependency: string;
  currentVersion: string;
  candidateVersion: string;
  candidatePublishedAt: string;
  currentDeprecated: boolean;
  candidateDeprecated: boolean;
  advisories: AdvisorySeverity[];
  candidateEngines: string | null;
  repoEngines: string | null;
  peerDependenciesChanged: boolean;
  usage: UsageMatch;
  usageSites: UsageSite[];
  release: ReleaseEvidence;
}

/**
 * A source the run could not read. Recorded rather than guessed, and shown next to the verdict.
 */
export interface MissingSource {
  what: string;
  why: string;
}

/**
 * A scored risk factor contributing to the overall risk assessment of a bump.
 */
export interface ScoredFactor {
  id: string;
  label: string;
  points: number;
  evidence: string;
  /** What this factor forbids. The dashboard prints it as the locking table's Locks column. */
  locks: string;
}

/**
 * The complete risk score for a bump, including total points, band classification, and contributing factors.
 */
export interface Score {
  total: number;
  band: Band;
  rubricVersion: string;
  factors: ScoredFactor[];
}
