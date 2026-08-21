import semver from 'semver';

export type LockfileKind = 'npm' | 'pnpm' | 'yarn' | 'none';

export interface InstalledDependency {
  name: string;
  /** The exact version from the lockfile, or the range's floor when no lockfile could be read. */
  version: string;
  source: 'lockfile' | 'range-floor';
  range: string;
}

export interface ParsedManifest {
  engines: string | null;
  dependencies: Array<{ name: string; range: string }>;
}

export const LOCKFILES: Array<{ path: string; kind: LockfileKind }> = [
  { path: 'package-lock.json', kind: 'npm' },
  { path: 'pnpm-lock.yaml', kind: 'pnpm' },
  { path: 'yarn.lock', kind: 'yarn' },
];

interface ManifestJson {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface NpmLockJson {
  packages?: Record<string, { version?: string }>;
  dependencies?: Record<string, { version?: string }>;
}

export function parseManifest(text: string): ParsedManifest | null {
  let json: ManifestJson;
  try {
    json = JSON.parse(text) as ManifestJson;
  } catch {
    return null;
  }

  const merged = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) };
  return {
    engines: json.engines?.node ?? null,
    dependencies: Object.entries(merged).map(([name, range]) => ({ name, range })),
  };
}

/**
 * A range floor is a fallback, not an equivalent. `^4.18.2` installed today is probably 4.21.x, so
 * scoring the floor overstates the semver distance. Callers record which source was used and the
 * dashboard says so, rather than presenting a guess as a reading.
 */
export function rangeFloor(range: string): string | null {
  try {
    return semver.minVersion(range)?.version ?? null;
  } catch {
    return null;
  }
}

export function parseNpmLock(text: string): Map<string, string> {
  const installed = new Map<string, string>();
  let json: NpmLockJson;
  try {
    json = JSON.parse(text) as NpmLockJson;
  } catch {
    return installed;
  }

  for (const [path, entry] of Object.entries(json.packages ?? {})) {
    const marker = 'node_modules/';
    const at = path.lastIndexOf(marker);
    if (at === -1 || !entry.version) continue;
    installed.set(path.slice(at + marker.length), entry.version);
  }

  for (const [name, entry] of Object.entries(json.dependencies ?? {})) {
    if (entry.version && !installed.has(name)) installed.set(name, entry.version);
  }

  return installed;
}

export function resolveInstalled(
  manifest: ParsedManifest,
  locked: Map<string, string>,
): InstalledDependency[] {
  const resolved: InstalledDependency[] = [];

  for (const { name, range } of manifest.dependencies) {
    const exact = locked.get(name);
    if (exact) {
      resolved.push({ name, version: exact, source: 'lockfile', range });
      continue;
    }
    const floor = rangeFloor(range);
    if (floor) resolved.push({ name, version: floor, source: 'range-floor', range });
  }

  return resolved;
}
