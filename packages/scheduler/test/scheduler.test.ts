import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryMcpServerStore, McpManager, type McpConnection } from "@muse/mcp";
import {
  DynamicSchedulerService,
  InMemoryDistributedSchedulerLock,
  InMemoryScheduledJobExecutionStore,
  InMemoryScheduledJobStore,
  KyselyScheduledJobExecutionStore,
  KyselyScheduledJobStore,
  KyselyDistributedSchedulerLock,
  NodeCronScheduler,
  NoOpDistributedSchedulerLock,
  ScheduledJobDispatcher,
  ScheduledJobExecutionRecorder,
  ScheduledJobValidator,
  ScheduledMcpToolInvoker,
  SchedulerMessagingService,
  SchedulerValidationError,
  computeNextRunAt,
  createScheduledJobLockInsert,
  createScheduledJobExecutionInsert,
  createScheduledJobInsert,
  mapScheduledJobExecutionRow,
  mapScheduledJobRow,
  normalizeScheduledJob,
  renderTemplateVariables,
  type CronScheduler,
  type DistributedSchedulerLock,
  type ScheduledAgentExecutor,
  type ScheduledJob
} from "../src/index.js";
import type { Kysely } from "kysely";
import type { MuseDatabase } from "@muse/db";

afterEach(() => {
  vi.useRealTimers();
});

describe("ScheduledJobValidator", () => {
  it("validates cron, timezone, retry, timeout, and type-specific fields", () => {
    const validator = new ScheduledJobValidator();

    expect(() =>
      validator.validate({
        cronExpression: "0 */5 * * * *",
        mcpServerName: "local",
        name: "Collect metrics",
        toolName: "read_metrics"
      })
    ).not.toThrow();
    expect(() =>
      validator.validate({
        cronExpression: "bad cron",
        mcpServerName: "local",
        name: "Bad",
        toolName: "read"
      })
    ).toThrow(SchedulerValidationError);
    expect(() =>
      validator.validate({
        agentPrompt: "Summarize status",
        cronExpression: "0 * * * * *",
        executionTimeoutMs: 999,
        jobType: "agent",
        name: "Agent"
      })
    ).toThrow(SchedulerValidationError);
  });
});

describe("NodeCronScheduler", () => {
  it("computes next run times and triggers callbacks on schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const job = normalizeScheduledJob(
      {
        agentPrompt: "Run",
        cronExpression: "* * * * * *",
        jobType: "agent",
        name: "Every second",
        timezone: "UTC"
      },
      {
        id: "job-1",
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    );
    let calls = 0;
    const scheduler = new NodeCronScheduler({
      now: () => new Date(Date.now())
    });

    expect(computeNextRunAt(job, new Date("2026-01-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-01-01T00:00:01.000Z"
    );

    const handle = scheduler.schedule(job, () => {
      calls += 1;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);

    handle?.cancel();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);
  });
});

describe("scheduled job stores", () => {
  it("saves, updates, evicts, and records execution results", () => {
    let tick = 0;
    const store = new InMemoryScheduledJobStore({
      idFactory: () => `job-${tick}`,
      maxJobs: 1,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))
    });
    const first = store.save({
      cronExpression: "0 * * * * *",
      mcpServerName: "local",
      name: "First",
      toolName: "read"
    });

    store.updateExecutionResult(first.id, "success", "ok");
    expect(store.findById(first.id)?.lastStatus).toBe("success");

    store.save({
      cronExpression: "0 * * * * *",
      mcpServerName: "local",
      name: "Second",
      toolName: "read"
    });

    expect(store.findById(first.id)).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it("keeps execution history newest-first and cleans old records per job", () => {
    let tick = 0;
    const store = new InMemoryScheduledJobExecutionStore({
      idFactory: () => `exec-${tick}`,
      maxEntries: 3,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))
    });

    store.save({ jobId: "job-1", jobName: "Job", result: "one", status: "success" });
    store.save({ jobId: "job-1", jobName: "Job", result: "two", status: "success" });
    store.save({ jobId: "job-2", jobName: "Other", result: "other", status: "success" });
    store.save({ jobId: "job-1", jobName: "Job", result: "three", status: "failed" });
    store.deleteOldestExecutions("job-1", 1);

    expect(store.findByJobId("job-1").map((execution) => execution.result)).toEqual(["three"]);
    expect(store.findRecent()).toHaveLength(2);
  });

  it("enforces in-memory scheduler locks with owner and TTL semantics", async () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const first = new InMemoryDistributedSchedulerLock({
      now: () => new Date(nowMs),
      ownerId: "worker-1"
    });
    const second = new InMemoryDistributedSchedulerLock({
      now: () => new Date(nowMs),
      ownerId: "worker-2"
    });

    expect(await first.tryAcquire("job-1", 100)).toBe(true);
    expect(await first.tryAcquire("job-1", 100)).toBe(true);
    expect(await second.tryAcquire("job-1", 100)).toBe(false);

    nowMs += 101;
    expect(await second.tryAcquire("job-1", 100)).toBe(true);
    await second.release("job-1");
  });
});

