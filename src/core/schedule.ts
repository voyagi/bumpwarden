/**
 * The scheduled run's hours, in UTC. The dashboard tells a reader when the next run lands and the
 * deploy instructions create a Cloud Scheduler job, so the two are derived from one value here: a
 * page that advertises 18:00 while the job fires at 03:00 is worse than a page that says nothing.
 */
export const SCHEDULE_UTC_HOURS = [6, 18] as const;

/** The Cloud Scheduler cron expression the deploy step uses. Derived, never typed twice. */
export const SCHEDULE_CRON = `0 ${SCHEDULE_UTC_HOURS.join(',')} * * *`;

const HOURS_PER_DAY = 24;

/**
 * The next instant the scheduler fires, strictly after `now`. A run starting exactly on the hour
 * must point at the following slot rather than at itself, or the page tells a reader to wait for
 * something that already began.
 */
export function nextScheduledRun(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);

  for (let ahead = 0; ahead <= HOURS_PER_DAY; ahead += 1) {
    const candidate = new Date(next.getTime() + ahead * 3_600_000);
    const onSchedule = SCHEDULE_UTC_HOURS.includes(
      candidate.getUTCHours() as (typeof SCHEDULE_UTC_HOURS)[number],
    );
    if (onSchedule && candidate.getTime() > now.getTime()) return candidate;
  }

  // Unreachable while SCHEDULE_UTC_HOURS has an entry: 24 hours of candidates always contain one.
  throw new Error('no scheduled hour is configured');
}
