import semver from 'semver';
import type { MissingSource } from '../core/types.js';
import type { Outcome, RunFetcher } from './http.js';

const REGISTRY = 'https://registry.npmjs.org';

interface VersionManifest {
  deprecated?: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

type RepositoryField = { url?: string } | string;

interface PackumentResponse {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, VersionManifest>;
  time?: Record<string, string>;
  repository?: RepositoryField;
}

/** The registry's document for one version: the manifest as published, without publish times. */
interface VersionDocument extends VersionManifest {
  version?: string;
  repository?: RepositoryField;
}

export interface Packument {
  name: string;
  distTags: Record<string, string>;
  versions: Record<string, VersionManifest>;
  time: Record<string, string>;
  repositoryUrl: string | null;
  /** What a read of this package could not include, for the run's missing list. */
  gaps: MissingSource[];
}

function repositoryUrlOf(document: { repository?: RepositoryField }): string | null {
  const repository = document.repository;
  return typeof repository === 'string' ? repository : (repository?.url ?? null);
}

/**
 * What GitHub itself allows in an account or repository name. The pair parsed below is pasted
 * into an api.github.com path, and the field it came from is written by whoever published the
 * package: `..` on both sides walks the path back out of `/repos/` and aims the call, carrying
 * this service's token, at an endpoint the package author chose.
 */
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO = /^[A-Za-z0-9_.-]{1,100}$/;

function namedRepository(owner: string, repo: string): { owner: string; repo: string } | null {
  if (!GITHUB_OWNER.test(owner)) return null;
  if (!GITHUB_REPO.test(repo) || repo === '.' || repo === '..') return null;
  return { owner, repo };
}

/**
 * Registry repository fields are written half a dozen ways (git+ssh, git+https, a bare shorthand),
 * and only the owner and repo are ever needed, so everything else is discarded rather than parsed.
 */
export function githubRepoFrom(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const match = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/i.exec(url);
  if (!match) return null;
  return namedRepository(match[1] ?? '', match[2] ?? '');
}

export interface Candidate {
  version: string;
  publishedAt: string | null;
  deprecated: boolean;
  engines: string | null;
  peerRangeChanged: boolean;
}

/** A scoped name carries a slash that must not become a path separator in the registry URL. */
export function registryUrl(packageName: string): string {
  return `${REGISTRY}/${packageName.replace('/', '%2F')}`;
}

/**
 * A dependency key comes from a watched repository's manifest, which is not this service's data, so
 * it is checked against the registry's own name grammar before being pasted into a URL. Without
 * this, a key like `../../x` or one carrying a query string reaches fetch as a crafted path.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && PACKAGE_NAME.test(name);
}

function malformed(detail: string): Outcome<never> {
  return { ok: false, reason: 'malformed', status: null, detail };
}

const VERSIONS_ABOVE_UNREAD =
  'the registry document is over the size cap, so the versions above the installed one could not be read';

/**
 * The one registry read that grows without bound: every version's manifest plus every publish time.
 * `prisma` is 44 MB and `@prisma/client` 68 MB, `typescript` 16 MB, and a 39-dependency repository
 * pulled 197 MB of these per run, nearly all of it never used. So this is no longer the first read.
 * It is consulted for the version list when the installed version is ahead of `latest`, and for a
 * publish time when deps.dev has none.
 */
async function fetchWholePackument(
  fetcher: RunFetcher,
  packageName: string,
): Promise<Outcome<PackumentResponse>> {
  return fetcher.getJson<PackumentResponse>(registryUrl(packageName));
}

function wholePackument(packageName: string, response: PackumentResponse): Packument {
  return {
    name: packageName,
    distTags: response['dist-tags'] ?? {},
    versions: response.versions ?? {},
    time: response.time ?? {},
    repositoryUrl: repositoryUrlOf(response),
    gaps: [],
  };
}

function sliceOf(
  packageName: string,
  latestVersion: string,
  latest: VersionDocument,
  versions: Record<string, VersionManifest>,
  gaps: MissingSource[],
): Packument {
  return {
    name: packageName,
    distTags: { latest: latestVersion },
    versions,
    time: {},
    repositoryUrl: repositoryUrlOf(latest),
    gaps,
  };
}

/**
 * The two documents a pending bump needs, a few KB each at any version count: the candidate's own
 * manifest and the installed one, for the peer ranges and the deprecation flag. Publish times are
 * not in them, and deps.dev is asked for those first anyway. What is not read is recorded rather
 * than guessed.
 */
async function fetchBumpDocuments(
  fetcher: RunFetcher,
  packageName: string,
  installedVersion: string,
  latestVersion: string,
  latest: VersionDocument,
): Promise<Packument> {
  const versions: Record<string, VersionManifest> = { [latestVersion]: latest };
  const gaps: MissingSource[] = [];

  if (semver.valid(installedVersion)) {
    const installed = await fetcher.getJson<VersionDocument>(
      `${registryUrl(packageName)}/${encodeURIComponent(installedVersion)}`,
    );
    if (installed.ok) versions[installedVersion] = installed.value;
    // A version the registry never had leaves the same hole a whole packument would; any other
    // failure is a source that exists and was not read.
    else if (installed.reason !== 'not-found') {
      gaps.push({
        what: `${packageName}@${installedVersion} registry data`,
        why: installed.detail,
      });
    }
  }

  return sliceOf(packageName, latestVersion, latest, versions, gaps);
}

/**
 * Reads the registry the way `npm install` would: `latest` first. When `latest` is above the
 * installed version it is the candidate, and the whole version list decides nothing, so it is
 * never downloaded. When the installed version is at `latest` there is no bump to propose, a
 * version the maintainers hold back is not a bump, and one small read settles it. Only an
 * installed version that is ahead of `latest` needs the list, which is rare, and which is where
 * the size cap can still refuse a package.
 */
export async function fetchPackument(
  fetcher: RunFetcher,
  packageName: string,
  installedVersion: string,
): Promise<Outcome<Packument>> {
  if (!isValidPackageName(packageName)) {
    return malformed(`${packageName} is not a valid npm package name`);
  }

  const latest = await fetcher.getJson<VersionDocument>(`${registryUrl(packageName)}/latest`);
  if (!latest.ok) return latest;

  const latestVersion = latest.value.version;
  if (!latestVersion || !semver.valid(latestVersion)) {
    return malformed(`the latest document of ${packageName} names no version`);
  }

  const installed = semver.coerce(installedVersion);
  if (installed && semver.gt(latestVersion, installed)) {
    const value = await fetchBumpDocuments(
      fetcher,
      packageName,
      installedVersion,
      latestVersion,
      latest.value,
    );
    return { ok: true, fromCache: latest.fromCache, value };
  }

  const gaps: MissingSource[] = [];
  if (installed && semver.gt(installed, latestVersion)) {
    const whole = await fetchWholePackument(fetcher, packageName);
    if (whole.ok) {
      return {
        ok: true,
        fromCache: whole.fromCache,
        value: wholePackument(packageName, whole.value),
      };
    }
    gaps.push({
      what: `${packageName} version list`,
      why: whole.reason === 'too-large' ? VERSIONS_ABOVE_UNREAD : whole.detail,
    });
  }

  const latestOnly = { [latestVersion]: latest.value };
  return {
    ok: true,
    fromCache: latest.fromCache,
    value: sliceOf(packageName, latestVersion, latest.value, latestOnly, gaps),
  };
}

/**
 * The registry's publish time for one version, paid for only when deps.dev had none: it costs the
 * whole packument, and a package the cap refuses simply has no time to give.
 */
export async function fetchPublishTime(
  fetcher: RunFetcher,
  packageName: string,
  version: string,
): Promise<string | null> {
  if (!isValidPackageName(packageName)) return null;
  const whole = await fetchWholePackument(fetcher, packageName);
  return whole.ok ? (whole.value.time?.[version] ?? null) : null;
}

function stableVersions(packument: Packument): string[] {
  return Object.keys(packument.versions).filter((v) => semver.valid(v) && !semver.prerelease(v));
}

function peerRangesEqual(a: VersionManifest | undefined, b: VersionManifest | undefined): boolean {
  return JSON.stringify(a?.peerDependencies ?? {}) === JSON.stringify(b?.peerDependencies ?? {});
}

/**
 * The candidate is `latest` whenever `latest` is above the installed version, so a package whose
 * maintainers hold `latest` behind a newer major is not quietly pushed across that major. The
 * version list only matters when the installed version is already ahead of `latest`, and then the
 * highest stable version above it is the candidate. `fetchPackument` hands this function exactly
 * the documents each of those cases needs.
 */
export function resolveCandidate(packument: Packument, currentVersion: string): Candidate | null {
  const current = semver.coerce(currentVersion);
  if (!current) return null;

  const above = stableVersions(packument).filter((v) => semver.gt(v, current));
  if (above.length === 0) return null;

  const latestTag = packument.distTags.latest;
  const highest = above.sort(semver.rcompare)[0] as string;
  const chosen =
    latestTag && semver.valid(latestTag) && semver.gt(latestTag, current) ? latestTag : highest;

  const manifest = packument.versions[chosen];
  const currentManifest = packument.versions[currentVersion];

  return {
    version: chosen,
    publishedAt: packument.time[chosen] ?? null,
    deprecated: typeof manifest?.deprecated === 'string',
    engines: manifest?.engines?.node ?? null,
    peerRangeChanged: !peerRangesEqual(currentManifest, manifest),
  };
}

export function isVersionDeprecated(packument: Packument, version: string): boolean {
  return typeof packument.versions[version]?.deprecated === 'string';
}
