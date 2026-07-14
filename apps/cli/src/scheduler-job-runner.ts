/**
 * Runs a scheduled-agent job's prompt through the SAME detached job-worker
 * path `muse job run` spawns (`startBackgroundJob` in commands-jobs.ts) and
 * waits — bounded by a timeout — for it to finish, returning the final text
 * or a failure reason. The daemon's scheduler tick (`makeSchedulerTick`)
 * composes this instead of assembling a second in-daemon agent runtime: one
 * execution path for "run a prompt through the local agent", whether
 * triggered by `muse job run` or a recurring schedule.
 */

import { countRunningJobs, jobsDir, readJobSummary, startBackgroundJob, type JobRunOptions } from "./commands-jobs.js";
import { jobConcurrencyRefusal, resolveJobsMaxConcurrent } from "./job-concurrency.js";
import { sleep } from "./async-promises.js";

export type SchedulerJobOutcome =
  | { readonly status: "success"; readonly text: string }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "timeout"; readonly error: string }
  | { readonly status: "capacity"; readonly error: string };

export interface RunSchedulerJobTiming {
  readonly timeoutMs: number;
  readonly pollIntervalMs?: number;
}

export interface SchedulerJobRunnerDeps {
  readonly jobsDirPath?: string;
  readonly env?: Record<string, string | undefined>;
  readonly start?: (prompt: string, opts: JobRunOptions) => { readonly id: string; readonly file: string };
  readonly poll?: (id: string) => Promise<Awaited<ReturnType<typeof readJobSummary>>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const defaultSleep = sleep;

/**
 * Spawns the detached worker for `prompt`, then polls its JSONL log until it
 * reaches a terminal state (`done`/`error`) or `timing.timeoutMs` elapses.
 * Refuses to spawn (returns `status: "capacity"`, no execution attempted —
 * NOT a failure) once `countRunningJobs` is at the shared
 * `resolveJobsMaxConcurrent` cap, mirroring `startBackgroundJobOrRefuse`.
 */
export async function runSchedulerJobAndWait(
  prompt: string,
  opts: JobRunOptions,
  timing: RunSchedulerJobTiming,
  deps: SchedulerJobRunnerDeps = {}
): Promise<SchedulerJobOutcome> {
  const jobsDirPath = deps.jobsDirPath ?? jobsDir();
  const env = deps.env ?? process.env;
  const cap = resolveJobsMaxConcurrent(env);
  const running = countRunningJobs(jobsDirPath);
  const refusal = jobConcurrencyRefusal(running, cap);
  if (refusal !== undefined) {
    return { error: refusal, status: "capacity" };
  }

  const start = deps.start ?? startBackgroundJob;
  const poll = deps.poll ?? readJobSummary;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? (() => Date.now());

  const { id } = start(prompt, opts);
  const pollIntervalMs = Math.max(1, timing.pollIntervalMs ?? 500);
  const deadline = now() + Math.max(1, timing.timeoutMs);

  while (now() < deadline) {
    const summary = await poll(id);
    if (summary?.status === "done") {
      return { status: "success", text: summary.finalText ?? "" };
    }
    if (summary?.status === "error") {
      return { error: summary.error ?? `job ${id} failed`, status: "failed" };
    }
    await sleep(pollIntervalMs);
  }

  return { error: `job ${id} did not finish within ${timing.timeoutMs.toString()}ms`, status: "timeout" };
}
