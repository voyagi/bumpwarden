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
 * The four places a declared dependency's range lives. A package name can appear elsewhere in a
 * manifest beside a semver-looking string, under `overrides`, `resolutions`, `pnpm`, or another
 * tool's settings, and those are not this bump's to change.
 */
const DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

/**
 * Where the value of each top-level dependency section starts and ends. Found by walking the text
 * once rather than by searching for the key, because a nested object can carry the same key name
 * and a search would edit whichever came first. The walk skips the inside of string literals, so a
 * brace or a quote in a value cannot move the count.
 */
/** The index of the quote that closes the string opening at `from`, or the end of the text. */
function endOfString(text: string, from: number): number {
  for (let at = from + 1; at < text.length; at += 1) {
    if (text[at] === '\\') {
      at += 1;
      continue;
    }
    if (text[at] === '"') return at;
  }
  return text.length;
}

function dependencySpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let pendingKey: string | null = null;

  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];

    if (char === '"') {
      const closes = endOfString(text, at);
      // A string at the document's top level is a candidate key. Whether it really is one is
      // settled by whether a `{` follows it.
      if (depth === 1) pendingKey = text.slice(at + 1, closes);
      at = closes;
      continue;
    }

    if (char === '{') {
      depth += 1;
      if (depth === 2 && pendingKey !== null && DEPENDENCY_SECTIONS.has(pendingKey)) {
        spans.push([at, -1]);
      }
      pendingKey = null;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      const open = spans.at(-1);
      if (depth === 1 && open && open[1] === -1) open[1] = at + 1;
      continue;
    }

    // A colon or whitespace between the key and its value leaves the key standing. Anything else
    // at this level means the key belonged to a value that was not an object.
    if (depth === 1 && char !== ':' && !/\s/.test(char ?? '')) pendingKey = null;
  }

  return spans.filter(([, end]) => end !== -1);
}

/**
 * Edits the version string in place rather than reserializing the parsed manifest: a pull request
 * that also reindents package.json or reorders its keys is a pull request nobody reads. Anything
 * that is not a plain caret, tilde or exact semver range (a git url, `workspace:`, a dist-tag) is
 * left alone and reported as unsupported, because rewriting one of those is how a bump breaks an
 * install rather than fixing it.
 *
 * Only the declared dependency sections are touched. The same name beside a semver string under
 * `overrides`, `resolutions` or a tool's own settings is somebody's deliberate pin, and a pull
 * request that says it changes one dependency has no business moving it.
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

  const edit = (section: string): string =>
    section.replace(pattern, (whole, head: string, range: string, tail: string) => {
      const parsed = SUPPORTED_RANGE.exec(range.trim());
      if (!parsed) return whole;

      const next = `${parsed[1] ?? ''}${candidateVersion}`;
      from ??= range;
      to ??= next;
      occurrences += 1;
      return `${head}${next}${tail}`;
    });

  let text = '';
  let cursor = 0;
  for (const [start, end] of dependencySpans(manifestText)) {
    text += manifestText.slice(cursor, start) + edit(manifestText.slice(start, end));
    cursor = end;
  }
  text += manifestText.slice(cursor);

  if (from === null || to === null) return null;
  return { text, from, to, occurrences };
}
