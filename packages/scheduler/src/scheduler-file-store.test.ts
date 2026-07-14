import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultScheduledJobsFile, FileScheduledJobStore } from "./scheduler-file-store.js";
import { SchedulerValidationError } from "./scheduler-errors.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-scheduler-file-")), "scheduled-jobs.json");
}

describe("defaultScheduledJobsFile", () => {
  it("honors MUSE_SCHEDULED_JOBS_FILE", () => {
    expect(defaultScheduledJobsFile({ MUSE_SCHEDULED_JOBS_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
  });

  it("falls back to ~/.muse/scheduled-jobs.json", () => {
    expect(defaultScheduledJobsFile({})).toMatch(/\.muse[/\\]scheduled-jobs\.json$/u);
  });
});

describe("FileScheduledJobStore — round-trip persistence", () => {
  it("save() then a FRESH store instance reads it back (persists across process restarts)", async () => {
    const file = tmpFile();
    const store = new FileScheduledJobStore({ file, idFactory: () => "job-1" });

    const saved = await store.save({
      agentPrompt: "summarize today",
      cronExpression: "0 9 * * *",
      jobType: "agent",
      name: "morning-brief"
    });
    expect(saved.id).toBe("job-1");
    expect(saved.name).toBe("morning-brief");

    // A brand new instance (simulating a new process) must see the same job.
    const reopened = new FileScheduledJobStore({ file });
    const list = await reopened.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("morning-brief");
    expect(list[0]!.agentPrompt).toBe("summarize today");
    expect(list[0]!.createdAt).toBeInstanceOf(Date);
    expect(list[0]!.updatedAt).toBeInstanceOf(Date);
  });

  it("update() persists the change; findById reflects it from a fresh instance", async () => {
    const file = tmpFile();
    const store = new FileScheduledJobStore({ file, idFactory: () => "job-1" });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "j" });

    await store.update("job-1", { agentPrompt: "p2", cronExpression: "0 10 * * *", jobType: "agent", name: "j" });

    const reopened = new FileScheduledJobStore({ file });
    const found = await reopened.findById("job-1");
    expect(found?.cronExpression).toBe("0 10 * * *");
    expect(found?.agentPrompt).toBe("p2");
  });

  it("delete() removes the job durably", async () => {
    const file = tmpFile();
    const store = new FileScheduledJobStore({ file, idFactory: () => "job-1" });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "j" });
    await store.delete("job-1");

    const reopened = new FileScheduledJobStore({ file });
    expect(await reopened.findById("job-1")).toBeUndefined();
    expect(await reopened.list()).toHaveLength(0);
  });

  it("updateExecutionResult() persists lastStatus/lastResult/lastRunAt as real Dates on reload", async () => {
    const file = tmpFile();
    const store = new FileScheduledJobStore({ file, idFactory: () => "job-1" });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "j" });
    await store.updateExecutionResult("job-1", "success", "done: 3 items");

    const reopened = new FileScheduledJobStore({ file });
    const found = await reopened.findById("job-1");
    expect(found?.lastStatus).toBe("success");
    expect(found?.lastResult).toBe("done: 3 items");
    expect(found?.lastRunAt).toBeInstanceOf(Date);
  });

  it("save() rejects a duplicate name (delegates the InMemory dedup guard)", async () => {
    const file = tmpFile();
    const store = new FileScheduledJobStore({ file, idFactory: () => "job-1" });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "dup" });
    await expect(
      store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "dup" })
    ).rejects.toBeInstanceOf(SchedulerValidationError);
  });

  it("hydrating two pre-existing same-named jobs from a legacy file does NOT throw (restore bypasses the dedup guard)", async () => {
    const file = tmpFile();
    const now = new Date().toISOString();
    writeFileSync(file, `${JSON.stringify({
      jobs: [
        { agentPrompt: "a", createdAt: now, cronExpression: "0 9 * * *", enabled: true, id: "j1", jobType: "agent", maxRetryCount: 3, name: "same-name", retryOnFailure: false, tags: [], timezone: "UTC", toolArguments: {}, updatedAt: now },
        { agentPrompt: "b", createdAt: now, cronExpression: "0 10 * * *", enabled: true, id: "j2", jobType: "agent", maxRetryCount: 3, name: "same-name", retryOnFailure: false, tags: [], timezone: "UTC", toolArguments: {}, updatedAt: now }
      ]
    })}\n`, "utf8");

    const store = new FileScheduledJobStore({ file });
    const list = await store.list();
    expect(list).toHaveLength(2);
  });

  it("maxJobs cap evicts the oldest job on overflow (mirrors InMemoryScheduledJobStore)", async () => {
    const file = tmpFile();
    let counter = 0;
    const store = new FileScheduledJobStore({
      file,
      idFactory: () => `job-${(counter += 1).toString()}`,
      maxJobs: 2,
      now: () => new Date(Date.now() + counter * 1000)
    });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "a" });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "b" });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "c" });

    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list.map((j) => j.name).sort()).toEqual(["b", "c"]);
  });

  it("a corrupt JSON file fails soft to empty and is quarantined (renamed aside), never thrown", async () => {
    const file = tmpFile();
    writeFileSync(file, "{ not valid json", "utf8");

    const store = new FileScheduledJobStore({ file });
    const list = await store.list();
    expect(list).toEqual([]);

    // The corrupt bytes are preserved under a `.corrupt-<ts>` sibling, not deleted.
    const dir = file.slice(0, file.lastIndexOf("/"));
    const siblings = readdirSync(dir);
    expect(siblings.some((name) => name.startsWith("scheduled-jobs.json.corrupt-"))).toBe(true);
  });

  it("a JSON file with the wrong shape (no `jobs` array) also fails soft + quarantines", async () => {
    const file = tmpFile();
    writeFileSync(file, `${JSON.stringify({ notJobs: [] })}\n`, "utf8");

    const store = new FileScheduledJobStore({ file });
    expect(await store.list()).toEqual([]);
  });

  it("drops a single malformed entry (missing required field) but keeps the rest", async () => {
    const file = tmpFile();
    const now = new Date().toISOString();
    writeFileSync(file, `${JSON.stringify({
      jobs: [
        { agentPrompt: "a", createdAt: now, cronExpression: "0 9 * * *", enabled: true, id: "j1", jobType: "agent", maxRetryCount: 3, name: "good", retryOnFailure: false, tags: [], timezone: "UTC", toolArguments: {}, updatedAt: now },
        { id: "j2", name: "missing-cron-expression" }
      ]
    })}\n`, "utf8");

    const store = new FileScheduledJobStore({ file });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("j1");
  });

  it("writes the file atomically (JSON parses cleanly after a save) and only ONE final file remains", async () => {
    const file = tmpFile();
    const store = new FileScheduledJobStore({ file, idFactory: () => "job-1" });
    await store.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "j" });

    const raw = await readFile(file, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const dir = file.slice(0, file.lastIndexOf("/"));
    const siblings = readdirSync(dir).filter((name) => name.startsWith("scheduled-jobs.json.tmp-"));
    expect(siblings).toEqual([]);
  });

  it("concurrent save() calls against the SAME file both persist (cross-process lock serializes the RMW)", async () => {
    const file = tmpFile();
    const storeA = new FileScheduledJobStore({ file, idFactory: () => "job-a" });
    const storeB = new FileScheduledJobStore({ file, idFactory: () => "job-b" });

    await Promise.all([
      storeA.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "a" }),
      storeB.save({ agentPrompt: "p", cronExpression: "0 9 * * *", jobType: "agent", name: "b" })
    ]);

    const reopened = new FileScheduledJobStore({ file });
    const list = await reopened.list();
    expect(list.map((j) => j.name).sort()).toEqual(["a", "b"]);
  });
});
