/**
 * Poll-model due-check for the daemon's scheduler tick — deliberately NOT an
 * in-process cron timer (`NodeCronScheduler`), so a daemon restart never
 * loses an armed job. A job is due when the FIRST cron occurrence strictly
 * after its last run (or, for a never-run job, after its creation) is at or
 * before `now`. This returns at most ONE fire per tick per job even after a
 * long daemon outage — mirrors the reminder-recurrence "skip missed
 * periods" behavior, not a catch-up storm.
 */

import { computeNextRunAt, type ScheduledJob } from "@muse/scheduler";

export type DueCheckJob = Pick<ScheduledJob, "cronExpression" | "timezone" | "lastRunAt" | "createdAt">;

export function isScheduledJobDue(job: DueCheckJob, now: Date): boolean {
  const from = job.lastRunAt ?? job.createdAt;
  try {
    return computeNextRunAt(job, from).getTime() <= now.getTime();
  } catch {
    // An invalid persisted cron expression never fires (fail-closed) rather
    // than throwing out of the daemon tick loop over one bad job.
    return false;
  }
}
