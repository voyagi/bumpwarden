import type { SourceFile } from '../core/usage.js';
import type { MissingSource } from '../core/types.js';
import { fetchTextFile, fetchTree, type RepoRef } from '../io/github.js';
import type { RunFetcher } from '../io/http.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const SKIP_SEGMENTS = ['node_modules/', 'dist/', 'build/', 'coverage/', 'vendor/', '.min.'];

export interface SourceFileOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

const DEFAULT_MAX_FILES = 25;
const DEFAULT_MAX_FILE_BYTES = 200_000;

function isCandidate(path: string, size: number, maxFileBytes: number): boolean {
  if (size > maxFileBytes) return false;
  if (SKIP_SEGMENTS.some((segment) => path.includes(segment))) return false;
  return SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function depth(path: string): number {
  return path.split('/').length;
}

/**
 * The usage factor and the brief's evidence both need the consumer repository's own code, and a
 * run cannot clone it. This reads a bounded slice instead: the shallowest source files first, on
 * the assumption that a repository's entry points sit near the top. Anything left out is recorded
 * as a missing source, because a thin read that silently scores "unused" is the one wrong answer
 * this factor must not give.
 */
export async function collectSourceFiles(
  fetcher: RunFetcher,
  target: RepoRef,
  token: string | null = null,
  options: SourceFileOptions = {},
): Promise<{ files: SourceFile[]; missing: MissingSource[] }> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const missing: MissingSource[] = [];

  const tree = await fetchTree(fetcher, target, token);
  if (!tree.ok) {
    missing.push({ what: 'repository file list', why: `${tree.reason}: ${tree.detail}` });
    return { files: [], missing };
  }

  const candidates = tree.value.entries
    .filter((entry) => entry.type === 'blob' && isCandidate(entry.path, entry.size, maxFileBytes))
    .sort(
      (left, right) => depth(left.path) - depth(right.path) || left.path.localeCompare(right.path),
    );

  if (tree.value.truncated) {
    missing.push({
      what: 'repository file list',
      why: 'GitHub truncated the recursive tree, so some files were never considered',
    });
  }
  if (candidates.length > maxFiles) {
    missing.push({
      what: 'repository source files',
      why: `${candidates.length} source files found, ${maxFiles} read (per-run cap)`,
    });
  }

  const files: SourceFile[] = [];
  for (const entry of candidates.slice(0, maxFiles)) {
    const contents = await fetchTextFile(fetcher, target, entry.path, token);
    if (contents.ok) {
      files.push({ path: entry.path, text: contents.value });
      continue;
    }
    missing.push({ what: entry.path, why: `${contents.reason}: ${contents.detail}` });
  }

  return { files, missing };
}
