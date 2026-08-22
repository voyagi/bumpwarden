import { describe, expect, it } from 'vitest';
import { RunFetcher } from '../io/http.js';
import { scoreBump } from '../core/scorer.js';
import { ingestRepository } from './ingest.js';
import { parseManifest, parseNpmLock, rangeFloor, resolveInstalled } from './manifest.js';
import {
  json,
  routedFetch,
  status,
  text,
  urlContains,
  type Route,
} from '../testkit/scripted-fetch.js';

const NOW = new Date('2026-08-21T10:00:00Z');
const TARGET = { owner: 'voyagi', repo: 'bumpwarden-demo-app', ref: 'main' };

const MANIFEST = {
  name: 'bumpwarden-demo-app',
  engines: { node: '>=18' },
  dependencies: { express: '^4.18.2' },
};

const LOCK = {
  lockfileVersion: 3,
  packages: { '': { name: 'bumpwarden-demo-app' }, 'node_modules/express': { version: '4.18.2' } },
};

const EXPRESS_NOTES = [
  '## Breaking changes',
  'The `res.sendfile()` function has been replaced by a camel-cased version `res.sendFile()`.',
  'Express 5 no longer supports the `app.del()` function.',
].join('\n');

const ROUTE_FILE = {
  path: 'src/routes/files.ts',
  text: [
    "import express from 'express';",
    '',
    'router.get("/:name", (req, res) => {',
    '  res.sendfile(p);',
    '});',
  ].join('\n'),
};

function base64(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
}

function contents(value: unknown) {
  return json({ content: base64(value), encoding: 'base64' });
}

function happyRoutes(): Route[] {
  return [
    { match: urlContains('/contents/package.json'), step: contents(MANIFEST) },
    { match: urlContains('/contents/package-lock.json'), step: contents(LOCK) },
    {
      match: urlContains('registry.npmjs.org/express'),
      step: json({
        'dist-tags': { latest: '5.2.1' },
        versions: {
          '4.18.2': { engines: { node: '>= 0.10.0' } },
          '5.2.1': { engines: { node: '>= 18' } },
        },
        time: { '4.18.2': '2022-10-08T20:14:32Z', '5.2.1': '2025-12-01T00:00:00Z' },
        repository: { url: 'git+https://github.com/expressjs/express.git' },
      }),
    },
    {
      match: urlContains('/packages/express/versions/5.2.1'),
      step: json({ publishedAt: '2025-12-01T00:00:00Z', isDeprecated: false, advisoryKeys: [] }),
    },
    {
      match: urlContains('/packages/express/versions/4.18.2'),
      step: json({ publishedAt: '2022-10-08T20:14:32Z', isDeprecated: false, advisoryKeys: [] }),
    },
    {
      match: urlContains('/releases/tags/v5.2.1'),
      step: json({
        body: EXPRESS_NOTES,
        html_url: 'https://github.com/expressjs/express/releases',
      }),
    },
    {
      match: urlContains('/compare/'),
      step: json({
        total_commits: 1,
        commits: [{ commit: { message: 'chore: release 5.2.1' } }],
        files: [],
      }),
    },
  ];
}

function fetcherWith(routes: Route[], budget = 300, maxBytes?: number) {
  const routed = routedFetch(routes);
  return {
    fetcher: new RunFetcher({
      fetchImpl: routed.impl,
      sleep: () => Promise.resolve(),
      budget,
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }),
    urls: routed.urls,
  };
}

