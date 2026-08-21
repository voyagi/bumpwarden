import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { scoreBump } from './scorer.js';
import { BAND_THRESHOLDS, MAX_SCORE, POINTS, RUBRIC_VERSION, bandFor } from './rubric.js';
import type { AdvisorySeverity, CandidateBump, UsageMatch } from './types.js';

const NOW = new Date('2026-08-21T10:00:00Z');

function bump(overrides: Partial<CandidateBump> = {}): CandidateBump {
  return {
    dependency: 'example',
    currentVersion: '1.0.0',
    candidateVersion: '1.0.1',
    candidatePublishedAt: '2025-01-01T00:00:00Z',
    currentDeprecated: false,
    candidateDeprecated: false,
    advisories: [],
    candidateEngines: null,
    repoEngines: null,
    peerDependenciesChanged: false,
    usage: 'unused',
    usageSites: [],
    release: { notes: 'Routine maintenance.', notesSource: 'GitHub release', commitSubjects: [] },
    ...overrides,
  };
}

function points(result: ReturnType<typeof scoreBump>, id: string): number {
  const factor = result.factors.find((f) => f.id === id);
  if (!factor) throw new Error(`no factor ${id} in ${result.factors.map((f) => f.id).join(', ')}`);
  return factor.points;
}

describe('band boundaries', () => {
  const table: Array<[number, string]> = [
    [0, 'green'],
    [1, 'green'],
    [BAND_THRESHOLDS.greenMax, 'green'],
    [BAND_THRESHOLDS.greenMax + 1, 'amber'],
    [BAND_THRESHOLDS.amberMax, 'amber'],
    [BAND_THRESHOLDS.amberMax + 1, 'red'],
    [MAX_SCORE, 'red'],
  ];

  it.each(table)('a total of %i is %s', (total, expected) => {
    expect(bandFor(total)).toBe(expected);
  });
});

describe('semver distance factor', () => {
  const table: Array<[string, string, number, string]> = [
    ['1.0.0', '1.0.1', POINTS.semverPatch, 'patch scores nothing'],
    ['1.0.0', '1.4.0', POINTS.semverMinor, 'minor'],
    ['4.18.2', '5.2.1', POINTS.semverMajor, 'one major'],
    ['4.1.2', '6.0.0', POINTS.semverMajor + POINTS.semverPerExtraMajor, 'two majors'],
    ['8.1.0', '13.0.6', POINTS.semverMajorCap, 'five majors, capped'],
    ['0.4.0', '0.5.0', POINTS.semverMajor, '0.x minor is treated as breaking'],
    ['0.4.0', '0.4.1', POINTS.semverMinor, '0.x patch is treated as a minor'],
  ];

  it.each(table)('%s to %s scores %i (%s)', (currentVersion, candidateVersion, expected) => {
    const result = scoreBump(bump({ currentVersion, candidateVersion }), NOW);
    expect(points(result, 'semver')).toBe(expected);
  });
});

describe('release age factor', () => {
  const table: Array<[string, number]> = [
    ['2026-08-20T10:00:00Z', POINTS.ageUnder7Days],
    ['2026-08-16T10:00:00Z', POINTS.ageUnder7Days],
    ['2026-08-13T10:00:00Z', POINTS.age7To14Days],
    ['2026-08-07T09:00:00Z', POINTS.ageOver14Days],
    ['2025-12-01T00:00:00Z', POINTS.ageOver14Days],
  ];

  it.each(table)('published %s scores %i', (candidatePublishedAt, expected) => {
    const result = scoreBump(bump({ candidatePublishedAt }), NOW);
    expect(points(result, 'age')).toBe(expected);
  });

  it('records an unknown publish time as zero rather than guessing', () => {
    const result = scoreBump(bump({ candidatePublishedAt: 'not a date' }), NOW);
    expect(points(result, 'age')).toBe(0);
    expect(result.factors.find((f) => f.id === 'age')?.evidence).toContain('unknown');
  });
});

