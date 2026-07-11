/**
 * The background-job concurrency cap. `muse job run` (background mode)
 * used to spawn unconditionally — an unbounded number of detached workers
 * can exhaust the machine. `MUSE_JOBS_MAX_CONCURRENT` overrides the default
 * of 3; a cap of 0 would forbid ALL background jobs (not the intent of
 * "lower the limit"), so — like `resolveBoardMaxDepth` — 0/negative/
 * non-integer/absent falls back to the default rather than floors at 1.
 */
export function resolveJobsMaxConcurrent(env: Record<string, string | undefined>): number {
  const raw = env.MUSE_JOBS_MAX_CONCURRENT?.trim();
  const parsed = Number(raw);
  if (raw && Number.isInteger(parsed) && parsed > 0) return parsed;
  return 3;
}

/**
 * `undefined` when a new background job is allowed (still under cap);
 * otherwise the exact refusal message to print instead of starting one.
 */
export function jobConcurrencyRefusal(runningCount: number, cap: number): string | undefined {
  if (runningCount < cap) return undefined;
  return `${runningCount.toString()} background jobs already running (limit ${cap.toString()}). Wait for one to finish, or raise MUSE_JOBS_MAX_CONCURRENT.`;
}
