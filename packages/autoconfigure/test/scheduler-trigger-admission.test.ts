import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTriggerEnvelope,
  parseTriggerAdmissionJournal
} from "@muse/shared";
import {
  DynamicScheduler,
  InMemoryScheduledJobStore,
  ScheduledJobDispatcher
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
    const store = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    const lifecycle = createScheduledTriggerAdmissionLifecycle({
      now: () => NOW,
      store
    });

    const ticket = await lifecycle({
      automatic: true,
      dryRun: false,
      trigger: envelope("g1")
    });
    expect(ticket.decision.action).toBe("execute");
    expect(parseTriggerAdmissionJournal(await fs.readFile(file, "utf8")).entries)
      .toMatchObject([{ state: "queued" }]);

    await ticket.settle({
      outcome: "dead-lettered",
      reason: "execution-failed",
      settledAt: new Date("2026-07-30T12:00:01.000Z")
    });
    expect((await store.read()).entries).toMatchObject([{
      state: "dead-lettered",
      terminalReason: "execution-failed"
    }]);
  });

  it("does not let a duplicate held ticket settle the original queued entry", async () => {
    const file = await journalFile();
    const store = new FileTriggerAdmissionJournalStore({ file, maxPending: 2 });
    const lifecycle = createScheduledTriggerAdmissionLifecycle({
      now: () => NOW,
      store
    });
    const input = { automatic: true, dryRun: false, trigger: envelope("g1") };
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
    expect((await store.read()).entries).toMatchObject([{ state: "queued" }]);
  });

  it("blocks dispatch when durable admission state is corrupt", async () => {
    const file = await journalFile();
    await fs.writeFile(file, "{\"broken\":true}", "utf8");
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
        store: new FileTriggerAdmissionJournalStore({ file, maxPending: 2 })
      })
    });
    const job = await service.create({
      agentPrompt: "Run",
      cronExpression: "0 * * * * *",
      jobType: "agent",
      name: "Durable admission"
    });

    await expect(service.trigger(job.id)).rejects.toThrow(/invalid trigger admission journal/u);
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes the configured durable lifecycle into the production assembly", async () => {
    const file = await journalFile();
    const assembly = createMuseRuntimeAssembly({
      env: {
        MUSE_SCHEDULER_CRON_ENABLED: "false",
        MUSE_SCHEDULER_PERSIST: "false",
        MUSE_TASK_MEMORY_PERSIST: "false",
        MUSE_TRIGGER_ADMISSION_JOURNAL_FILE: file
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
      trigger: createTriggerEnvelope({
        generation: "assembly",
        occurredAt: assemblyNow,
        receivedAt: assemblyNow,
        source: "manual",
        sourceId: "runtime-wiring"
      })
    });
    expect(ticket.decision.action).toBe("execute");
    expect((await new FileTriggerAdmissionJournalStore({
      file,
      maxPending: 256
    }).read()).entries).toHaveLength(1);
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