describe('evidence factors', () => {
  it('scores an explicit breaking marker above removal wording', () => {
    const explicit = scoreBump(
      bump({ release: { notes: '## Breaking changes', notesSource: 'x', commitSubjects: [] } }),
      NOW,
    );
    const softer = scoreBump(
      bump({
        release: { notes: 'dropped support for Node 16', notesSource: 'x', commitSubjects: [] },
      }),
      NOW,
    );

    expect(points(explicit, 'breaking-marker')).toBe(POINTS.breakingMarker);
    expect(points(softer, 'breaking-marker')).toBe(POINTS.removalWording);
    expect(points(explicit, 'breaking-marker')).toBeGreaterThan(points(softer, 'breaking-marker'));
  });

  it('reads a conventional commit bang as breaking', () => {
    const result = scoreBump(
      bump({
        release: { notes: null, notesSource: null, commitSubjects: ['feat(api)!: drop v1'] },
      }),
      NOW,
    );
    expect(points(result, 'breaking-marker')).toBe(POINTS.breakingMarker);
  });

  it('charges for release notes that could not be read', () => {
    const missing = scoreBump(
      bump({ release: { notes: null, notesSource: null, commitSubjects: [] } }),
      NOW,
    );
    expect(points(missing, 'notes-missing')).toBe(POINTS.notesUnavailable);
    expect(points(scoreBump(bump(), NOW), 'notes-missing')).toBe(0);
  });

  it('takes the worst advisory severity, not the count', () => {
    const one: AdvisorySeverity[] = ['high'];
    const many: AdvisorySeverity[] = ['low', 'moderate', 'low'];
    expect(points(scoreBump(bump({ advisories: one }), NOW), 'advisory')).toBe(
      POINTS.advisoryCriticalOrHigh,
    );
    expect(points(scoreBump(bump({ advisories: many }), NOW), 'advisory')).toBe(
      POINTS.advisoryModerateOrLow,
    );
  });

  it('charges more for a deprecated candidate than a deprecated installed version', () => {
    expect(points(scoreBump(bump({ currentDeprecated: true }), NOW), 'deprecation')).toBe(
      POINTS.currentDeprecated,
    );
    expect(
      points(
        scoreBump(bump({ candidateDeprecated: true, currentDeprecated: true }), NOW),
        'deprecation',
      ),
    ).toBe(POINTS.candidateDeprecated);
  });

  it('only charges for engines when the candidate raises the floor', () => {
    const raised = scoreBump(bump({ candidateEngines: '>=22', repoEngines: '>=18' }), NOW);
    const equal = scoreBump(bump({ candidateEngines: '>= 18', repoEngines: '>=18' }), NOW);
    const lowered = scoreBump(bump({ candidateEngines: '>=16', repoEngines: '>=18' }), NOW);

    expect(points(raised, 'engines')).toBe(POINTS.engineRangeRaised);
    expect(points(equal, 'engines')).toBe(0);
    expect(points(lowered, 'engines')).toBe(0);
  });
});

/**
 * These are the exact numbers published on the Policy and Project pages. If the rubric changes
 * without the published pages changing, this table goes red, which is the point of it.
 */
