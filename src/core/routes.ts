/**
 * Dashboard paths live here so that a link written into a GitHub issue and the route the dashboard
 * serves cannot drift apart. An issue is permanent; a link inside it that stops resolving is worse
 * than no link at all.
 */
export function projectPath(repositoryId: string): string {
  return `/projects/${encodeURIComponent(repositoryId)}`;
}

/**
 * Constructs the dashboard path for viewing a specific bump.
 */
export function bumpPath(repositoryId: string, bumpKey: string): string {
  return `${projectPath(repositoryId)}/bumps/${encodeURIComponent(bumpKey)}`;
}

/**
 * Converts a relative path to an absolute URL by prepending the base URL.
 * Returns null if no base URL is provided.
 */
export function absoluteUrl(baseUrl: string | null, path: string): string | null {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}
