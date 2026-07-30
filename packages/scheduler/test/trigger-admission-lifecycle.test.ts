import { describe, expect, it, vi } from "vitest";

import {
  DynamicScheduler,
  InMemoryScheduledJobStore,
  ScheduledJobDispatcher,
  SchedulerMessaging,
  type DistributedSchedulerLock,
  type ScheduledTriggerAdmissionTicket
} from "../src/index.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

function dispatcher(execute: () => Promise<string>): ScheduledJobDispatcher {
  return new ScheduledJobDispatcher({
    agentExecutor: { execute },
    mcpInvoker: { invoke: async () => "unused" }
  });
}

async function setup(options: {
  readonly execute?: () => Promise<string>;
  readonly configureStore?: (store: InMemoryScheduledJobStore) => void;
  readonly lock?: DistributedSchedulerLock;
  readonly messagingService?: SchedulerMessaging;
  readonly notificationChannelId?: string;
  readonly ticket: (dedupKey: string) => ScheduledTriggerAdmissionTicket;
}) {
  const store = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
  options.configureStore?.(store);
  const service = new DynamicScheduler({
    dispatcher: dispatcher(options.execute ?? (async () => "done")),
    ...(options.lock ? { distributedLock: options.lock } : {}),
    ...(options.messagingService ? { messagingService: options.messagingService } : {}),
    now: () => NOW,
    store,
    triggerAdmissionLifecycle: async ({ trigger }) => options.ticket(trigger.dedupKey)
  });
  const job = await service.create({
    agentPrompt: "Run",
    cronExpression: "0 * * * * *",
    jobType: "agent",
    name: "Lifecycle job",
    ...(options.notificationChannelId
      ? { notificationChannelId: options.notificationChannelId }
      : {})
  });
  return { job, service, store };
}

function executeTicket(
  dedupKey: string,
  settle: ScheduledTriggerAdmissionTicket["settle"]
): ScheduledTriggerAdmissionTicket {
  return {
    decision: { action: "execute", dedupKey, reasons: [] },
    settle
  };
}

