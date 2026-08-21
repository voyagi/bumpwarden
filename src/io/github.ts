import type { Outcome, RunFetcher } from './http.js';

const API = 'https://api.github.com';

export interface RepoRef {
  owner: string;
  repo: string;
  ref: string;
}

interface ContentsResponse {
  content?: string;
  encoding?: string;
}

interface ReleaseResponse {
  body?: string;
  html_url?: string;
}

interface CompareResponse {
  total_commits?: number;
  commits?: Array<{ commit?: { message?: string } }>;
  files?: Array<{ filename?: string }>;
}

export interface CompareFacts {
  totalCommits: number;
  commitSubjects: string[];
  changedFiles: string[];
}

export interface ReleaseNotes {
  body: string;
  source: string;
}

/**
 * Reads go through the shared run fetcher rather than an SDK so that every external call in a run
 * shares one budget, one cache and one backoff policy. Writes go through Octokit instead, in
 * `github-actor.ts`, where the typed routes and error shapes are worth the second client.
 */
function headers(token: string | null): Record<string, string> {
  const base: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  return token ? { ...base, authorization: `Bearer ${token}` } : base;
}

export async function fetchTextFile(
  fetcher: RunFetcher,
  target: RepoRef,
  path: string,
  token: string | null = null,
): Promise<Outcome<string>> {
  const url = `${API}/repos/${target.owner}/${target.repo}/contents/${path}?ref=${encodeURIComponent(target.ref)}`;
  const result = await fetcher.getJson<ContentsResponse>(url, headers(token));
  if (!result.ok) return result;

  const { content, encoding } = result.value;
  if (typeof content !== 'string' || encoding !== 'base64') {
    return {
      ok: false,
      reason: 'malformed',
      status: null,
      detail: `${path} is not base64 content`,
    };
  }

  return {
    ok: true,
    fromCache: result.fromCache,
    value: Buffer.from(content, 'base64').toString('utf8'),
  };
}

/** Projects disagree about the `v` prefix, so both spellings are tried before recording a miss. */
export function tagCandidates(version: string): string[] {
  return [`v${version}`, version];
}

export async function fetchReleaseNotes(
  fetcher: RunFetcher,
  target: RepoRef,
  version: string,
  token: string | null = null,
): Promise<Outcome<ReleaseNotes>> {
  for (const tag of tagCandidates(version)) {
    const url = `${API}/repos/${target.owner}/${target.repo}/releases/tags/${encodeURIComponent(tag)}`;
    const result = await fetcher.getJson<ReleaseResponse>(url, headers(token));

    if (result.ok && typeof result.value.body === 'string' && result.value.body.trim().length > 0) {
      return {
        ok: true,
        fromCache: result.fromCache,
        value: {
          body: result.value.body,
          source: result.value.html_url ?? `${target.owner}/${target.repo} release ${tag}`,
        },
      };
    }
    if (!result.ok && result.reason !== 'not-found') return result;
  }

  return {
    ok: false,
    reason: 'not-found',
    status: 404,
    detail: `no release notes for ${version} under either tag spelling`,
  };
}

export interface TreeEntry {
  path: string;
  type: string;
  size: number;
}

interface TreeResponse {
  tree?: Array<{ path?: string; type?: string; size?: number }>;
  truncated?: boolean;
}

export interface RepositoryTree {
  entries: TreeEntry[];
  /** GitHub caps a recursive tree; a truncated one means the file list is incomplete, not empty. */
  truncated: boolean;
}

export async function fetchTree(
  fetcher: RunFetcher,
  target: RepoRef,
  token: string | null = null,
): Promise<Outcome<RepositoryTree>> {
  const url = `${API}/repos/${target.owner}/${target.repo}/git/trees/${encodeURIComponent(target.ref)}?recursive=1`;
  const result = await fetcher.getJson<TreeResponse>(url, headers(token));
  if (!result.ok) return result;

  return {
    ok: true,
    fromCache: result.fromCache,
    value: {
      truncated: result.value.truncated === true,
      entries: (result.value.tree ?? [])
        .filter(
          (entry): entry is { path: string; type: string; size?: number } =>
            typeof entry.path === 'string' && typeof entry.type === 'string',
        )
        .map((entry) => ({ path: entry.path, type: entry.type, size: entry.size ?? 0 })),
    },
  };
}

export async function compareTags(
  fetcher: RunFetcher,
  target: RepoRef,
  base: string,
  head: string,
  token: string | null = null,
): Promise<Outcome<CompareFacts>> {
  const url = `${API}/repos/${target.owner}/${target.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
  const result = await fetcher.getJson<CompareResponse>(url, headers(token));
  if (!result.ok) return result;

  return {
    ok: true,
    fromCache: result.fromCache,
    value: {
      totalCommits: result.value.total_commits ?? 0,
      commitSubjects: (result.value.commits ?? [])
        .map((entry) => entry.commit?.message?.split('\n')[0]?.trim() ?? '')
        .filter((subject) => subject.length > 0),
      changedFiles: (result.value.files ?? [])
        .map((file) => file.filename ?? '')
        .filter((name) => name.length > 0),
    },
  };
}
