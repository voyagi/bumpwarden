import semver from 'semver';
import type { Outcome, RunFetcher } from './http.js';

const REGISTRY = 'https://registry.npmjs.org';

interface VersionManifest {
  deprecated?: string;
  engines?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface PackumentResponse {
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, VersionManifest>;
  time?: Record<string, string>;
  repository?: { url?: string } | string;
}

export interface Packument {
  name: string;
  distTags: Record<string, string>;
  versions: Record<string, VersionManifest>;
  time: Record<string, string>;
  repositoryUrl: string | null;
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

export async function fetchPackument(
  fetcher: RunFetcher,
  packageName: string,
): Promise<Outcome<Packument>> {
  if (!isValidPackageName(packageName)) {
    return {
      ok: false,
      reason: 'malformed',
      status: null,
      detail: `${packageName} is not a valid npm package name`,
    };
  }

  const result = await fetcher.getJson<PackumentResponse>(registryUrl(packageName));
  if (!result.ok) return result;

  const repository = result.value.repository;
  const repositoryUrl = typeof repository === 'string' ? repository : (repository?.url ?? null);

  return {
    ok: true,
    fromCache: result.fromCache,
    value: {
      name: packageName,
      distTags: result.value['dist-tags'] ?? {},
      versions: result.value.versions ?? {},
      time: result.value.time ?? {},
      repositoryUrl,
    },
  };
}

function stableVersions(packument: Packument): string[] {
  return Object.keys(packument.versions).filter((v) => semver.valid(v) && !semver.prerelease(v));
}

function peerRangesEqual(a: VersionManifest | undefined, b: VersionManifest | undefined): boolean {
  return JSON.stringify(a?.peerDependencies ?? {}) === JSON.stringify(b?.peerDependencies ?? {});
}

/**
 * The candidate is the highest stable version above the installed one, with `latest` preferred when
 * it is the same version, so a package whose maintainers hold `latest` behind a newer major is not
 * quietly pushed across that major.
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
