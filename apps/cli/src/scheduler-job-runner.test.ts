import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runSchedulerJobAndWait } from "./scheduler-job-runner.js";

describe("runSchedulerJobAndWait", () => {
  it("returns success with the final text once the polled summary reports done", async () => {
    const start = vi.fn().mockReturnValue({ file: "/x/job-1.jsonl", id: "job-1" });
    const poll = vi.fn()
      .mockResolvedValueOnce({ events: 1, id: "job-1", status: "running" })
      .mockResolvedValueOnce({ events: 2, finalText: "today's summary", id: "job-1", status: "done" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await runSchedulerJobAndWait(
      "summarize today",
      {},
      { timeoutMs: 10_000 },
      { env: {}, jobsDirPath: "/x", poll, sleep, start }
    );

    expect(outcome).toEqual({ status: "success", text: "today's summary" });
    expect(start).toHaveBeenCalledWith("summarize today", {});
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returns failed with the error text once the polled summary reports error", async () => {
    const start = vi.fn().mockReturnValue({ file: "/x/job-1.jsonl", id: "job-1" });
    const poll = vi.fn().mockResolvedValue({ error: "model provider unavailable", events: 1, id: "job-1", status: "error" });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const outcome = await runSchedulerJobAndWait(
      "p",
      {},
      { timeoutMs: 10_000 },
      { env: {}, jobsDirPath: "/x", poll, sleep, start }
    );

    expect(outcome).toEqual({ error: "model provider unavailable", status: "failed" });
  });

  it("returns timeout when the deadline passes without a terminal event — never a false success", async () => {
    const start = vi.fn().mockReturnValue({ file: "/x/job-1.jsonl", id: "job-1" });
    const poll = vi.fn().mockResolvedValue({ events: 1, id: "job-1", status: "running" });
    let clock = 0;
    const now = () => clock;
    const sleep = vi.fn().mockImplementation(async (ms: number) => { clock += ms; });

    const outcome = await runSchedulerJobAndWait(
      "p",
      {},
      { pollIntervalMs: 100, timeoutMs: 300 },
      { env: {}, jobsDirPath: "/x", now, poll, sleep, start }
    );

    expect(outcome.status).toBe("timeout");
    expect((outcome as { error: string }).error).toContain("job-1");
  });

  it("does NOT refuse below the cap — spawns normally when under MUSE_JOBS_MAX_CONCURRENT", async () => {
    const start = vi.fn().mockReturnValue({ file: "/x/job-1.jsonl", id: "job-1" });
    const poll = vi.fn().mockResolvedValue({ events: 1, finalText: "ok", id: "job-1", status: "done" });

    const outcome = await runSchedulerJobAndWait(
      "p",
      {},
      { timeoutMs: 10_000 },
      {
        env: { MUSE_JOBS_MAX_CONCURRENT: "1" },
        // countRunningJobs sees 0 running when the dir doesn't exist yet.
        jobsDirPath: join(mkdtempSync(join(tmpdir(), "muse-sched-jobs-empty-")), "jobs"),
        poll,
        start
      }
    );

    expect(start).toHaveBeenCalled();
    expect(outcome.status).toBe("success");
  });

  it("refuses to spawn once at the concurrency cap — NEVER attempts the spawn (status: capacity, not failed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-sched-jobs-full-"));
    // A job whose latest event is "started" (no done/error yet) counts as running.
    writeFileSync(join(dir, "job-running.jsonl"), `${JSON.stringify({ prompt: "x", tsIso: new Date().toISOString(), type: "started" })}\n`, "utf8");
    const start = vi.fn();
    const poll = vi.fn();

    const outcome = await runSchedulerJobAndWait(
      "p",
      {},
      { timeoutMs: 10_000 },
      { env: { MUSE_JOBS_MAX_CONCURRENT: "1" }, jobsDirPath: dir, poll, start }
    );

    expect(start).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
    expect(outcome.status).toBe("capacity");
  });
});
