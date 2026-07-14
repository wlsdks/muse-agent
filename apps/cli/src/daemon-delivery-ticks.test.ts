import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setSchedulerPaused } from "@muse/stores";
import { afterEach, describe, expect, it } from "vitest";

import { makeSchedulerTick } from "./daemon-delivery-ticks.js";
import type { SchedulerJobOutcome } from "./scheduler-job-runner.js";

import type { JobExecutionStatus, ScheduledJob, ScheduledJobInput, ScheduledJobStore } from "@muse/scheduler";

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    agentPrompt: "summarize today",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    cronExpression: "0 9 * * *",
    enabled: true,
    id: "job-1",
    jobType: "agent",
    maxRetryCount: 3,
    name: "morning-brief",
    retryOnFailure: false,
    tags: [],
    timezone: "UTC",
    toolArguments: {},
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides
  };
}

/** Minimal in-memory ScheduledJobStore fake with an update-call log, so
 *  tests can assert exactly which status transitions the tick wrote. */
class FakeStore implements ScheduledJobStore {
  readonly updateCalls: Array<{ id: string; status: JobExecutionStatus; result?: string | null }> = [];
  private readonly jobs = new Map<string, ScheduledJob>();

  constructor(initial: readonly ScheduledJob[] = []) {
    for (const j of initial) this.jobs.set(j.id, j);
  }

  list(): readonly ScheduledJob[] {
    return [...this.jobs.values()];
  }

  findById(id: string): ScheduledJob | undefined {
    return this.jobs.get(id);
  }

  findByName(name: string): ScheduledJob | undefined {
    return [...this.jobs.values()].find((j) => j.name === name);
  }

  save(input: ScheduledJobInput): ScheduledJob {
    const saved = job({ ...(input as Partial<ScheduledJob>), id: input.id ?? `job-${(this.jobs.size + 1).toString()}` });
    this.jobs.set(saved.id, saved);
    return saved;
  }

  update(id: string, input: ScheduledJobInput): ScheduledJob | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...(input as Partial<ScheduledJob>) };
    this.jobs.set(id, updated);
    return updated;
  }

  delete(id: string): void {
    this.jobs.delete(id);
  }

  updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): void {
    this.updateCalls.push({ id, result, status });
    const existing = this.jobs.get(id);
    if (existing) {
      this.jobs.set(id, { ...existing, lastResult: result ?? undefined, lastStatus: status, updatedAt: new Date() });
    }
  }
}

function fakeMessaging() {
  const sent: Array<{ providerId: string; destination: string; text: string }> = [];
  return {
    sent,
    send: async (providerId: string, message: { destination: string; text: string }) => {
      sent.push({ destination: message.destination, providerId, text: message.text });
      return { providerId, status: "sent" as const };
    }
  };
}

function tmpPauseFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-scheduler-tick-")), "scheduler-paused.json");
}

