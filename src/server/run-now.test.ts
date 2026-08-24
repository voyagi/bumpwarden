import { describe, expect, it } from 'vitest';
import type { WatchedRepository } from '../core/records.js';
import { runRecord } from '../testkit/fixtures.js';
import { RUN_NOW_COOLDOWN_MS, runNowStatus } from './run-now.js';

const DEMO: WatchedRepository = {
  id: 'voyagi/demo-app',
  owner: 'voyagi',
  repo: 'demo-app',
  ref: 'main',
  demo: true,
};

const PRIVATE: WatchedRepository = { ...DEMO, id: 'voyagi/other', repo: 'other', demo: false };

const NOW = new Date('2026-08-21T06:30:00Z');

function manualRun(over: Parameters<typeof runRecord>[0] = {}) {
  return runRecord({
    id: 'run-manual',
    trigger: 'manual',
    scope: DEMO.id,
    startedAt: '2026-08-21T06:26:00.000Z',
    finishedAt: '2026-08-21T06:28:00.000Z',
    repositories: [],
    ...over,
  });
}

describe('the Run now control', () => {
  it('is closed on a project that is not the demo one', () => {
    const status = runNowStatus(PRIVATE, [], NOW);
    expect(status.state).toBe('unavailable');
    expect(status.message).toContain('demo project only');
  });

  it('is closed when the project does not exist at all', () => {
    expect(runNowStatus(null, [], NOW).state).toBe('unavailable');
  });

  it('is ready on the demo project with no history', () => {
    const status = runNowStatus(DEMO, [], NOW);
    expect(status.state).toBe('ready');
    expect(status.message).toContain('No run has covered this project yet.');
  });

  it('reports a run of its own that is still going, with the elapsed time', () => {
    const running = runRecord({
      status: 'running',
      scope: DEMO.id,
      startedAt: '2026-08-21T06:29:30.000Z',
      finishedAt: null,
      repositories: [],
    });
    const status = runNowStatus(DEMO, [running], NOW);
    expect(status.state).toBe('running');
    expect(status.elapsedSeconds).toBe(30);
  });

  it('counts a whole-watch-list run as busy for this project too', () => {
    // A scheduled run has no scope and covers everything, so pressing the button during one would
    // start a second run over the same repository.
    const running = runRecord({
      status: 'running',
      scope: null,
      finishedAt: null,
      repositories: [],
    });
    expect(runNowStatus(DEMO, [running], NOW).state).toBe('running');
  });

  it('does not count another project scoped run as busy', () => {
    const running = runRecord({
      status: 'running',
      scope: 'voyagi/somewhere-else',
      finishedAt: null,
      repositories: [],
    });
    expect(runNowStatus(DEMO, [running], NOW).state).toBe('ready');
  });

  it('cools down after a manual run and says how long is left', () => {
    // Finished at 06:28, asked at 06:30, so two of the five cooldown minutes are already spent.
    const status = runNowStatus(DEMO, [manualRun()], NOW);
    expect(status.state).toBe('cooling');
    expect(status.retryAfterSeconds).toBe(RUN_NOW_COOLDOWN_MS / 1000 - 120);
    expect(status.message).toContain('available again in 3m 0s');
  });

  it('opens again the moment the cooldown has elapsed', () => {
    const finishedAt = new Date(NOW.getTime() - RUN_NOW_COOLDOWN_MS).toISOString();
    const status = runNowStatus(DEMO, [manualRun({ finishedAt })], NOW);
    expect(status.state).toBe('ready');
  });

  it('is still cooling one second before that', () => {
    const finishedAt = new Date(NOW.getTime() - RUN_NOW_COOLDOWN_MS + 1000).toISOString();
    const status = runNowStatus(DEMO, [manualRun({ finishedAt })], NOW);
    expect(status.state).toBe('cooling');
    expect(status.retryAfterSeconds).toBe(1);
  });

  it('does not cool down after a scheduled run, which nobody pressed', () => {
    const scheduled = runRecord({
      trigger: 'scheduled',
      scope: null,
      finishedAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    expect(runNowStatus(DEMO, [scheduled], NOW).state).toBe('ready');
  });

  it('still reports the last run that covered the project, whoever triggered it', () => {
    const scheduled = runRecord({
      trigger: 'scheduled',
      scope: null,
      startedAt: '2026-08-21T06:00:00.000Z',
      finishedAt: '2026-08-21T06:04:00.000Z',
      repositories: [
        {
          repositoryId: DEMO.id,
          dependenciesConsidered: 3,
          counts: { green: 1, amber: 1, red: 1 },
          actions: 3,
          missing: [],
          error: null,
        },
      ],
    });
    expect(runNowStatus(DEMO, [scheduled], NOW).message).toContain('06:04:00 UTC in 4m 0s');
  });
});
