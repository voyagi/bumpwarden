import { describe, expect, it } from 'vitest';
import { DEMO } from '../testkit/fixtures.js';
import {
  actionIdFor,
  addCounts,
  countBands,
  projectSummaryFor,
  runIdFor,
  summarizeRepositories,
  totalBumps,
  worstBand,
  type BandCounts,
  type ProjectSummary,
  type RepositoryResult,
} from './records.js';
import type { Band } from './types.js';

describe('band counts', () => {
  it('counts each verdict', () => {
    expect(countBands(['green', 'red', 'green', 'amber'])).toEqual({ green: 2, amber: 1, red: 1 });
  });

  it('counts nothing as zeroes rather than as absent keys', () => {
    expect(countBands([])).toEqual({ green: 0, amber: 0, red: 0 });
  });

  it('adds two sets without mutating either', () => {
    const left = countBands(['green']);
    const right = countBands(['red']);
    expect(addCounts(left, right)).toEqual({ green: 1, amber: 0, red: 1 });
    expect(left).toEqual({ green: 1, amber: 0, red: 0 });
  });

  it('totals what a project page prints', () => {
    expect(totalBumps({ green: 2, amber: 3, red: 1 })).toBe(6);
  });
});

/** The badge Home prints beside every project, so each row of this table is a pixel on that page. */
describe('the band a project reads as overall', () => {
  const table: Array<[BandCounts, Band]> = [
    [{ green: 0, amber: 0, red: 0 }, 'green'],
    [{ green: 5, amber: 0, red: 0 }, 'green'],
    [{ green: 0, amber: 1, red: 0 }, 'amber'],
    [{ green: 9, amber: 2, red: 0 }, 'amber'],
    [{ green: 0, amber: 0, red: 1 }, 'red'],
    [{ green: 4, amber: 4, red: 1 }, 'red'],
  ];

  it.each(table)('%o reads as %s', (counts, expected) => {
    expect(worstBand(counts)).toBe(expected);
  });
});

describe('run and action ids', () => {
  it('derives a run id from the instant and the trigger', () => {
    const id = runIdFor(new Date('2026-08-21T06:00:00Z'), 'scheduled');
    expect(id).toBe('run-20260821T060000000Z-scheduled');
  });

  it('gives a manual run its own id at the same instant', () => {
    const at = new Date('2026-08-21T06:00:00Z');
    expect(runIdFor(at, 'manual')).not.toBe(runIdFor(at, 'scheduled'));
  });

  it('gives one action id per bump per run, so a retry cannot double-log', () => {
    expect(actionIdFor('run-1', 'demo/app#express@5.0.0')).toBe('run-1|demo/app#express@5.0.0');
  });
});

describe('project summaries', () => {
  it('starts a new project at zero', () => {
    const summary = projectSummaryFor(DEMO, null);
    expect(summary.counts).toEqual({ green: 0, amber: 0, red: 0 });
    expect(summary.lastRunId).toBeNull();
  });

  it('keeps what an earlier run wrote when the repository is re-registered', () => {
    const existing: ProjectSummary = {
      repository: DEMO,
      lastRunId: 'run-1',
      lastRunAt: '2026-08-20T06:00:00.000Z',
      lastRunStatus: 'finished',
      counts: { green: 1, amber: 2, red: 3 },
      actions: 4,
      worstScore: 87,
    };

    expect(projectSummaryFor(DEMO, existing)).toMatchObject({
      lastRunId: 'run-1',
      counts: { green: 1, amber: 2, red: 3 },
      actions: 4,
      worstScore: 87,
    });
  });
});

describe('the run aggregate', () => {
  const result = (over: Partial<RepositoryResult>): RepositoryResult => ({
    repositoryId: 'demo/app',
    dependenciesConsidered: 3,
    counts: { green: 0, amber: 0, red: 0 },
    actions: 0,
    missing: [],
    error: null,
    ...over,
  });

  it('sums the counts and the actions across repositories', () => {
    const summary = summarizeRepositories([
      result({ counts: { green: 1, amber: 0, red: 2 }, actions: 2 }),
      result({ repositoryId: 'demo/other', counts: { green: 0, amber: 3, red: 0 }, actions: 1 }),
    ]);

    expect(summary.counts).toEqual({ green: 1, amber: 3, red: 2 });
    expect(summary.actions).toBe(3);
  });

  it('sums an empty run to zero', () => {
    expect(summarizeRepositories([])).toEqual({
      counts: { green: 0, amber: 0, red: 0 },
      actions: 0,
    });
  });
});
