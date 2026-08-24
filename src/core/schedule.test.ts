import { describe, expect, it } from 'vitest';
import { SCHEDULE_CRON, SCHEDULE_UTC_HOURS, nextScheduledRun } from './schedule.js';

describe('the published schedule', () => {
  it('derives the cron expression from the hours the dashboard prints', () => {
    expect(SCHEDULE_CRON).toBe(`0 ${SCHEDULE_UTC_HOURS.join(',')} * * *`);
  });

  it('finds the next slot later the same day', () => {
    const next = nextScheduledRun(new Date('2026-08-21T09:14:00Z'));
    expect(next.toISOString()).toBe('2026-08-21T18:00:00.000Z');
  });

  it('rolls over to tomorrow after the last slot', () => {
    const next = nextScheduledRun(new Date('2026-08-21T23:59:59Z'));
    expect(next.toISOString()).toBe('2026-08-22T06:00:00.000Z');
  });

  it('points at the following slot when a run starts exactly on the hour', () => {
    // Otherwise the page tells a reader to wait for the run that is already underway.
    const next = nextScheduledRun(new Date('2026-08-21T06:00:00.000Z'));
    expect(next.toISOString()).toBe('2026-08-21T18:00:00.000Z');
  });

  it('moves on one millisecond past a slot', () => {
    const next = nextScheduledRun(new Date('2026-08-21T05:59:59.999Z'));
    expect(next.toISOString()).toBe('2026-08-21T06:00:00.000Z');
  });
});
