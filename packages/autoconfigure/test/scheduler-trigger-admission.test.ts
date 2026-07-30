import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTriggerEnvelope,
  parseTriggerControlState
} from "@muse/shared";
import {
  DynamicScheduler,
  InMemoryScheduledJobStore,
  ScheduledJobDispatcher,
  TriggerControlFileStore
} from "@muse/scheduler";
import {
  FileTriggerAdmissionJournalStore,
  defaultTriggerAdmissionJournalFile
} from "@muse/stores";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";
import { createScheduledTriggerAdmissionLifecycle } from "../src/scheduler-trigger-admission.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");
const tempRoots: string[] = [];

async function journalFile(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "muse-runtime-trigger-journal-"));
  tempRoots.push(root);
  return join(root, "trigger-admission.json");
}

function envelope(generation: string) {
  return createTriggerEnvelope({
    generation,
    occurredAt: NOW,
    receivedAt: NOW,
    source: "cron",
    sourceId: "daily-brief"
  });
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) =>
    fs.rm(root, { force: true, recursive: true })
  ));
});

describe("scheduled trigger admission runtime wiring", () => {
  it("persists admission before returning an execute ticket and maps settlement", async () => {
    const file = await journalFile();
    const store = new TriggerControlFileStore(file, { maxPending: 2 });
    const lifecycle = createScheduledTriggerAdmissionLifecycle({
      leaseToken: () => "lease-g1",
      now: () => NOW,
      store
    });

    const ticket = await lifecycle({
      automatic: true,
      dryRun: false,
      leaseDurationMs: 5_000,
      trigger: envelope("g1")
    });
    expect(ticket.decision.action).toBe("execute");
    expect(parseTriggerControlState(await fs.readFile(file, "utf8"))).toMatchObject({
      journal: { entries: [{ state: "queued" }] },
      workStates: [{ leaseToken: "lease-g1", status: "leased" }]
    });

    await ticket.settle({
      outcome: "dead-lettered",
      reason: "execution-failed",
      settledAt: new Date("2026-07-30T12:00:01.000Z")
    });
    expect(await store.snapshot()).toMatchObject({
      journal: {
        entries: [{
          state: "dead-lettered",
          terminalReason: "execution-failed"
        }]
      },
      workStates: [{
        status: "dead-lettered",
        terminalReason: "execution-failed"
      }]
    });
  });

  it.each([
    {
      expectedStatus: "completed",
      label: "successful execution",
      settlement: {
        outcome: "completed",
        settledAt: new Date("2026-07-30T12:00:01.000Z")
      } as const
    },
    {
      expectedStatus: "cancelled",
      label: "dry-run cancellation",
      settlement: {
        outcome: "cancelled",
        reason: "dry-run",
        settledAt: new Date("2026-07-30T12:00:01.000Z")
      } as const
    }
  ])("maps $label to matching journal and work terminal state", async ({
    expectedStatus,
    settlement
  }) => {
    const file = await journalFile();
    const store = new TriggerControlFileStore(file, { maxPending: 2 });
    const lifecycle = createScheduledTriggerAdmissionLifecycle({
      leaseToken: () => "lease-terminal",
      now: () => NOW,
      store
    });
    const ticket = await lifecycle({
      automatic: true,
      dryRun: settlement.outcome === "cancelled",
      leaseDurationMs: 5_000,
      trigger: envelope(`terminal-${expectedStatus}`)
    });

    await ticket.settle(settlement);
    expect(await store.snapshot()).toMatchObject({
      journal: { entries: [{ state: expectedStatus }] },
      workStates: [{ status: expectedStatus }]
    });
  });

  it("does not let a duplicate held ticket settle the original queued entry", async () => {
    const file = await journalFile();
    const store = new TriggerControlFileStore(file, { maxPending: 2 });
    const lifecycle = createScheduledTriggerAdmissionLifecycle({
      leaseToken: () => "lease-g1",
      now: () => NOW,
      store
    });
    const input = {
      automatic: true,
      dryRun: false,
      leaseDurationMs: 5_000,
      trigger: envelope("g1")
    };
    await lifecycle(input);
    const duplicate = await lifecycle(input);

    expect(duplicate.decision).toMatchObject({
      action: "reject",
      reasons: ["duplicate"]
    });
    await expect(duplicate.settle({
      outcome: "completed",
      settledAt: new Date("2026-07-30T12:00:01.000Z")
    })).rejects.toThrow(/only execute/u);
    expect(await store.snapshot()).toMatchObject({
      journal: { entries: [{ state: "queued" }] },
      workStates: [{ leaseToken: "lease-g1", status: "leased" }]
    });
  });

  it("blocks dispatch when durable admission state is corrupt", async () => {
    const legacyFile = await journalFile();
    const controlFile = `${legacyFile}.control`;
    await fs.writeFile(legacyFile, "{\"broken\":true}", { mode: 0o600 });
    const execute = vi.fn(async () => "must not run");
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-1" });
    const service = new DynamicScheduler({
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute },
        mcpInvoker: { invoke: async () => "unused" }
      }),
      now: () => NOW,
      store,
      triggerAdmissionLifecycle: createScheduledTriggerAdmissionLifecycle({
        now: () => NOW,
        store: new TriggerControlFileStore(
          controlFile,
          { maxPending: 2 },
          { legacyJournalFile: legacyFile }
        )
      })
    });
    const job = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Durable admission"
    });

    await expect(service.trigger(job.id)).rejects.toMatchObject({ code: "corrupt-state" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks dispatch when durable claim fails after admission", async () => {
    const file = await journalFile();
    const execute = vi.fn(async () => "must not run");
    const control = new TriggerControlFileStore(file, { maxPending: 2 });
    vi.spyOn(control, "claim").mockRejectedValueOnce(new Error("claim unavailable"));
    const store = new InMemoryScheduledJobStore({ idFactory: () => "job-claim-failure" });
    const service = new DynamicScheduler({
      dispatcher: new ScheduledJobDispatcher({
        agentExecutor: { execute },
        mcpInvoker: { invoke: async () => "unused" }
      }),
      now: () => NOW,
      store,
      triggerAdmissionLifecycle: createScheduledTriggerAdmissionLifecycle({
        leaseToken: () => "lease-claim-failure",
        now: () => NOW,
        store: control
      })
    });
    const job = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Claim failure"
    });

    await expect(service.trigger(job.id)).rejects.toThrow("claim unavailable");
    expect(execute).not.toHaveBeenCalled();
    expect(await control.snapshot()).toMatchObject({
      journal: { entries: [{ state: "queued" }] },
      workStates: []
    });
  });

  it("passes the configured durable lifecycle into the production assembly", async () => {
    const file = await journalFile();
    const legacyFile = `${file}.legacy`;
    const legacyStore = new FileTriggerAdmissionJournalStore({
      file: legacyFile,
      maxPending: 256
    });
    await legacyStore.admit({
      envelope: envelope("legacy-production"),
      now: NOW
    });
    const legacyBytes = await fs.readFile(legacyFile);
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_SCHEDULER_CRON_ENABLED: "false",
        MUSE_SCHEDULER_PERSIST: "false",
        MUSE_TASK_MEMORY_PERSIST: "false",
        MUSE_TRIGGER_ADMISSION_JOURNAL_FILE: legacyFile,
        MUSE_TRIGGER_CONTROL_FILE: file
      }
    });
    const lifecycle = (assembly.scheduler.service as unknown as {
      readonly triggerAdmissionLifecycle?: ReturnType<typeof createScheduledTriggerAdmissionLifecycle>;
    }).triggerAdmissionLifecycle;

    expect(lifecycle).toBeTypeOf("function");
    const assemblyNow = new Date();
    const ticket = await lifecycle!({
      automatic: false,
      dryRun: false,
      leaseDurationMs: 5_000,
      trigger: createTriggerEnvelope({
        generation: "assembly",
        occurredAt: assemblyNow,
        receivedAt: assemblyNow,
        source: "manual",
        sourceId: "runtime-wiring"
      })
    });
    expect(ticket.decision.action).toBe("execute");
    expect(await fs.readFile(legacyFile)).toEqual(legacyBytes);
    expect(await new TriggerControlFileStore(file, {
      maxPending: 256
    }).snapshot()).toMatchObject({
      journal: { entries: [{ state: "queued" }, { state: "queued" }] },
      workStates: [{ status: "leased" }]
    });
    await expect(assembly.observability.eventLoopHealthSnapshot()).resolves.toMatchObject({
      journal: { entries: [{ state: "queued" }, { state: "queued" }] },
      workStates: [{ status: "leased" }]
    });
  });

  it("reconciles an expired final lease before production health observes it", async () => {
    const file = await journalFile();
    const legacyFile = `${file}.legacy`;
    const store = new TriggerControlFileStore(file, { maxPending: 256 });
    const occurrence = envelope("expired-production");
    await store.admit({ envelope: occurrence, now: NOW });
    await store.claim({
      at: NOW,
      dedupKey: occurrence.dedupKey,
      leaseDurationMs: 1,
      leaseToken: "expired-production-lease",
      maxAttempts: 1
    });
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_SCHEDULER_CRON_ENABLED: "false",
        MUSE_SCHEDULER_PERSIST: "false",
        MUSE_TASK_MEMORY_PERSIST: "false",
        MUSE_TRIGGER_ADMISSION_JOURNAL_FILE: legacyFile,
        MUSE_TRIGGER_CONTROL_FILE: file
      }
    });

    await expect(assembly.observability.eventLoopHealthSnapshot()).resolves.toMatchObject({
      journal: {
        entries: [{ state: "dead-lettered", terminalReason: "lease-expired" }]
      },
      workStates: [{ status: "dead-lettered", terminalReason: "lease-expired" }]
    });
  });

  it("does not arm cron jobs when startup control recovery fails closed", async () => {
    const file = await journalFile();
    await fs.writeFile(file, "{", { mode: 0o600 });
    const loadEnabledJobs = vi.spyOn(
      DynamicScheduler.prototype,
      "loadEnabledJobs"
    ).mockResolvedValue(0);
    try {
      const assembly = createMuseRuntimeAssembly({
        env: {
          MUSE_SCHEDULER_CRON_ENABLED: "true",
          MUSE_SCHEDULER_PERSIST: "false",
          MUSE_TASK_MEMORY_PERSIST: "false",
          MUSE_TRIGGER_ADMISSION_JOURNAL_FILE: `${file}.legacy`,
          MUSE_TRIGGER_CONTROL_FILE: file
        }
      });

      await expect(assembly.observability.eventLoopHealthSnapshot()).rejects.toMatchObject({
        code: "corrupt-state"
      });
      expect(loadEnabledJobs).not.toHaveBeenCalled();
    } finally {
      loadEnabledJobs.mockRestore();
    }
  });

  it("uses an explicit env override without touching the filesystem", async () => {
    const file = await journalFile();
    await fs.rm(file, { force: true });

    expect(defaultTriggerAdmissionJournalFile({
      MUSE_TRIGGER_ADMISSION_JOURNAL_FILE: file
    })).toBe(file);
    new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
