import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryMcpServerStore, McpManager, type McpConnection } from "@muse/mcp";
import {
  DynamicScheduler,
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
  SchedulerMessaging,
  SchedulerValidationError,
  buildScheduledJobListQuery,
  computeNextRunAt,
  createSchedulerTools,
  createScheduledJobLockInsert,
  createScheduledJobExecutionInsert,
  createScheduledJobInsert,
  mapScheduledJobExecutionRow,
  mapScheduledJobRow,
  normalizeScheduledJob,
  renderTemplateVariables,
  resolveJobTimeout,
  type CronScheduler,
  type DistributedSchedulerLock,
  type ScheduledJob
} from "../src/index.js";
import {
  DummyDriver,
  Kysely as KyselyClient,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
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

  it("a corrupt / legacy job.timezone falls back to UTC instead of crashing dispatch", () => {
    // normalizeScheduledJob only trims the timezone (validateTimezone
    // gates create, not load), so a bad persisted value reaches here.
    const now = () => new Date("2026-05-05T10:11:12.000Z");
    const bad = normalizeScheduledJob(
      { cronExpression: "0 * * * * *", id: "j", mcpServerName: "s", name: "N", timezone: "Not/AZone", toolName: "t" },
      { id: "j", now }
    );
    expect(bad.timezone).toBe("Not/AZone"); // load path passed it through unvalidated
    // Pre-fix this threw RangeError from Intl.DateTimeFormat.
    expect(renderTemplateVariables("{{datetime}} {{day_of_week}}", bad, now()))
      .toBe("2026-05-05 10:11:12 Tuesday"); // rendered in the UTC fallback

    // No regression: a valid non-UTC zone still renders in that zone.
    const ny = normalizeScheduledJob(
      { cronExpression: "0 * * * * *", id: "j2", mcpServerName: "s", name: "N", timezone: "America/New_York", toolName: "t" },
      { id: "j2", now }
    );
    expect(renderTemplateVariables("{{date}} {{time}}", ny, now()))
      .toBe("2026-05-05 06:11:12"); // 10:11 UTC == 06:11 EDT
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

  it("clamps the dispatch loop to maxRetryCountCeiling even when a legacy / hand-edited DB row carries an unbounded maxRetryCount — the create-time gate can't protect rows that predate it, so the runtime must defend itself against a retry-storm", async () => {
    let attempts = 0;
    const dispatcher = new ScheduledJobDispatcher({
      agentExecutor: {
        execute: () => {
          attempts += 1;
          throw new Error("always fails");
        }
      },
      mcpInvoker: createUnusedMcpInvoker(),
      retryDelayMs: 0,
      sleep: async () => {}
    });
    // 1_000_000 bypasses validateRetryConfig (this is a raw row, not
    // a create call) — pre-fix the loop would dispatch a million times.
    const job = createAgentJob({ retryOnFailure: true, maxRetryCount: 1_000_000 });

    await expect(dispatcher.runWithTimeoutAndRetry(job)).rejects.toThrow("always fails");
    expect(attempts).toBe(100); // maxRetryCountCeiling
  });

  it("clamps a non-finite maxRetryCount to a single attempt so a corrupt row can't make the loop never run (NaN) or run forever (Infinity)", async () => {
    let attempts = 0;
    const dispatcher = new ScheduledJobDispatcher({
      agentExecutor: {
        execute: () => {
          attempts += 1;
          throw new Error("always fails");
        }
      },
      mcpInvoker: createUnusedMcpInvoker(),
      retryDelayMs: 0,
      sleep: async () => {}
    });
    const job = createAgentJob({ retryOnFailure: true, maxRetryCount: Number.POSITIVE_INFINITY });

    await expect(dispatcher.runWithTimeoutAndRetry(job)).rejects.toThrow("always fails");
    expect(attempts).toBe(1); // non-finite → single attempt, never unbounded
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

describe("DynamicScheduler", () => {
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
    const service = new DynamicScheduler({
      cronScheduler,
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute: async () => "done" },
        mcpInvoker: createUnusedMcpInvoker()
      }),
      executionStore: executions,
      messagingService: new SchedulerMessaging({
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
    const service = new DynamicScheduler({
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
    const service = new DynamicScheduler({
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

describe("scheduler tools", () => {
  it("exposes scheduler create, list, trigger, and dry-run actions as Muse tools", async () => {
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
    const executions = new InMemoryScheduledJobExecutionStore({ idFactory: () => "exec-1" });
    const service = new DynamicScheduler({
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute: async (job) => `ran:${job.name}` },
        mcpInvoker: createUnusedMcpInvoker()
      }),
      executionStore: executions,
      store
    });
    const tools = createSchedulerTools(service);
    const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));

    expect([...byName.keys()]).toEqual([
      "scheduler_list_jobs",
      "scheduler_create_job",
      "scheduler_trigger_job",
      "scheduler_dry_run_job"
    ]);
    expect(byName.get("scheduler_create_job")?.definition.risk).toBe("write");

    const created = await byName.get("scheduler_create_job")?.execute({
      agentPrompt: "Summarize workspace status",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Workspace summary",
      tags: ["ops"]
    }, { runId: "run-1" });
    const listed = await byName.get("scheduler_list_jobs")?.execute({}, { runId: "run-1" });
    const triggered = await byName.get("scheduler_trigger_job")?.execute({ jobId: "job-1" }, { runId: "run-1" });
    const dryRun = await byName.get("scheduler_dry_run_job")?.execute({ jobId: "job-1" }, { runId: "run-1" });

    expect(created).toMatchObject({ id: "job-1", name: "Workspace summary" });
    expect(listed).toMatchObject({ jobs: [{ id: "job-1", name: "Workspace summary" }], total: 1 });
    expect(triggered).toEqual({ jobId: "job-1", result: "ran:Workspace summary" });
    expect(dryRun).toEqual({ dryRun: true, jobId: "job-1", result: "ran:Workspace summary" });
    expect(store.findById("job-1")?.lastStatus).toBe("success");
    expect(executions.findByJobId("job-1")).toHaveLength(2);
  });

  function toolsetByName() {
    const service = new DynamicScheduler({
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute: async (job) => `ran:${job.name}` },
        mcpInvoker: createUnusedMcpInvoker()
      }),
      executionStore: new InMemoryScheduledJobExecutionStore({ idFactory: () => "exec-1" }),
      store: new InMemoryScheduledJobStore({ idFactory: () => "job-1" })
    });
    return new Map(createSchedulerTools(service).map((tool) => [tool.definition.name, tool]));
  }

  it("scheduler_create_job rejects a missing required cronExpression — never persists a cron-less job", async () => {
    // The local model may omit the required arg; the create tool must reject it
    // (a job with no schedule would never fire / is meaningless), surfaced as the
    // validation error, not a silent half-created job.
    const byName = toolsetByName();
    await expect(byName.get("scheduler_create_job")?.execute({ agentPrompt: "p", jobType: "agent", name: "No schedule" }, { runId: "run-1" }))
      .rejects.toBeInstanceOf(SchedulerValidationError);
  });

  it("scheduler_trigger_job / dry_run on an UNKNOWN jobId return a clean 'not found' result, never throw", async () => {
    // An agent-invoked trigger for a stale/wrong id must degrade gracefully — a
    // thrown error here would break the tool loop and lose the turn.
    const byName = toolsetByName();
    await expect(byName.get("scheduler_trigger_job")?.execute({ jobId: "ghost" }, { runId: "run-1" }))
      .resolves.toEqual({ jobId: "ghost", result: "Job not found: ghost" });
    await expect(byName.get("scheduler_dry_run_job")?.execute({ jobId: "ghost" }, { runId: "run-1" }))
      .resolves.toEqual({ dryRun: true, jobId: "ghost", result: "Job not found: ghost" });
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

  it("buildScheduledJobListQuery emits ORDER BY created_at ASC, name ASC — same two-key sort as InMemory's compareJobs (in-memory/Kysely parity)", () => {
    // The InMemory `list()` sorts via `compareJobs` (createdAt ASC,
    // name ASC tiebreaker). The pre-fix Kysely path was `orderBy
    // ("created_at", "asc")` only — same-timestamp ties came back in
    // DB-natural-order (engine-dependent, undefined). The exported
    // helper makes the SQL contract testable without a real Postgres.
    const db = new KyselyClient<MuseDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (innerDb) => new PostgresIntrospector(innerDb),
        createQueryCompiler: () => new PostgresQueryCompiler()
      }
    });
    const compiled = buildScheduledJobListQuery(db).compile();

    // Both order-by clauses present, primary key first.
    expect(compiled.sql, `compiled SQL: ${compiled.sql}`).toMatch(/order by "created_at" asc,\s*"name" asc/iu);
    // Selects from the right table — sanity check on the query shape.
    expect(compiled.sql).toContain('from "scheduled_jobs"');
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

describe("resolveJobTimeout", () => {
  const FALLBACK = 30_000;

  it("passes through a valid positive executionTimeoutMs", () => {
    expect(resolveJobTimeout(createAgentJob({ executionTimeoutMs: 5_000 }), FALLBACK)).toBe(5_000);
  });

  it("falls back when executionTimeoutMs is absent or non-positive", () => {
    expect(resolveJobTimeout(createAgentJob({ executionTimeoutMs: undefined }), FALLBACK)).toBe(FALLBACK);
    expect(resolveJobTimeout(createAgentJob({ executionTimeoutMs: 0 }), FALLBACK)).toBe(FALLBACK);
    expect(resolveJobTimeout(createAgentJob({ executionTimeoutMs: -1 }), FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for a non-finite executionTimeoutMs (corrupt persisted job)", () => {
    // `??` does not catch these; without the finite guard they
    // poison the lock TTL / watchdog instead of timing the job out.
    expect(resolveJobTimeout(createAgentJob({ executionTimeoutMs: Number.NaN }), FALLBACK)).toBe(FALLBACK);
    expect(resolveJobTimeout(createAgentJob({ executionTimeoutMs: Number.POSITIVE_INFINITY }), FALLBACK)).toBe(FALLBACK);
    expect(resolveJobTimeout(createAgentJob({ executionTimeoutMs: Number.NEGATIVE_INFINITY }), FALLBACK)).toBe(FALLBACK);
  });
});

describe("normalizeScheduledJob maxRetryCount finite guard", () => {
  const base = {
    agentPrompt: "Run",
    cronExpression: "* * * * *",
    jobType: "agent" as const,
    name: "Job"
  };
  const opts = { id: "job-1", now: () => new Date("2026-05-18T00:00:00.000Z") };

  it("passes a finite maxRetryCount through (incl. 0)", () => {
    expect(normalizeScheduledJob({ ...base, maxRetryCount: 5 }, opts).maxRetryCount).toBe(5);
    expect(normalizeScheduledJob({ ...base, maxRetryCount: 0 }, opts).maxRetryCount).toBe(0);
  });

  it("falls back to the default for absent / non-finite maxRetryCount", () => {
    // Default applies when omitted (unchanged behaviour).
    const dflt = normalizeScheduledJob({ ...base }, opts).maxRetryCount;
    expect(dflt).toBeGreaterThanOrEqual(1);
    // NaN/Infinity must NOT pass through: Math.max(1, NaN) is NaN,
    // which makes runWithRetry's `attempt <= attempts` loop never
    // run so the job silently never dispatches.
    expect(normalizeScheduledJob({ ...base, maxRetryCount: Number.NaN }, opts).maxRetryCount).toBe(dflt);
    expect(normalizeScheduledJob({ ...base, maxRetryCount: Number.POSITIVE_INFINITY }, opts).maxRetryCount).toBe(dflt);
    expect(normalizeScheduledJob({ ...base, maxRetryCount: Number.NEGATIVE_INFINITY }, opts).maxRetryCount).toBe(dflt);
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