describe('manifest and lockfile parsing', () => {
  it('merges dependencies and devDependencies and reads the engines floor', () => {
    const parsed = parseManifest(
      JSON.stringify({
        engines: { node: '>=18' },
        dependencies: { a: '^1' },
        devDependencies: { b: '~2' },
      }),
    );
    expect(parsed?.engines).toBe('>=18');
    expect(parsed?.dependencies).toEqual([
      { name: 'a', range: '^1' },
      { name: 'b', range: '~2' },
    ]);
  });

  it('returns null on a manifest that is not JSON rather than throwing', () => {
    expect(parseManifest('{ not json')).toBeNull();
  });

  it('reads exact versions out of a v3 lockfile, keyed by the nested path', () => {
    const installed = parseNpmLock(
      JSON.stringify({
        packages: {
          '': {},
          'node_modules/express': { version: '4.18.2' },
          'node_modules/a/node_modules/b': { version: '1.2.3' },
        },
      }),
    );
    expect(installed.get('express')).toBe('4.18.2');
    expect(installed.get('b')).toBe('1.2.3');
  });

  it('keeps the hoisted version when a dependency also nests an older copy of the same package', () => {
    const installed = parseNpmLock(
      JSON.stringify({
        packages: {
          '': {},
          'node_modules/body-parser': { version: '1.20.2' },
          'node_modules/express': { version: '4.17.1' },
          'node_modules/express/node_modules/body-parser': { version: '1.19.0' },
        },
      }),
    );
    expect(installed.get('body-parser')).toBe('1.20.2');
  });

  it('keeps a scoped package nested under another one out of the hoisted slot', () => {
    const installed = parseNpmLock(
      JSON.stringify({
        packages: {
          '': {},
          'node_modules/@scope/pkg': { version: '2.0.0' },
          'node_modules/tool/node_modules/@scope/pkg': { version: '1.0.0' },
        },
      }),
    );
    expect(installed.get('@scope/pkg')).toBe('2.0.0');
  });

  it('falls back to the range floor and says so when the lockfile is unreadable', () => {
    const manifest = { engines: null, dependencies: [{ name: 'express', range: '^4.18.2' }] };
    expect(rangeFloor('^4.18.2')).toBe('4.18.2');
    expect(resolveInstalled(manifest, new Map())).toEqual([
      { name: 'express', version: '4.18.2', source: 'range-floor', range: '^4.18.2' },
    ]);
  });
});

