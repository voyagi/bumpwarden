export interface ManifestEdit {
  text: string;
  from: string;
  to: string;
  occurrences: number;
}

const SUPPORTED_RANGE = /^([\^~]?)(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/;

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Edits the version string in place rather than reserializing the parsed manifest: a pull request
 * that also reindents package.json or reorders its keys is a pull request nobody reads. Anything
 * that is not a plain caret, tilde or exact semver range (a git url, `workspace:`, a dist-tag) is
 * left alone and reported as unsupported, because rewriting one of those is how a bump breaks an
 * install rather than fixing it.
 */
export function bumpManifestRange(
  manifestText: string,
  dependency: string,
  candidateVersion: string,
): ManifestEdit | null {
  const pattern = new RegExp(`("${escapeForRegex(dependency)}"\\s*:\\s*")([^"]+)(")`, 'g');

  let from: string | null = null;
  let to: string | null = null;
  let occurrences = 0;

  const text = manifestText.replace(pattern, (whole, head: string, range: string, tail: string) => {
    const parsed = SUPPORTED_RANGE.exec(range.trim());
    if (!parsed) return whole;

    const next = `${parsed[1] ?? ''}${candidateVersion}`;
    from ??= range;
    to ??= next;
    occurrences += 1;
    return `${head}${next}${tail}`;
  });

  if (from === null || to === null) return null;
  return { text, from, to, occurrences };
}
