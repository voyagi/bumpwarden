import type {
  AdvisorySeverity,
  CandidateBump,
  MissingSource,
  ReleaseEvidence,
} from '../core/types.js';
import { classifyUsage, type SourceFile } from '../core/usage.js';
import { fetchAdvisory, fetchVersionFacts } from '../io/depsdev.js';
import { compareVersions, fetchReleaseNotes, fetchTextFile, type RepoRef } from '../io/github.js';
import type { RunFetcher } from '../io/http.js';
import { READS_IN_FLIGHT, mapInFlight } from '../io/in-flight.js';
import {
  fetchPackument,
  fetchPublishTime,
  githubRepoFrom,
  isVersionDeprecated,
  resolveCandidate,
  type Candidate,
} from '../io/npm.js';
import {
  LOCKFILES,
  parseManifest,
  parseNpmLock,
  resolveInstalled,
  type InstalledDependency,
  type LockfileKind,
} from './manifest.js';

export type { MissingSource } from '../core/types.js';

export interface IngestOptions {
  githubToken?: string | null;
  /** Repository files the usage matcher searches. Phase 1 passes the ones already fetched. */
  sourceFiles?: SourceFile[];
  maxDependencies?: number;
}

export interface IngestResult {
  bumps: CandidateBump[];
  missing: MissingSource[];
  lockfile: LockfileKind;
  repoEngines: string | null;
  dependenciesConsidered: number;
}

const DEFAULT_MAX_DEPENDENCIES = 60;

async function readLockfile(
  fetcher: RunFetcher,
  target: RepoRef,
  token: string | null,
  missing: MissingSource[],
): Promise<{ kind: LockfileKind; installed: Map<string, string> }> {
  for (const { path, kind } of LOCKFILES) {
    const result = await fetchTextFile(fetcher, target, path, token);
    if (!result.ok) continue;

    if (kind !== 'npm') {
      missing.push({
        what: path,
        why: 'lockfile format not parsed in v1, installed versions fall back to the range floor',
      });
      return { kind, installed: new Map() };
    }

    const installed = parseNpmLock(result.value);
    if (installed.size === 0) {
      // A lockfile that yields nothing looks exactly like no lockfile downstream, and the range
      // floor it falls back to overstates every semver distance. Say so rather than let the
      // dashboard imply these versions were read.
      missing.push({ what: path, why: 'read but yielded no versions, so ranges are the fallback' });
    }
    return { kind, installed };
  }

  missing.push({ what: 'lockfile', why: 'no lockfile found on the default branch' });
  return { kind: 'none', installed: new Map() };
}

async function collectReleaseEvidence(
  fetcher: RunFetcher,
  repositoryUrl: string | null,
  dependency: string,
  currentVersion: string,
  candidateVersion: string,
  token: string | null,
  missing: MissingSource[],
): Promise<ReleaseEvidence> {
  const upstream = githubRepoFrom(repositoryUrl);
  if (!upstream) {
    missing.push({
      what: `${dependency} release notes`,
      why: 'no GitHub repository in the registry',
    });
    return { notes: null, notesSource: null, commitSubjects: [] };
  }

  const target: RepoRef = { ...upstream, ref: 'HEAD' };
  const notes = await fetchReleaseNotes(fetcher, target, candidateVersion, token);
  const compared = await compareVersions(fetcher, target, currentVersion, candidateVersion, token);

  if (!notes.ok) {
    missing.push({ what: `${dependency} release notes`, why: `${notes.reason}: ${notes.detail}` });
  }
  if (!compared.ok) {
    missing.push({
      what: `${dependency} tag compare`,
      why: `${compared.reason}: ${compared.detail}`,
    });
  }

  return {
    notes: notes.ok ? notes.value.body : null,
    notesSource: notes.ok ? notes.value.source : null,
    commitSubjects: compared.ok ? compared.value.commitSubjects : [],
    changedFiles: compared.ok ? compared.value.changedFiles : [],
  };
}

async function severitiesFor(
  fetcher: RunFetcher,
  advisoryIds: string[],
): Promise<AdvisorySeverity[]> {
  const severities: AdvisorySeverity[] = [];
  for (const id of advisoryIds) {
    const advisory = await fetchAdvisory(fetcher, id);
    if (advisory.ok) severities.push(advisory.value.severity);
  }
  return severities;
}

/**
 * deps.dev first, because it answers in a few KB. The registry's whole packument is the fallback
 * and costs a download the size of the package's history, so it is read only when the cheap source
 * had no time to give, which keeps the fresh-release penalty alive through a deps.dev outage.
 */