describe('ingestRepository', () => {
  it('assembles a bump whose score matches the published rubric', async () => {
    const { fetcher } = fetcherWith(happyRoutes());

    const result = await ingestRepository(fetcher, TARGET, { sourceFiles: [ROUTE_FILE] });

    expect(result.lockfile).toBe('npm');
    expect(result.repoEngines).toBe('>=18');
    expect(result.bumps).toHaveLength(1);

    const bump = result.bumps[0];
    expect(bump).toMatchObject({
      dependency: 'express',
      currentVersion: '4.18.2',
      candidateVersion: '5.2.1',
      candidatePublishedAt: '2025-12-01T00:00:00Z',
      candidateEngines: '>= 18',
      repoEngines: '>=18',
      usage: 'changed-symbol',
    });
    expect(bump?.usageSites.map((site) => site.symbol)).toContain('res.sendfile');

    const score = scoreBump(bump!, NOW);
    expect(score.total).toBe(62);
    expect(score.band).toBe('red');
  });

  it('records a missing changelog instead of failing the run', async () => {
    const routes = happyRoutes().filter((route) => !route.match('/releases/tags/v5.2.1'));
    const { fetcher } = fetcherWith(routes);

    const result = await ingestRepository(fetcher, TARGET, { sourceFiles: [ROUTE_FILE] });

    expect(result.bumps).toHaveLength(1);
    expect(result.bumps[0]?.release.notes).toBeNull();
    expect(result.missing.map((m) => m.what)).toContain('express release notes');
  });

  /**
   * `prisma` and `@prisma/client` have packuments of 44 and 68 MB, so the cap that protects the
   * container refused both and two dependencies of a real project got no score at all. The same
   * facts come out of two version documents of a few KB each, and the score must not move.
   */
  it('scores a dependency whose packument is over the cap the same from its version documents', async () => {
    const routes = happyRoutes().filter((route) => !route.match('registry.npmjs.org/express'));
    routes.unshift(
      {
        match: urlContains('registry.npmjs.org/express/latest'),
        step: json({
          version: '5.2.1',
          engines: { node: '>= 18' },
          repository: { url: 'git+https://github.com/expressjs/express.git' },
        }),
      },
      {
        match: urlContains('registry.npmjs.org/express/4.18.2'),
        step: json({ version: '4.18.2', engines: { node: '>= 0.10.0' } }),
      },
      { match: (url) => url.endsWith('registry.npmjs.org/express'), step: text('x'.repeat(4_000)) },
    );
    const { fetcher } = fetcherWith(routes, 300, 1_000);

    const result = await ingestRepository(fetcher, TARGET, { sourceFiles: [ROUTE_FILE] });

    expect(result.bumps).toHaveLength(1);
    expect(result.bumps[0]).toMatchObject({
      dependency: 'express',
      candidateVersion: '5.2.1',
      candidatePublishedAt: '2025-12-01T00:00:00Z',
      candidateEngines: '>= 18',
      peerDependenciesChanged: false,
    });
    expect(result.bumps[0]?.release.notes).toBe(EXPRESS_NOTES);
    expect(scoreBump(result.bumps[0]!, NOW).total).toBe(62);
    expect(result.missing).toEqual([
      { what: 'express version list', why: expect.stringContaining('size cap') },
    ]);
  });

  it('still charges for a deprecated installed version when deps.dev is unavailable', async () => {
    const routes = happyRoutes().filter(
      (route) => !route.match('/packages/express/versions/4.18.2'),
    );
    const registry = routes.find((route) => route.match('registry.npmjs.org/express'));
    routes[routes.indexOf(registry!)] = {
      match: urlContains('registry.npmjs.org/express'),
      step: json({
        'dist-tags': { latest: '5.2.1' },
        versions: {
          '4.18.2': { deprecated: 'no longer supported' },
          '5.2.1': { engines: { node: '>= 18' } },
        },
        time: { '5.2.1': '2025-12-01T00:00:00Z' },
        repository: { url: 'git+https://github.com/expressjs/express.git' },
      }),
    };
    const { fetcher } = fetcherWith(routes);

    const result = await ingestRepository(fetcher, TARGET, { sourceFiles: [ROUTE_FILE] });

    expect(result.bumps[0]?.currentDeprecated).toBe(true);
  });

  it('says so when a lockfile is read but yields nothing', async () => {
    const routes = happyRoutes().filter((route) => !route.match('/contents/package-lock.json'));
    routes.push({
      match: urlContains('/contents/package-lock.json'),
      step: contents({ packages: {} }),
    });
    const { fetcher } = fetcherWith(routes);

    const result = await ingestRepository(fetcher, TARGET, { sourceFiles: [] });

    expect(result.lockfile).toBe('npm');
    expect(result.missing.some((m) => m.why.includes('yielded no versions'))).toBe(true);
  });

  it('records an unsupported lockfile and falls back to the range floor', async () => {
    const routes = happyRoutes().filter((route) => !route.match('/contents/package-lock.json'));
    routes.push({
      match: urlContains('/contents/pnpm-lock.yaml'),
      step: contents('lockfileVersion: 9'),
    });
    const { fetcher } = fetcherWith(routes);

    const result = await ingestRepository(fetcher, TARGET, { sourceFiles: [] });

    expect(result.lockfile).toBe('pnpm');
    expect(result.missing.map((m) => m.what)).toContain('pnpm-lock.yaml');
    expect(result.bumps[0]?.currentVersion).toBe('4.18.2');
  });

  it('stops with an empty result and a recorded reason when the manifest is unreachable', async () => {
    const { fetcher } = fetcherWith([
      { match: urlContains('/contents/package.json'), step: status(404) },
    ]);

    const result = await ingestRepository(fetcher, TARGET);

    expect(result.bumps).toEqual([]);
    expect(result.missing[0]).toMatchObject({ what: 'package.json' });
  });

  it('degrades to a scored bump when the run budget runs out mid-way', async () => {
    const { fetcher } = fetcherWith(happyRoutes(), 4);

    const result = await ingestRepository(fetcher, TARGET, { sourceFiles: [ROUTE_FILE] });

    expect(fetcher.stats().budgetRemaining).toBe(0);
    expect(result.missing.some((m) => m.why.includes('budget'))).toBe(true);
  });

  it('fetches each url once per run', async () => {
    const { fetcher, urls } = fetcherWith(happyRoutes());

    await ingestRepository(fetcher, TARGET, { sourceFiles: [ROUTE_FILE] });

    expect(new Set(urls).size).toBe(urls.length);
    expect(fetcher.stats().calls).toBe(urls.length);
  });
});