describe("makeSchedulerTick", () => {
  const out: string[] = [];
  const stdout = (m: string) => out.push(m);
  afterEach(() => { out.length = 0; });

  it("does nothing and logs 'paused' when the scheduler pause file is set — the store is never even read", async () => {
    const pauseFile = tmpPauseFile();
    await setSchedulerPaused(pauseFile, true);
    const store = new FakeStore([job()]);
    const messaging = fakeMessaging();
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never, pauseFile, provider: "log",
      schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(out.join("")).toContain("paused");
    expect(store.updateCalls).toEqual([]);
    expect(messaging.sent).toEqual([]);
  });

  it("skips a job that is not yet due", async () => {
    const pauseFile = tmpPauseFile();
    const store = new FakeStore([job({ cronExpression: "0 9 * * *", createdAt: new Date("2026-06-01T03:00:00Z") })]);
    const messaging = fakeMessaging();
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T08:00:00Z"),
      pauseFile, provider: "log", schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls).toEqual([]);
    expect(messaging.sent).toEqual([]);
    expect(out.join("")).toContain("fired 0/0 due");
  });

  it("a due job runs, is marked running then success, and its result is delivered to the daemon default destination", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created, cronExpression: "0 9 * * *" })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ status: "success", text: "3 meetings today" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "success"]);
    expect(store.updateCalls[1]?.result).toBe("3 meetings today");
    expect(messaging.sent).toEqual([{ destination: "@me", providerId: "log", text: "3 meetings today" }]);
    expect(out.join("")).toContain("fired 1/1 due");
  });

  it("a job's own notificationChannelId ('provider:destination') overrides the daemon default routing", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created, notificationChannelId: "telegram:98765" })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ status: "success", text: "hi" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(messaging.sent).toEqual([{ destination: "98765", providerId: "telegram", text: "hi" }]);
  });

  it("SAFETY: a failed/timed-out execution mutates ONLY lastStatus/lastResult — no delivery of partial text", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ error: "model provider unavailable", status: "failed" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "failed"]);
    expect(messaging.sent).toEqual([]); // NEVER delivers on failure
    expect(out.join("")).toContain("model provider unavailable");
  });

  it("SAFETY: a timeout outcome also mutates only lastStatus/lastResult and never delivers", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ error: "job did not finish within 300000ms", status: "timeout" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "failed"]);
    expect(messaging.sent).toEqual([]);
  });

  it("a 'capacity' refusal (concurrency cap reached, nothing spawned) is recorded as 'skipped', never delivers", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");
    const store = new FakeStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    const runJob = async (): Promise<SchedulerJobOutcome> => ({ error: "3 background jobs already running (limit 3)", status: "capacity" });
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    await tick();

    expect(store.updateCalls.map((c) => c.status)).toEqual(["running", "skipped"]);
    expect(messaging.sent).toEqual([]);
  });

  it("OVERLAP GUARD: two ticks firing while a job's previous run is still in flight only ever runs it ONCE — the second is marked skipped, not double-run", async () => {
    const pauseFile = tmpPauseFile();
    const created = new Date("2026-06-01T00:00:00Z");

    // Deterministic gate: resolves the instant the tick marks job-1
    // "running" — the exact point the overlap guard has taken effect —
    // instead of racing a wall-clock setTimeout against real fs I/O.
    let markRunningSeen: () => void = () => undefined;
    const markedRunning = new Promise<void>((resolve) => { markRunningSeen = resolve; });
    class GatedStore extends FakeStore {
      override updateExecutionResult(id: string, status: JobExecutionStatus, result?: string | null): void {
        super.updateExecutionResult(id, status, result);
        if (status === "running") markRunningSeen();
      }
    }
    const store = new GatedStore([job({ createdAt: created })]);
    const messaging = fakeMessaging();
    let runJobCalls = 0;
    let resolveRunJob: (outcome: SchedulerJobOutcome) => void = () => undefined;
    const pending = new Promise<SchedulerJobOutcome>((resolve) => { resolveRunJob = resolve; });
    const runJob = async (): Promise<SchedulerJobOutcome> => {
      runJobCalls += 1;
      return pending;
    };
    const tick = makeSchedulerTick({
      destination: "@me", env: {}, messagingRegistry: messaging as never,
      now: () => new Date("2026-06-01T09:00:00Z"),
      pauseFile, provider: "log", runJob, schedulerFile: "/unused", stdout, store
    });

    const firstTick = tick();
    // Wait for the FIRST tick to have actually marked job-1 "running"
    // (the overlap guard's `runningJobIds.add` happens right before that
    // write) before firing the second concurrent tick.
    await markedRunning;
    const secondTick = tick();
    // A CORRECTLY-guarded second tick needs no `runJob` resolution at all —
    // it hits the skip branch and settles on its own. Let it (or a short
    // timeout, if the guard were broken and it also called runJob) resolve
    // BEFORE releasing the first tick's `runJob` — otherwise the first
    // tick's fully-synchronous remaining work (fake store/messaging, no
    // real I/O) can run its `finally` cleanup and clear the guard via
    // microtasks alone before the second tick's own async pause-file read
    // (real fs I/O, a macrotask) ever gets a chance to check it.
    await Promise.race([secondTick, new Promise((resolve) => setTimeout(resolve, 100))]);
    resolveRunJob({ status: "success", text: "done" });
    await Promise.all([firstTick, secondTick]);

    expect(runJobCalls).toBe(1);
    expect(store.updateCalls.some((c) => c.status === "skipped" && (c.result ?? "").includes("previous run still in progress"))).toBe(true);
  });
});