async function publishTimeFor(
  fetcher: RunFetcher,
  packageName: string,
  candidate: Candidate,
  fromDepsDev: string | null,
): Promise<string> {
  if (fromDepsDev) return fromDepsDev;
  if (candidate.publishedAt) return candidate.publishedAt;
  return (await fetchPublishTime(fetcher, packageName, candidate.version)) ?? '';
}

async function bumpFor(
  fetcher: RunFetcher,
  installed: InstalledDependency,
  context: { repoEngines: string | null; token: string | null; sourceFiles: SourceFile[] },
  missing: MissingSource[],
): Promise<CandidateBump | null> {
  const packument = await fetchPackument(fetcher, installed.name, installed.version);
  if (!packument.ok) {
    missing.push({ what: `${installed.name} registry data`, why: packument.detail });
    return null;
  }
  missing.push(...packument.value.gaps);

  const candidate = resolveCandidate(packument.value, installed.version);
  if (!candidate) return null;

  const candidateFacts = await fetchVersionFacts(fetcher, installed.name, candidate.version);
  const currentFacts = await fetchVersionFacts(fetcher, installed.name, installed.version);
  if (!candidateFacts.ok) {
    missing.push({
      what: `${installed.name}@${candidate.version} deps.dev`,
      why: candidateFacts.detail,
    });
  }
  const candidatePublishedAt = await publishTimeFor(
    fetcher,
    installed.name,
    candidate,
    candidateFacts.ok ? candidateFacts.value.publishedAt : null,
  );

  const release = await collectReleaseEvidence(
    fetcher,
    packument.value.repositoryUrl,
    installed.name,
    installed.version,
    candidate.version,
    context.token,
    missing,
  );

  const usage = classifyUsage(installed.name, release, context.sourceFiles);

  return {
    dependency: installed.name,
    currentVersion: installed.version,
    candidateVersion: candidate.version,
    candidatePublishedAt,
    // Two sources for the same fact on purpose: the registry already carries it, so a deps.dev
    // outage must not quietly drop the ten points an installed deprecated version is worth.
    currentDeprecated:
      (currentFacts.ok && currentFacts.value.isDeprecated) ||
      isVersionDeprecated(packument.value, installed.version),
    candidateDeprecated:
      candidate.deprecated || (candidateFacts.ok ? candidateFacts.value.isDeprecated : false),
    advisories: candidateFacts.ok
      ? await severitiesFor(fetcher, candidateFacts.value.advisoryIds)
      : [],
    candidateEngines: candidate.engines,
    repoEngines: context.repoEngines,
    peerDependenciesChanged: candidate.peerRangeChanged,
    usage: usage.match,
    usageSites: usage.sites,
    release,
  };
}

/**
 * Assembles every pending bump for one repository. Nothing here throws on a missing source: each
 * gap is appended to `missing` and the run continues, because a scored bump with a recorded hole is
 * worth more to the reader than an aborted run.
 */
export async function ingestRepository(
  fetcher: RunFetcher,
  target: RepoRef,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const token = options.githubToken ?? null;
  const missing: MissingSource[] = [];

  const manifestText = await fetchTextFile(fetcher, target, 'package.json', token);
  if (!manifestText.ok) {
    missing.push({ what: 'package.json', why: `${manifestText.reason}: ${manifestText.detail}` });
    return { bumps: [], missing, lockfile: 'none', repoEngines: null, dependenciesConsidered: 0 };
  }

  const manifest = parseManifest(manifestText.value);
  if (!manifest) {
    missing.push({ what: 'package.json', why: 'could not be parsed as JSON' });
    return { bumps: [], missing, lockfile: 'none', repoEngines: null, dependenciesConsidered: 0 };
  }

  const lock = await readLockfile(fetcher, target, token, missing);
  const installed = resolveInstalled(manifest, lock.installed).slice(
    0,
    options.maxDependencies ?? DEFAULT_MAX_DEPENDENCIES,
  );

  const context = {
    repoEngines: manifest.engines,
    token,
    sourceFiles: options.sourceFiles ?? [],
  };

  // Each dependency records its gaps on a list of its own, joined in manifest order below, so what
  // the run reports never depends on which dependency's reads happened to finish first.
  const read = await mapInFlight(installed, READS_IN_FLIGHT, async (dependency) => {
    const gaps: MissingSource[] = [];
    const bump = await bumpFor(fetcher, dependency, context, gaps);
    return { bump, gaps };
  });

  const bumps: CandidateBump[] = [];
  for (const { bump, gaps } of read) {
    missing.push(...gaps);
    if (bump) bumps.push(bump);
  }

  return {
    bumps,
    missing,
    lockfile: lock.kind,
    repoEngines: manifest.engines,
    dependenciesConsidered: installed.length,
  };
}