describe('the published demo queue', () => {
  const cases: Array<{ name: string; input: CandidateBump; total: number; band: string }> = [
    {
      name: 'glob 8.1.0 to 13.0.6',
      input: bump({
        dependency: 'glob',
        currentVersion: '8.1.0',
        candidateVersion: '13.0.6',
        candidatePublishedAt: '2026-02-19T00:00:00Z',
        currentDeprecated: true,
        usage: 'changed-symbol',
        usageSites: [
          { path: 'src/files.ts', line: 4, symbol: 'glob.sync', text: 'glob.sync(pattern)' },
        ],
        release: {
          notes: 'BREAKING CHANGE: the callback API was removed in v9.',
          notesSource: 'GitHub release',
          commitSubjects: [],
        },
      }),
      total: 87,
      band: 'red',
    },
    {
      name: 'chalk 4.1.2 to 6.0.0',
      input: bump({
        dependency: 'chalk',
        currentVersion: '4.1.2',
        candidateVersion: '6.0.0',
        candidatePublishedAt: '2026-07-26T00:00:00Z',
        candidateEngines: '>=22',
        repoEngines: '>=18',
        usage: 'changed-symbol',
        usageSites: [{ path: 'src/log.ts', line: 2, symbol: 'chalk', text: "require('chalk')" }],
        release: {
          notes: 'Breaking changes: this package is now pure ESM.',
          notesSource: 'GitHub release',
          commitSubjects: [],
        },
      }),
      total: 83,
      band: 'red',
    },
    {
      name: 'commander 11.1.0 to 15.0.0',
      input: bump({
        dependency: 'commander',
        currentVersion: '11.1.0',
        candidateVersion: '15.0.0',
        candidatePublishedAt: '2026-05-29T00:00:00Z',
        candidateEngines: '>=22.12.0',
        repoEngines: '>=18',
        usage: 'package-only',
        release: {
          notes: 'Removed the deprecated option parsing helpers.',
          notesSource: 'CHANGELOG.md',
          commitSubjects: [],
        },
      }),
      total: 74,
      band: 'red',
    },
    {
      name: 'express 4.18.2 to 5.2.1',
      input: bump({
        dependency: 'express',
        currentVersion: '4.18.2',
        candidateVersion: '5.2.1',
        candidatePublishedAt: '2025-12-01T00:00:00Z',
        candidateEngines: '>= 18',
        repoEngines: '>=18',
        usage: 'changed-symbol',
        usageSites: [
          {
            path: 'src/routes/files.ts',
            line: 18,
            symbol: 'res.sendfile',
            text: 'res.sendfile(p)',
          },
          { path: 'src/routes/docs.ts', line: 7, symbol: 'app.del', text: "app.del('/:id', h)" },
        ],
        release: {
          notes:
            '## Breaking changes\nThe `res.sendfile()` function has been replaced by a camel-cased version `res.sendFile()`. Express 5 no longer supports the `app.del()` function.',
          notesSource: 'expressjs.com migration guide',
          commitSubjects: [],
        },
      }),
      total: 62,
      band: 'red',
    },
    {
      name: 'node-fetch 2.7.0 to 3.3.2',
      input: bump({
        dependency: 'node-fetch',
        currentVersion: '2.7.0',
        candidateVersion: '3.3.2',
        candidatePublishedAt: '2023-07-25T00:00:00Z',
        usage: 'package-only',
        release: {
          notes: 'Breaking change: node-fetch is now an ESM only package.',
          notesSource: 'GitHub release',
          commitSubjects: [],
        },
      }),
      total: 50,
      band: 'amber',
    },
    {
      name: 'dotenv 16.4.5 to 17.4.2',
      input: bump({
        dependency: 'dotenv',
        currentVersion: '16.4.5',
        candidateVersion: '17.4.2',
        candidatePublishedAt: '2026-04-12T00:00:00Z',
        usage: 'package-only',
        release: {
          notes: 'Removed the implicit override behaviour.',
          notesSource: 'CHANGELOG.md',
          commitSubjects: [],
        },
      }),
      total: 44,
      band: 'amber',
    },
    {
      name: 'hono 4.13.1 to 4.13.3',
      input: bump({
        dependency: 'hono',
        currentVersion: '4.13.1',
        candidateVersion: '4.13.3',
        candidatePublishedAt: '2026-08-18T00:00:00Z',
        usage: 'unused',
        release: { notes: 'Bug fixes.', notesSource: 'GitHub release', commitSubjects: [] },
      }),
      total: 12,
      band: 'green',
    },
    {
      name: 'zod 4.4.2 to 4.4.3',
      input: bump({
        dependency: 'zod',
        currentVersion: '4.4.2',
        candidateVersion: '4.4.3',
        candidatePublishedAt: '2026-05-04T00:00:00Z',
        usage: 'unused',
        release: { notes: 'Bug fixes.', notesSource: 'GitHub release', commitSubjects: [] },
      }),
      total: 0,
      band: 'green',
    },
  ];

  it.each(cases)('$name scores $total, band $band', ({ input, total, band }) => {
    const result = scoreBump(input, NOW);
    expect(result.total).toBe(total);
    expect(result.band).toBe(band);
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
  });
});