describe("template variables", () => {
  it("renders stable scheduler variables", () => {
    const job = normalizeScheduledJob(
      {
        cronExpression: "0 * * * * *",
        id: "job-1",
        mcpServerName: "local",
        name: "Daily",
        timezone: "UTC",
        toolName: "read"
      },
      { id: "job-1", now: () => new Date("2026-05-05T10:11:12.000Z") }
    );

    expect(renderTemplateVariables("{{date}} {{time}} {{day_of_week}} {{job_name}}", job, job.createdAt))
      .toBe("2026-05-05 10:11:12 Tuesday Daily");
  });
});

describe("ScheduledJobDispatcher", () => {
  it("runs agent jobs with retry", async () => {
    let attempts = 0;
    const dispatcher = new ScheduledJobDispatcher({
      agentExecutor: {
        execute: () => {
          attempts += 1;
          if (attempts < 2) {
            throw new Error("temporary");
          }
          return "agent result";
        }
      },
      mcpInvoker: createUnusedMcpInvoker(),
      retryDelayMs: 0,
      sleep: async () => {}
    });
    const job = createAgentJob({ retryOnFailure: true });

    await expect(dispatcher.runWithTimeoutAndRetry(job)).resolves.toBe("agent result");
    expect(attempts).toBe(2);
  });

  it("reports timeout failures with job context", async () => {
    const dispatcher = new ScheduledJobDispatcher({
      agentExecutor: {
        execute: () => new Promise((resolve) => setTimeout(() => resolve("late"), 20))
      },
      defaultExecutionTimeoutMs: 1,
      mcpInvoker: createUnusedMcpInvoker()
    });

    await expect(dispatcher.runWithTimeoutAndRetry(createAgentJob({ executionTimeoutMs: 1 })))
      .rejects.toThrow("timed out");
  });
});

describe("ScheduledMcpToolInvoker", () => {
  it("connects an MCP server and invokes the projected Muse tool", async () => {
    const manager = new McpManager(new InMemoryMcpServerStore(), {
      connector: {
        connect: async (): Promise<McpConnection> => ({
          callTool: async (_toolName, args) => `received:${args.message}`,
          listTools: async () => [
            {
              description: "Read synthetic status",
              inputSchema: {},
              name: "read_status",
              risk: "read"
            }
          ]
        })
      }
    });
    await manager.register({
      config: { command: "node" },
      name: "local",
      transportType: "stdio"
    });
    const invoker = new ScheduledMcpToolInvoker(manager);
    const job = normalizeScheduledJob(
      {
        cronExpression: "0 * * * * *",
        id: "job-1",
        mcpServerName: "local",
        name: "Status",
        toolArguments: { message: "{{job_name}}" },
        toolName: "read_status"
      },
      { id: "job-1", now: () => new Date("2026-05-05T00:00:00.000Z") }
    );

    await expect(invoker.invoke(job)).resolves.toBe("received:Status");
  });
});

