export type Band = 'green' | 'amber' | 'red';

export type AdvisorySeverity = 'critical' | 'high' | 'moderate' | 'low';

export type UsageMatch = 'changed-symbol' | 'package-only' | 'unused';

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

/** A source the run could not read. Recorded rather than guessed, and shown next to the verdict. */
export interface MissingSource {
  what: string;
  why: string;
}

export interface ScoredFactor {
  id: string;
  label: string;
  points: number;
  evidence: string;
  /** What this factor forbids. The dashboard prints it as the locking table's Locks column. */
  locks: string;
}

export interface Score {
  total: number;
  band: Band;
  rubricVersion: string;
  factors: ScoredFactor[];
}
