import { BRIEF_SCHEMA_VERSION, briefCacheKey, type BriefRecord } from '../core/brief.js';
import { bumpKey } from '../core/bump-key.js';
import type { BumpSummary } from '../core/issue-body.js';
import type { WatchedRepository } from '../core/records.js';
import { RUBRIC_VERSION } from '../core/rubric.js';
import { scoreBump } from '../core/scorer.js';
import type { CandidateBump, Score } from '../core/types.js';

export const DEMO: WatchedRepository = {
  id: 'demo/app',
  owner: 'demo',
  repo: 'app',
  ref: 'HEAD',
  demo: true,
};

export const NOW = new Date('2026-08-21T10:00:00Z');

export const EXPRESS_NOTES = [
  '## Express 5.0.0',
  '',
  'The `res.sendfile()` function has been replaced by a camel-cased version `res.sendFile()`.',
  'Express 5 no longer supports the `app.del()` function.',
].join('\n');

export function candidateBump(overrides: Partial<CandidateBump> = {}): CandidateBump {
  return {
    dependency: 'express',
    currentVersion: '4.18.2',
    candidateVersion: '5.0.0',
    candidatePublishedAt: '2025-09-10T00:00:00Z',
    currentDeprecated: false,
    candidateDeprecated: false,
    advisories: [],
    candidateEngines: null,
    repoEngines: null,
    peerDependenciesChanged: false,
    usage: 'changed-symbol',
    usageSites: [
      {
        path: 'src/routes/files.ts',
        line: 18,
        symbol: 'res.sendfile',
        text: 'return res.sendfile(target);',
      },
    ],
    release: {
      notes: EXPRESS_NOTES,
      notesSource: 'https://github.com/expressjs/express/releases/tag/v5.0.0',
      commitSubjects: ['feat!: remove res.sendfile'],
      changedFiles: ['lib/response.js'],
    },
    ...overrides,
  };
}

export function scoreOf(bump: CandidateBump = candidateBump(), at: Date = NOW): Score {
  return scoreBump(bump, at);
}

export function summaryOf(
  bump: CandidateBump = candidateBump(),
  repository: WatchedRepository = DEMO,
): BumpSummary {
  return {
    key: bumpKey({
      owner: repository.owner,
      repo: repository.repo,
      dependency: bump.dependency,
      candidateVersion: bump.candidateVersion,
    }),
    repositoryId: repository.id,
    dependency: bump.dependency,
    currentVersion: bump.currentVersion,
    candidateVersion: bump.candidateVersion,
  };
}

export function readyBrief(overrides: Partial<BriefRecord> = {}): BriefRecord {
  const key = summaryOf().key;
  return {
    cacheKey: briefCacheKey(key, RUBRIC_VERSION),
    bumpKey: key,
    status: 'ready',
    model: 'gemini-3.5-flash',
    rubricVersion: RUBRIC_VERSION,
    schemaVersion: BRIEF_SCHEMA_VERSION,
    generatedAt: NOW.toISOString(),
    attempts: 1,
    truncated: false,
    droppedClaims: 0,
    reason: null,
    content: {
      headline: 'Two removed methods are called in your routes',
      whatChanged: 'Express 5 drops methods Express 4 accepted.',
      breakingChanges: ['res.sendfile is now res.sendFile'],
      breaksHere: [
        {
          path: 'src/routes/files.ts',
          line: 18,
          symbol: 'res.sendfile',
          quote: 'The `res.sendfile()` function has been replaced by a camel-cased version',
          source: 'https://expressjs.com/en/guide/migrating-5.html',
          verified: true,
        },
      ],
      migrationSteps: ['Rename res.sendfile to res.sendFile on line 18.'],
      confidence: 'high',
    },
    ...overrides,
  };
}

export const MANIFEST_JSON = JSON.stringify(
  {
    name: 'demo-app',
    dependencies: { express: '^4.18.2', hono: '4.13.2' },
    devDependencies: { vitest: '~4.1.10' },
  },
  null,
  2,
);
