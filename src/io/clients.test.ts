import { describe, expect, it } from 'vitest';
import { RunFetcher } from './http.js';
import { fetchAdvisory, fetchVersionFacts, severityFromCvss } from './depsdev.js';
import {
  fetchPackument,
  githubRepoFrom,
  isValidPackageName,
  registryUrl,
  resolveCandidate,
} from './npm.js';
import {
  compareTags,
  compareVersions,
  fetchReleaseNotes,
  fetchTextFile,
  tagCandidates,
} from './github.js';
import { json, routedFetch, status, urlContains } from '../testkit/scripted-fetch.js';

const noSleep = () => Promise.resolve();
const TARGET = { owner: 'expressjs', repo: 'express', ref: 'main' };

function fetcherFor(routes: Parameters<typeof routedFetch>[0]) {
  const routed = routedFetch(routes);
  return { fetcher: new RunFetcher({ fetchImpl: routed.impl, sleep: noSleep }), urls: routed.urls };
}

describe('npm registry client', () => {
  it('escapes the slash in a scoped package name', () => {
    expect(registryUrl('express')).toBe('https://registry.npmjs.org/express');
    expect(registryUrl('@google/adk')).toBe('https://registry.npmjs.org/@google%2Fadk');
  });

  const repoUrls: Array<[string | null, { owner: string; repo: string } | null]> = [
    ['git+https://github.com/expressjs/express.git', { owner: 'expressjs', repo: 'express' }],
    ['https://github.com/sindresorhus/chalk', { owner: 'sindresorhus', repo: 'chalk' }],
    ['git+ssh://git@github.com/isaacs/node-glob.git', { owner: 'isaacs', repo: 'node-glob' }],
    ['https://gitlab.com/someone/thing', null],
    [null, null],
  ];

  it.each(repoUrls)('reads %s as %o', (url, expected) => {
    expect(githubRepoFrom(url)).toEqual(expected);
  });

  it('picks the highest stable version above the installed one', () => {
    const packument = {
      name: 'demo',
      distTags: { latest: '2.1.0' },
      versions: { '1.0.0': {}, '2.0.0': {}, '2.1.0': {}, '3.0.0-beta.1': {} },
      time: { '2.1.0': '2026-01-01T00:00:00Z' },
      repositoryUrl: null,
    };

    expect(resolveCandidate(packument, '1.0.0')).toMatchObject({
      version: '2.1.0',
      publishedAt: '2026-01-01T00:00:00Z',
    });
  });

  it('ignores prereleases and returns null when nothing is newer', () => {
    const packument = {
      name: 'demo',
      distTags: { latest: '1.0.0' },
      versions: { '1.0.0': {}, '2.0.0-rc.1': {} },
      time: {},
      repositoryUrl: null,
    };
    expect(resolveCandidate(packument, '1.0.0')).toBeNull();
  });

  it('flags a changed peer dependency range', () => {
    const packument = {
      name: 'demo',
      distTags: { latest: '2.0.0' },
      versions: {
        '1.0.0': { peerDependencies: { react: '^18' } },
        '2.0.0': { peerDependencies: { react: '^19' } },
      },
      time: {},
      repositoryUrl: null,
    };
    expect(resolveCandidate(packument, '1.0.0')?.peerRangeChanged).toBe(true);
  });

  const names: Array<[string, boolean]> = [
    ['express', true],
    ['@google/adk', true],
    ['node-fetch', true],
    ['a.b_c~d', true],
    ['.hidden', false],
    ['../../etc/passwd', false],
    ['express?foo=1', false],
    ['express/../glob', false],
    ['Express', false],
    ['', false],
  ];

  it.each(names)('treats %s as a valid npm name: %s', (name, expected) => {
    expect(isValidPackageName(name)).toBe(expected);
  });

  it('never puts an invalid dependency key into a url', async () => {
    const { fetcher, urls } = fetcherFor([]);

    const result = await fetchPackument(fetcher, '../../etc/passwd');

    expect(result).toMatchObject({ ok: false, reason: 'malformed' });
    expect(urls).toEqual([]);
  });

  it('reads dist-tags, engines and the repository out of a packument', async () => {
    const { fetcher } = fetcherFor([
      {
        match: urlContains('registry.npmjs.org/express'),
        step: json({
          'dist-tags': { latest: '5.2.1' },
          versions: { '5.2.1': { engines: { node: '>= 18' } } },
          time: { '5.2.1': '2025-12-01T00:00:00Z' },
          repository: { url: 'git+https://github.com/expressjs/express.git' },
        }),
      },
    ]);

    const result = await fetchPackument(fetcher, 'express');

    expect(result.ok && result.value.distTags.latest).toBe('5.2.1');
    expect(result.ok && result.value.repositoryUrl).toContain('expressjs/express');
  });
});