describe("DynamicSchedulerService", () => {
  it("creates, registers, triggers, records, and notifies successful jobs", async () => {
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
    const executions = new InMemoryScheduledJobExecutionStore({ idFactory: () => "exec-1" });
    const scheduled: string[] = [];
    const messages: string[] = [];
    const cronScheduler: CronScheduler = {
      schedule: (job) => {
        scheduled.push(job.id);
        return { cancel: () => scheduled.push(`cancel:${job.id}`) };
      }
    };
    const service = new DynamicSchedulerService({
      cronScheduler,
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute: async () => "done" },
        mcpInvoker: createUnusedMcpInvoker()
      }),
      executionStore: executions,
      messagingService: new SchedulerMessagingService({
        sendMessage: async (target, text) => {
          messages.push(`${target}:${text}`);
        }
      }),
      store
    });
    const saved = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Agent job",
      notificationChannelId: "ops-channel"
    });

    await expect(service.trigger(saved.id)).resolves.toBe("done");

    expect(scheduled).toEqual(["job-1"]);
    expect(messages).toEqual(["ops-channel:done"]);
    expect(store.findById(saved.id)?.lastStatus).toBe("success");
    expect(executions.findByJobId(saved.id)).toHaveLength(1);
  });

  it("skips trigger when a distributed lock is held elsewhere", async () => {
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
    const lock: DistributedSchedulerLock = {
      release: async () => {
        throw new Error("release should not be called");
      },
      tryAcquire: async () => false
    };
    const service = new DynamicSchedulerService({
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute: async () => "done" },
        mcpInvoker: createUnusedMcpInvoker()
      }),
      distributedLock: lock,
      store
    });
    const saved = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Agent job"
    });

    await expect(service.trigger(saved.id)).resolves.toContain("skipped");
    expect(store.findById(saved.id)?.lastStatus).toBe("skipped");
  });

  it("dry run records history but does not mutate last status", async () => {
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
    const executions = new InMemoryScheduledJobExecutionStore({ idFactory: () => "exec-1" });
    const service = new DynamicSchedulerService({
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute: async () => "dry" },
        mcpInvoker: createUnusedMcpInvoker()
      }),
      executionStore: executions,
      store
    });
    const saved = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Agent job"
    });

    await expect(service.dryRun(saved.id)).resolves.toBe("dry");

    expect(store.findById(saved.id)?.lastStatus).toBeUndefined();
    expect(executions.findByJobId(saved.id)[0]?.dryRun).toBe(true);
  });
});

describe("Kysely mapping helpers", () => {
  it("maps scheduled job rows and execution rows", () => {
    const now = new Date("2026-05-05T00:00:00.000Z");
    const insert = createScheduledJobInsert(
      {
        cronExpression: "0 * * * * *",
        mcpServerName: "local",
        name: "Job",
        tags: ["ops"],
        toolName: "read"
      },
      { idFactory: () => "job-1", now: () => now }
    );
    const execution = createScheduledJobExecutionInsert(
      { jobId: "job-1", jobName: "Job", result: "ok", status: "success" },
      { idFactory: () => "exec-1", now: () => now }
    );
    const lock = createScheduledJobLockInsert("job-1", "worker-1", 1_000, now);

    expect(mapScheduledJobRow(insert)).toMatchObject({ id: "job-1", name: "Job", tags: ["ops"] });
    expect(mapScheduledJobExecutionRow(execution)).toMatchObject({ id: "exec-1", jobId: "job-1" });
    expect(lock).toMatchObject({
      job_id: "job-1",
      locked_until: new Date("2026-05-05T00:00:01.000Z"),
      owner_id: "worker-1"
    });
  });

  it("constructs Kysely stores", () => {
    const db = {} as Kysely<MuseDatabase>;

    expect(new KyselyScheduledJobStore(db)).toBeInstanceOf(KyselyScheduledJobStore);
    expect(new KyselyScheduledJobExecutionStore(db)).toBeInstanceOf(KyselyScheduledJobExecutionStore);
    expect(new KyselyDistributedSchedulerLock(db)).toBeInstanceOf(KyselyDistributedSchedulerLock);
  });

  it("constructs no-op distributed lock and execution recorder", async () => {
    expect(await new NoOpDistributedSchedulerLock().tryAcquire("job-1", 1_000)).toBe(true);
    await expect(
      new ScheduledJobExecutionRecorder(undefined).recordExecution({
        dryRun: false,
        durationMs: 0,
        job: createAgentJob(),
        result: "ok",
        startedAt: new Date(),
        status: "success"
      })
    ).resolves.toBeUndefined();
  });
});

function createAgentJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    agentPrompt: "Run",
    createdAt: new Date("2026-05-05T00:00:00.000Z"),
    cronExpression: "0 * * * * *",
    enabled: true,
    id: "job-1",
    jobType: "agent",
    maxRetryCount: 2,
    name: "Agent job",
    retryOnFailure: false,
    tags: [],
    timezone: "UTC",
    toolArguments: {},
    updatedAt: new Date("2026-05-05T00:00:00.000Z"),
    ...overrides
  };
}

function createUnusedMcpInvoker(): ScheduledMcpToolInvoker {
  return new ScheduledMcpToolInvoker(
    new McpManager(new InMemoryMcpServerStore(), {
      connector: {
        connect: async () => ({
          listTools: async () => []
        })
      }
    })
  );
}
