/**
 * The bump key is the identity a re-run matches on. It is derived from facts that do not move
 * between runs (repository, package, candidate version), never from a timestamp or a run id, which
 * is what makes a second run update the first run's issue instead of opening another.
 */
export interface BumpIdentity {
  owner: string;
  repo: string;
  dependency: string;
  candidateVersion: string;
}

const MARKER_OPEN = '<!-- bumpwarden:key=';
const MARKER_CLOSE = ' -->';

export function repositoryId(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

export function bumpKey(identity: BumpIdentity): string {
  const { owner, repo, dependency, candidateVersion } = identity;
  return `${owner}/${repo}#${dependency}@${candidateVersion}`;
}

/** Firestore document ids may not contain a slash, and the key is the natural id. */
export function documentId(key: string): string {
  return key.replace(/\//g, '__');
}

/**
 * An HTML comment: GitHub renders nothing, so the reader never sees it, and a re-run can still find
 * its own issue by reading the body. A label alone would not do, since labels are shared by every
 * bump in the repository.
 */
export function marker(key: string): string {
  return `${MARKER_OPEN}${key}${MARKER_CLOSE}`;
}

export function keyFromBody(body: string): string | null {
  const start = body.indexOf(MARKER_OPEN);
  if (start === -1) return null;

  const from = start + MARKER_OPEN.length;
  const end = body.indexOf(MARKER_CLOSE, from);
  if (end === -1) return null;

  const found = body.slice(from, end).trim();
  return found.length > 0 ? found : null;
}

export function bodyCarriesKey(body: string, key: string): boolean {
  return keyFromBody(body) === key;
}