describe('deps.dev client', () => {
  const bands: Array<[number | null, string]> = [
    [9.8, 'critical'],
    [9, 'critical'],
    [8.1, 'high'],
    [7, 'high'],
    [5, 'moderate'],
    [4, 'moderate'],
    [3.9, 'low'],
    [0.1, 'low'],
    [null, 'moderate'],
  ];

  it.each(bands)('a cvss3 score of %s is %s', (score, expected) => {
    expect(severityFromCvss(score)).toBe(expected);
  });

  it('maps a version response to the facts the scorer needs', async () => {
    const { fetcher } = fetcherFor([
      {
        match: urlContains('/versions/8.1.0'),
        step: json({
          publishedAt: '2023-01-14T22:35:33Z',
          isDeprecated: true,
          deprecatedReason: 'Glob versions prior to v9 are no longer supported',
          advisoryKeys: [{ id: 'GHSA-qw6h-vgh9-j6wx' }],
        }),
      },
    ]);

    const facts = await fetchVersionFacts(fetcher, 'glob', '8.1.0');

    expect(facts.ok && facts.value).toMatchObject({
      publishedAt: '2023-01-14T22:35:33Z',
      isDeprecated: true,
      advisoryIds: ['GHSA-qw6h-vgh9-j6wx'],
    });
  });

  it('derives an advisory severity from its cvss score', async () => {
    const { fetcher } = fetcherFor([
      {
        match: urlContains('/advisories/'),
        step: json({
          advisoryKey: { id: 'GHSA-qw6h-vgh9-j6wx' },
          url: 'https://osv.dev/vulnerability/GHSA-qw6h-vgh9-j6wx',
          title: 'express vulnerable to XSS via response.redirect()',
          cvss3Score: 5,
        }),
      },
    ]);

    const advisory = await fetchAdvisory(fetcher, 'GHSA-qw6h-vgh9-j6wx');

    expect(advisory.ok && advisory.value.severity).toBe('moderate');
    expect(advisory.ok && advisory.value.url).toContain('osv.dev');
  });
});

/** The exact tag ranges a set of request urls asked GitHub to compare. */
function comparesIn(urls: string[]): Set<string> {
  const marker = '/compare/';
  return new Set(
    urls
      .filter((url) => url.includes(marker))
      .map((url) => url.slice(url.indexOf(marker) + marker.length)),
  );
}