describe("DynamicScheduler trigger admission lifecycle", () => {
  it("bounds the durable work lease to the validated execution timeout plus lock buffer", async () => {
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-lease-bound" });
    const observedLeaseDurations: number[] = [];
    const service = new DynamicScheduler({
      dispatcher: dispatcher(async () => "done"),
      lockTtlBufferMs: 1_000,
      now: () => NOW,
      store,
      triggerAdmissionLifecycle: async ({ leaseDurationMs, trigger }) => {
        observedLeaseDurations.push(leaseDurationMs);
        return executeTicket(trigger.dedupKey, async () => undefined);
      }
    });
    const job = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      executionTimeoutMs: 20_000,
      jobType: "agent",
      name: "Lease bound"
    });

    await expect(service.trigger(job.id)).resolves.toBe("done");
    expect(observedLeaseDurations).toEqual([21_000]);
  });

  it("settles a successful execution exactly once as completed", async () => {
    const settle = vi.fn(async () => undefined);
    const { job, service } = await setup({
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    await expect(service.trigger(job.id)).resolves.toBe("done");
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      outcome: "completed",
      settledAt: NOW
    });
  });

  it("settles a terminal execution failure exactly once as dead-lettered", async () => {
    const settle = vi.fn(async () => undefined);
    const { job, service } = await setup({
      execute: async () => {
        throw new Error("boom");
      },
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    await expect(service.trigger(job.id)).resolves.toContain("failed: boom");
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      outcome: "dead-lettered",
      reason: "execution-failed",
      settledAt: NOW
    });
  });

  it("settles lock refusal without dispatching or releasing an unowned lock", async () => {
    const settle = vi.fn(async () => undefined);
    const execute = vi.fn(async () => "must not run");
    const release = vi.fn(async () => undefined);
    const { job, service } = await setup({
      execute,
      lock: {
        release,
        tryAcquire: async () => false
      },
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    await expect(service.trigger(job.id)).resolves.toBe("skipped: another instance holds lock");
    expect(execute).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      outcome: "cancelled",
      reason: "lock-unavailable",
      settledAt: NOW
    });
  });

  it("still settles lock refusal when recording the skip fails", async () => {
    const settle = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const { job, service } = await setup({
      configureStore: (store) => {
        const update = store.updateExecutionResult.bind(store);
        vi.spyOn(store, "updateExecutionResult").mockImplementation(async (id, status, result) => {
          if (status === "skipped") throw new Error("skip record unavailable");
          return update(id, status, result);
        });
      },
      lock: {
        release,
        tryAcquire: async () => false
      },
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    await expect(service.trigger(job.id)).rejects.toThrow("skip record unavailable");
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      outcome: "cancelled",
      reason: "lock-unavailable",
      settledAt: NOW
    });
    expect(release).not.toHaveBeenCalled();
  });

  it("settles dry-run admission as cancelled without acquiring a lock", async () => {
    const settle = vi.fn(async () => undefined);
    const tryAcquire = vi.fn(async () => true);
    const { job, service } = await setup({
      lock: {
        release: async () => undefined,
        tryAcquire
      },
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    await expect(service.dryRun(job.id)).resolves.toBe("done");
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      outcome: "cancelled",
      reason: "dry-run",
      settledAt: NOW
    });
  });

  it.each([
    ["shadow", "delivery-brake"],
    ["reject", "permission-denied"]
  ] as const)("never dispatches or settles a held %s admission", async (action, reason) => {
    const settle = vi.fn(async () => undefined);
    const execute = vi.fn(async () => "must not run");
    const { job, service } = await setup({
      execute,
      ticket: (dedupKey) => ({
        decision: { action, dedupKey, reasons: [reason] },
        settle
      })
    });

    await expect(service.trigger(job.id)).resolves.toBe(`${action}: ${reason}`);
    expect(execute).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it.each([
    ["notification", new SchedulerMessaging({
      sendMessage: async () => {
        throw new Error("notification unavailable");
      }
    }), undefined],
    ["success status", undefined, (store: InMemoryScheduledJobStore) => {
      const update = store.updateExecutionResult.bind(store);
      vi.spyOn(store, "updateExecutionResult").mockImplementation(async (id, status, result) => {
        if (status === "success") throw new Error("success record unavailable");
        return update(id, status, result);
      });
    }]
  ] as const)("dead-letters a %s failure and releases the acquired lock", async (
    _label,
    messagingService,
    configureStore
  ) => {
    const settle = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const { job, service } = await setup({
      ...(configureStore ? { configureStore } : {}),
      lock: {
        release,
        tryAcquire: async () => true
      },
      ...(messagingService ? {
        messagingService,
        notificationChannelId: "owner"
      } : {}),
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    await expect(service.trigger(job.id)).resolves.toContain("failed:");
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({
      outcome: "dead-lettered",
      reason: "execution-failed",
      settledAt: NOW
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("settles and releases the lock even when failure recording rejects with a falsy value", async () => {
    const settle = vi.fn(async () => undefined);
    const release = vi.fn(async () => undefined);
    const { job, service } = await setup({
      configureStore: (store) => {
        const update = store.updateExecutionResult.bind(store);
        vi.spyOn(store, "updateExecutionResult").mockImplementation(async (id, status, result) => {
          if (status === "failed") return Promise.reject(undefined);
          return update(id, status, result);
        });
      },
      execute: async () => {
        throw new Error("boom");
      },
      lock: {
        release,
        tryAcquire: async () => true
      },
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    const sentinel = Symbol("not-rejected");
    let rejection: unknown = sentinel;
    try {
      await service.trigger(job.id);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeUndefined();
    expect(settle).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("turns settlement failure into a failed job without retrying settlement", async () => {
    const settle = vi.fn(async () => {
      throw new Error("settlement unavailable");
    });
    const release = vi.fn(async () => undefined);
    const { job, service, store } = await setup({
      lock: {
        release,
        tryAcquire: async () => true
      },
      ticket: (dedupKey) => executeTicket(dedupKey, settle)
    });

    await expect(service.trigger(job.id)).resolves.toContain("failed: settlement unavailable");
    expect(settle).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(store.findById(job.id)).toMatchObject({ lastStatus: "failed" });
  });

  it("preserves legacy execute success and falsy failure-recording rejection", async () => {
    let fail = false;
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-legacy" });
    const service = new DynamicScheduler({
      dispatcher: dispatcher(async () => {
        if (fail) throw new Error("legacy boom");
        return "legacy done";
      }),
      now: () => NOW,
      store,
      triggerAdmission: async (trigger) => ({
        action: "execute",
        dedupKey: trigger.dedupKey,
        reasons: []
      })
    });
    const job = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Legacy job"
    });

    await expect(service.trigger(job.id)).resolves.toBe("legacy done");

    const update = store.updateExecutionResult.bind(store);
    vi.spyOn(store, "updateExecutionResult").mockImplementation(async (id, status, result) => {
      if (status === "failed") return Promise.reject(undefined);
      return update(id, status, result);
    });
    fail = true;
    const sentinel = Symbol("not-rejected");
    let rejection: unknown = sentinel;
    try {
      await service.trigger(job.id);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeUndefined();
  });

  it("rejects ambiguous legacy and lifecycle admission configuration", () => {
    expect(() => new DynamicScheduler({
      dispatcher: dispatcher(async () => "done"),
      store: new InMemoryScheduledJobStore(),
      triggerAdmission: async (trigger) => ({
        action: "execute",
        dedupKey: trigger.dedupKey,
        reasons: []
      }),
      triggerAdmissionLifecycle: async ({ trigger }) =>
        executeTicket(trigger.dedupKey, async () => undefined)
    })).toThrow(/mutually exclusive/u);
  });
});
