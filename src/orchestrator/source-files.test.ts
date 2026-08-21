import { describe, expect, it } from 'vitest';
import { RunFetcher } from '../io/http.js';
import { json, routedFetch, status, urlContains, type Route } from '../testkit/scripted-fetch.js';
import { collectSourceFiles } from './source-files.js';

const TARGET = { owner: 'demo', repo: 'app', ref: 'HEAD' };

interface Entry {
  path: string;
  type?: string;
  size?: number;
}

function treeRoute(entries: Entry[], truncated = false): Route {
  return {
    match: urlContains('/git/trees/'),
    step: json({
      truncated,
      tree: entries.map((entry) => ({
        path: entry.path,
        type: entry.type ?? 'blob',
        size: entry.size ?? 100,
      })),
    }),
  };
}

function contentRoute(): Route {
  return {
    match: urlContains('/contents/'),
    step: json({ content: Buffer.from('const a = 1;').toString('base64'), encoding: 'base64' }),
  };
}

function fetcherFor(routes: Route[]): RunFetcher {
  return new RunFetcher({ fetchImpl: routedFetch(routes).impl, sleep: async () => undefined });
}

describe('collecting a repository the run cannot clone', () => {
  it('reads the source files and skips everything that is not code', async () => {
    const fetcher = fetcherFor([
      treeRoute([
        { path: 'src/index.ts' },
        { path: 'README.md' },
        { path: 'dist/index.js' },
        { path: 'node_modules/express/index.js' },
        { path: 'public/app.min.js' },
        { path: 'src/routes', type: 'tree' },
      ]),
      contentRoute(),
    ]);

    const result = await collectSourceFiles(fetcher, TARGET);
    expect(result.files.map((file) => file.path)).toEqual(['src/index.ts']);
  });

  it('reads the shallowest files first, where entry points usually sit', async () => {
    const fetcher = fetcherFor([
      treeRoute([{ path: 'src/a/b/c/deep.ts' }, { path: 'index.ts' }, { path: 'src/app.ts' }]),
      contentRoute(),
    ]);

    const result = await collectSourceFiles(fetcher, TARGET, null, { maxFiles: 2 });
    expect(result.files.map((file) => file.path)).toEqual(['index.ts', 'src/app.ts']);
  });

  it('says how much of the repository it did not read', async () => {
    const fetcher = fetcherFor([
      treeRoute([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]),
      contentRoute(),
    ]);

    const result = await collectSourceFiles(fetcher, TARGET, null, { maxFiles: 1 });
    expect(result.files).toHaveLength(1);
    expect(result.missing[0]?.why).toContain('3 source files found, 1 read');
  });

  it('skips a file too large to be worth reading', async () => {
    const fetcher = fetcherFor([
      treeRoute([
        { path: 'huge.ts', size: 500_000 },
        { path: 'small.ts', size: 100 },
      ]),
      contentRoute(),
    ]);

    const result = await collectSourceFiles(fetcher, TARGET);
    expect(result.files.map((file) => file.path)).toEqual(['small.ts']);
  });

  it('records a truncated tree, because a short file list is not an empty repository', async () => {
    const fetcher = fetcherFor([treeRoute([{ path: 'a.ts' }], true), contentRoute()]);

    const result = await collectSourceFiles(fetcher, TARGET);
    expect(result.missing.some((entry) => entry.why.includes('truncated'))).toBe(true);
  });

  it('records a file it could not read and keeps the others', async () => {
    const fetcher = fetcherFor([
      treeRoute([{ path: 'a.ts' }, { path: 'b.ts' }]),
      { match: urlContains('/contents/a.ts'), step: status(404) },
      contentRoute(),
    ]);

    const result = await collectSourceFiles(fetcher, TARGET);
    expect(result.files.map((file) => file.path)).toEqual(['b.ts']);
    expect(result.missing[0]?.what).toBe('a.ts');
  });

  it('reports a file list it could not fetch at all rather than scoring the repository as unused', async () => {
    const fetcher = fetcherFor([{ match: urlContains('/git/trees/'), step: status(403) }]);

    const result = await collectSourceFiles(fetcher, TARGET);
    expect(result.files).toEqual([]);
    expect(result.missing[0]?.what).toBe('repository file list');
  });
});