const arbBump = fc.record({
  currentVersion: fc.constantFrom('0.4.0', '1.0.0', '2.3.4', '4.18.2', '11.1.0'),
  candidateVersion: fc.constantFrom('0.5.0', '1.0.1', '2.4.0', '5.2.1', '15.0.0'),
  candidatePublishedAt: fc.constantFrom(
    '2026-08-20T00:00:00Z',
    '2026-08-12T00:00:00Z',
    '2025-01-01T00:00:00Z',
  ),
  currentDeprecated: fc.boolean(),
  candidateDeprecated: fc.boolean(),
  advisories: fc.array(fc.constantFrom<AdvisorySeverity>('critical', 'high', 'moderate', 'low'), {
    maxLength: 3,
  }),
  candidateEngines: fc.constantFrom(null, '>=18', '>=22'),
  repoEngines: fc.constantFrom(null, '>=18'),
  peerDependenciesChanged: fc.boolean(),
  usage: fc.constantFrom<UsageMatch>('changed-symbol', 'package-only', 'unused'),
  notes: fc.constantFrom(null, 'Bug fixes.', 'Removed a helper.', '## Breaking changes'),
});

type ArbBump = typeof arbBump extends fc.Arbitrary<infer T> ? T : never;

function fromArb(parts: ArbBump): CandidateBump {
  return bump({
    ...parts,
    release: { notes: parts.notes, notesSource: parts.notes ? 'source' : null, commitSubjects: [] },
  });
}

describe('rubric invariants', () => {
  it('always produces an integer score inside the published range', () => {
    fc.assert(
      fc.property(arbBump, (parts) => {
        const result = scoreBump(fromArb(parts), NOW);
        expect(Number.isInteger(result.total)).toBe(true);
        expect(result.total).toBeGreaterThanOrEqual(0);
        expect(result.total).toBeLessThanOrEqual(MAX_SCORE);
      }),
    );
  });

  it('derives the band from the total and nothing else', () => {
    fc.assert(
      fc.property(arbBump, (parts) => {
        const result = scoreBump(fromArb(parts), NOW);
        expect(result.band).toBe(bandFor(result.total));
      }),
    );
  });

  it('is deterministic: the same evidence at the same instant scores the same', () => {
    fc.assert(
      fc.property(arbBump, (parts) => {
        const input = fromArb(parts);
        expect(scoreBump(input, NOW)).toEqual(scoreBump(input, NOW));
      }),
    );
  });

  it('never lowers the score when a breaking marker is added', () => {
    fc.assert(
      fc.property(arbBump, (parts) => {
        const without = fromArb({ ...parts, notes: 'Bug fixes.' });
        const withMarker = fromArb({ ...parts, notes: '## Breaking changes' });
        expect(scoreBump(withMarker, NOW).total).toBeGreaterThanOrEqual(
          scoreBump(without, NOW).total,
        );
      }),
    );
  });

  it('never raises the score as the candidate ages', () => {
    fc.assert(
      fc.property(arbBump, fc.integer({ min: 1, max: 400 }), (parts, extraDays) => {
        const input = fromArb(parts);
        const older = new Date(NOW.getTime() + extraDays * 86_400_000);
        expect(scoreBump(input, older).total).toBeLessThanOrEqual(scoreBump(input, NOW).total);
      }),
    );
  });

  it('never lowers the score when usage widens from unused to a changed symbol', () => {
    fc.assert(
      fc.property(arbBump, (parts) => {
        const unused = scoreBump(fromArb({ ...parts, usage: 'unused' }), NOW).total;
        const packageOnly = scoreBump(fromArb({ ...parts, usage: 'package-only' }), NOW).total;
        const changed = scoreBump(fromArb({ ...parts, usage: 'changed-symbol' }), NOW).total;
        expect(packageOnly).toBeGreaterThanOrEqual(unused);
        expect(changed).toBeGreaterThanOrEqual(packageOnly);
      }),
    );
  });

  it('names every factor it charged, so the locking table can be rendered from the score alone', () => {
    fc.assert(
      fc.property(arbBump, (parts) => {
        const result = scoreBump(fromArb(parts), NOW);
        const ids = result.factors.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const f of result.factors) {
          expect(f.points).toBeGreaterThanOrEqual(0);
          expect(f.evidence.length).toBeGreaterThan(0);
          expect(f.locks.length).toBeGreaterThan(0);
        }
      }),
    );
  });
});
