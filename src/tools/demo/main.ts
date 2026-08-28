import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ruleFor } from '../../core/policy.js';
import { scoreBump } from '../../core/scorer.js';
import type { Band } from '../../core/types.js';
import { RunFetcher, type FetchLike } from '../../io/http.js';
import { UNBOUNDED_FIELD_CAP, safeForTerminal } from '../../io/terminal.js';
import { ingestRepository } from '../../orchestrator/ingest.js';
import { collectSourceFiles } from '../../orchestrator/source-files.js';

/**
 * Proves the demo repository yields all three verdicts before it is published, and again whenever
 * an upstream release moves a score. Everything about the packages is read live from the npm
 * registry, deps.dev and the upstream GitHub repositories; only the watched repository's own files
 * are served from `demo/`, so this measures the same evidence a hosted run would.
 */

const DEMO_DIR = fileURLToPath(new URL('../../../demo/', import.meta.url));
const REPO = process.env.DEMO_REPO ?? 'voyagi/bumpwarden-demo-app';
const [owner = '', repo = ''] = REPO.split('/');
const API_PREFIX = `https://api.github.com/repos/${owner}/${repo}/`;
const SKIP = new Set(['node_modules', '.git']);

interface LocalFile {
  path: string;
  size: number;
}

function walk(dir: string, prefix = ''): LocalFile[] {
  const files: LocalFile[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      files.push(...walk(full, relative));
      continue;
    }
    files.push({ path: relative, size: statSync(full).size });
  }
  return files;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function localGitHub(files: LocalFile[]): FetchLike {
  const known = new Map(files.map((file) => [file.path, file]));

  return async (url, init) => {
    if (!url.startsWith(API_PREFIX)) return fetch(url, init);
    const route = url.slice(API_PREFIX.length);

    if (route.startsWith('git/trees/')) {
      return jsonResponse({
        truncated: false,
        tree: files.map((file) => ({ path: file.path, type: 'blob', size: file.size })),
      });
    }

    if (route.startsWith('contents/')) {
      const wanted = decodeURIComponent(route.slice('contents/'.length).split('?')[0] ?? '');
      if (!known.has(wanted)) return new Response('not found', { status: 404 });
      return jsonResponse({
        encoding: 'base64',
        content: readFileSync(path.join(DEMO_DIR, wanted)).toString('base64'),
      });
    }

    return new Response('not found', { status: 404 });
  };
}

const token = process.env.GITHUB_TOKEN ?? null;
const files = walk(DEMO_DIR);
const fetcher = new RunFetcher({ fetchImpl: localGitHub(files), budget: 500 });
const target = { owner, repo, ref: 'HEAD' };
const startedAt = Date.now();

const sources = await collectSourceFiles(fetcher, target, token);
const ingest = await ingestRepository(fetcher, target, {
  githubToken: token,
  sourceFiles: sources.files,
});

const now = new Date();
const scored = ingest.bumps
  .map((candidate) => ({ candidate, score: scoreBump(candidate, now) }))
  .sort((left, right) => right.score.total - left.score.total);

console.log(`${REPO}: ${files.length} files, ${ingest.dependenciesConsidered} dependencies read`);
console.log(`source files the usage matcher saw: ${sources.files.length}\n`);

for (const { candidate, score } of scored) {
  const move = safeForTerminal(
    `${candidate.dependency} ${candidate.currentVersion} -> ${candidate.candidateVersion}`,
    UNBOUNDED_FIELD_CAP,
  );
  console.log(`${String(score.total).padStart(3)} ${score.band.padEnd(5)} ${move}`);
  console.log(`    ${ruleFor(score.band).id}: ${ruleFor(score.band).kind}`);
  for (const factor of score.factors.filter((entry) => entry.points > 0)) {
    console.log(
      `    +${String(factor.points).padStart(2)} ${factor.id}: ${safeForTerminal(factor.evidence, UNBOUNDED_FIELD_CAP)}`,
    );
  }
}

const missing = [...sources.missing, ...ingest.missing];
if (missing.length > 0) {
  console.log(`\nsources recorded as missing (${missing.length}):`);
  for (const gap of missing)
    console.log(
      `    ${safeForTerminal(gap.what, UNBOUNDED_FIELD_CAP)}: ${safeForTerminal(gap.why, UNBOUNDED_FIELD_CAP)}`,
    );
}

const bands = new Set<Band>(scored.map((entry) => entry.score.band));
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const stats = fetcher.stats();
console.log(
  `\n${scored.length} bumps in ${seconds}s, ${stats.calls} calls (${stats.cacheHits} cached)`,
);

const absent = (['green', 'amber', 'red'] as Band[]).filter((band) => !bands.has(band));
if (absent.length > 0) {
  console.error(
    `\nFAIL: nothing scored ${absent.join(' or ')}. A run on the demo repository has to reach every` +
      ' band, or the demonstration shows one third of the policy. Repin a dependency in' +
      ' demo/package.json and run this again.',
  );
  process.exit(1);
}

console.log('PASS: green, amber and red are all present.');