describe('github client', () => {
  it('tries both tag spellings before recording a miss', async () => {
    const { fetcher, urls } = fetcherFor([]);

    const result = await fetchReleaseNotes(fetcher, TARGET, '5.2.1');

    expect(tagCandidates('5.2.1')).toEqual(['v5.2.1', '5.2.1']);
    expect(urls.some((u) => u.includes('/tags/v5.2.1'))).toBe(true);
    expect(urls.some((u) => u.includes('/tags/5.2.1'))).toBe(true);
    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('accepts the unprefixed tag when the prefixed one is missing', async () => {
    const { fetcher } = fetcherFor([
      {
        match: urlContains('/tags/5.2.1'),
        step: json({ body: '## Breaking changes', html_url: 'https://github.test/r' }),
      },
    ]);

    const result = await fetchReleaseNotes(fetcher, TARGET, '5.2.1');

    expect(result.ok && result.value.body).toBe('## Breaking changes');
  });

  it('treats an empty release body as no notes rather than as notes', async () => {
    const { fetcher } = fetcherFor([{ match: urlContains('/tags/'), step: json({ body: '   ' }) }]);

    expect(await fetchReleaseNotes(fetcher, TARGET, '5.2.1')).toMatchObject({ ok: false });
  });

  it('decodes base64 file contents', async () => {
    const { fetcher } = fetcherFor([
      {
        match: urlContains('/contents/package.json'),
        step: json({ content: Buffer.from('{"name":"x"}').toString('base64'), encoding: 'base64' }),
      },
    ]);

    const result = await fetchTextFile(fetcher, TARGET, 'package.json');

    expect(result.ok && result.value).toBe('{"name":"x"}');
  });

  it('reports an unexpected content encoding as malformed', async () => {
    const { fetcher } = fetcherFor([
      { match: urlContains('/contents/'), step: json({ content: 'plain', encoding: 'utf-8' }) },
    ]);

    expect(await fetchTextFile(fetcher, TARGET, 'package.json')).toMatchObject({
      reason: 'malformed',
    });
  });

  it('reduces a compare to commit subjects and changed files', async () => {
    const { fetcher } = fetcherFor([
      {
        match: urlContains('/compare/'),
        step: json({
          total_commits: 2,
          commits: [
            { commit: { message: 'feat(api)!: drop v1\n\nlong body' } },
            { commit: { message: 'chore: bump deps' } },
          ],
          files: [{ filename: 'lib/router.js' }],
        }),
      },
    ]);

    const result = await compareTags(fetcher, TARGET, 'v4.18.2', 'v5.2.1');

    expect(result.ok && result.value).toEqual({
      totalCommits: 2,
      commitSubjects: ['feat(api)!: drop v1', 'chore: bump deps'],
      changedFiles: ['lib/router.js'],
    });
  });

  it('passes the failure through when GitHub is unavailable', async () => {
    const { fetcher } = fetcherFor([{ match: urlContains('/compare/'), step: status(500) }]);

    expect(await compareTags(fetcher, TARGET, 'a', 'b')).toMatchObject({ ok: false });
  });

  /**
   * express, body-parser and prisma all tag without the `v`, and a live run lost the commit
   * subjects for five bumps out of eight before the compare tried the second spelling.
   */
  it('compares on the unprefixed tags when the prefixed pair is missing', async () => {
    const { fetcher, urls } = fetcherFor([
      {
        match: urlContains('/compare/4.18.2...5.2.1'),
        step: json({ total_commits: 1, commits: [{ commit: { message: 'fix: a thing' } }] }),
      },
    ]);

    const result = await compareVersions(fetcher, TARGET, '4.18.2', '5.2.1');

    expect(urls.some((u) => u.includes('/compare/v4.18.2...v5.2.1'))).toBe(true);
    expect(result.ok && result.value.commitSubjects).toEqual(['fix: a thing']);
  });

  it('never mixes the two spellings across one compare', async () => {
    const { fetcher, urls } = fetcherFor([]);

    await compareVersions(fetcher, TARGET, '4.18.2', '5.2.1');

    // Compared as a set of exact ranges: "v4.18.2...v5.2.1" contains the substring
    // "4.18.2...v5.2.1", so a contains check here would pass on a mixed pair it should catch.
    expect(comparesIn(urls)).toEqual(new Set(['v4.18.2...v5.2.1', '4.18.2...5.2.1']));
  });

  it('records a miss once, naming both spellings, rather than one per attempt', async () => {
    const { fetcher } = fetcherFor([]);

    expect(await compareVersions(fetcher, TARGET, '4.18.2', '5.2.1')).toMatchObject({
      ok: false,
      reason: 'not-found',
      detail: 'no compare between 4.18.2 and 5.2.1 under either tag spelling',
    });
  });

  it('stops at the first spelling when GitHub itself is failing', async () => {
    const { fetcher, urls } = fetcherFor([{ match: urlContains('/compare/'), step: status(500) }]);

    expect(await compareVersions(fetcher, TARGET, '4.18.2', '5.2.1')).toMatchObject({ ok: false });
    // Retries of the same range collapse into one entry, so this asserts the second spelling was
    // never reached rather than counting requests.
    expect(comparesIn(urls)).toEqual(new Set(['v4.18.2...v5.2.1']));
  });
});
