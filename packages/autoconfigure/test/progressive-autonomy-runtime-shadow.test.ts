import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentRuntime } from "@muse/agent-core";
import { createPersonalThread, linkArtifact } from "@muse/attunement";
import { createTasksMcpServer } from "@muse/domain-tools";
import { createLoopbackMcpMuseTools } from "@muse/mcp";
import type { ModelProvider } from "@muse/model";
import { createToolExposureAuthority, fingerprintLocalTaskSnapshot } from "@muse/policy";
import { readTasks, writeTasks } from "@muse/stores";
import { ToolRegistry, createDefaultToolExposurePolicy } from "@muse/tools";
import { afterEach, describe, expect, it } from "vitest";
import { FileProgressiveAutonomyAdminStore } from "@muse/stores/host-progressive-autonomy";
import { FileProgressiveAutonomyOpportunityStore } from "@muse/stores/host-progressive-autonomy-opportunities";

import {
  createMuseRuntimeAssembly,
  createProgressiveAutonomyToolOpportunityObserver,
  observeProgressiveAutonomyToolOpportunity
} from "../src/index.js";

describe("progressive autonomy organic runtime shadow", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("defaults public observations to unclassified, permits controlled only, and ignores forged organic input", async () => {
    const fixture = await createFixture();
    const defaultReceipt = await observe(fixture, "run-default", "call-1");
    const controlled = await observeProgressiveAutonomyToolOpportunity({
      arguments: { id: fixture.taskId }, runId: "run-controlled", toolCallId: "call-1",
      toolName: "muse.tasks.complete", userId: "dogfood-user"
    }, { ...fixture, evidenceClass: "controlled", now: () => new Date("2026-07-17T03:00:00.000Z") } as never);
    const forged = await observeProgressiveAutonomyToolOpportunity({
      arguments: { id: fixture.taskId }, runId: "run-forged", toolCallId: "call-1",
      toolName: "muse.tasks.complete", userId: "dogfood-user"
    }, { ...fixture, evidenceClass: "organic", now: () => new Date("2026-07-17T03:00:00.000Z") } as never);

    expect(defaultReceipt?.evidenceClass).toBe("unclassified");
    expect(controlled?.evidenceClass).toBe("controlled");
    expect(forged?.evidenceClass).toBe("unclassified");
  });

  it("binds organic provenance only inside createMuseRuntimeAssembly", async () => {
    const fixture = await createFixture();
    const assembly = createMuseRuntimeAssembly({ env: {
      HOME: fixture.dir,
      MUSE_ATTUNEMENT_FILE: fixture.attunementFile,
      MUSE_MODEL: "diagnostic/smoke",
      MUSE_MODEL_PROVIDER_ID: "diagnostic",
      MUSE_PROGRESSIVE_AUTONOMY_FILE: fixture.autonomyFile,
      MUSE_PROGRESSIVE_AUTONOMY_OPPORTUNITIES_FILE: fixture.opportunitiesFile,
      MUSE_SCHEDULER_PERSIST: "false",
      MUSE_TASKS_FILE: fixture.tasksFile,
      MUSE_TASK_MEMORY_PERSIST: "false"
    } });
    const observer = (assembly.agentRuntime as unknown as {
      readonly toolOpportunityObserver?: (input: {
        readonly arguments: Readonly<Record<string, unknown>>;
        readonly runId: string;
        readonly toolCallId: string;
        readonly toolName: string;
        readonly userId?: string;
      }) => Promise<unknown>;
    }).toolOpportunityObserver;
    expect(observer).toBeTypeOf("function");
    await observer!({
      arguments: { id: fixture.taskId }, runId: "run-assembly", toolCallId: "call-1",
      toolName: "muse.tasks.complete", userId: "dogfood-user"
    });

    expect(await new FileProgressiveAutonomyOpportunityStore({ file: fixture.opportunitiesFile }).list())
      .toMatchObject([{ evidenceClass: "organic" }]);
  });

  it("records one schema-valid muse.tasks.complete proposal before a denying approval gate and leaves the real task unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-runtime-autonomy-shadow-"));
    dirs.push(dir);
    const tasksFile = join(dir, "tasks.json");
    const attunementFile = join(dir, "attunement.json");
    const autonomyFile = join(dir, "progressive-autonomy.json");
    const opportunitiesFile = join(dir, "progressive-autonomy-opportunities.json");
    await writeTasks(tasksFile, [{ createdAt: "2026-07-17T00:00:00.000Z", id: "task-next", status: "open", title: "Finish the linked next step" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Life" }, {
      idFactory: () => "thread-life",
      now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    await linkArtifact(attunementFile, {
      artifactId: "task-next",
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      now: () => new Date("2026-07-17T02:00:00.000Z"),
      validateArtifact: async (input) => input
    });

    let turn = 0;
    const provider: ModelProvider = {
      id: "runtime-shadow-test",
      async generate(request) {
        turn += 1;
        return turn === 1
          ? { id: "proposal", model: request.model, output: "Completing it.", toolCalls: [{ arguments: { id: "task-next" }, id: "call-complete", name: "muse.tasks.complete" }] }
          : { id: "final", model: request.model, output: "The completion still needs approval." };
      },
      async listModels() { return []; },
      async *stream() { /* unused */ }
    };
    const tools = createLoopbackMcpMuseTools(createTasksMcpServer({ file: tasksFile }));
    const runtime = createAgentRuntime({
      modelProvider: provider,
      toolApprovalGate: () => ({ allowed: false, reason: "test denial" }),
      toolExposurePolicy: createDefaultToolExposurePolicy({ allowWriteWithoutMutationIntent: true }),
      toolOpportunityObserver: createProgressiveAutonomyToolOpportunityObserver({
        attunementFile,
        autonomyFile,
        now: () => new Date("2026-07-17T03:00:00.000Z"),
        opportunitiesFile,
        tasksFile
      }),
      toolRegistry: new ToolRegistry(tools)
    });

    await runtime.run({
      messages: [{ content: "Mark the exact linked task complete", role: "user" }],
      metadata: { userId: "dogfood-user" },
      model: "provider/model",
      runId: "runtime-run-1",
      toolExposureAuthority: createToolExposureAuthority({ allowedToolNames: ["muse.tasks.complete"], localMode: true })
    });

    const persisted = JSON.parse(await readFile(opportunitiesFile, "utf8")) as { readonly opportunities: readonly unknown[] };
    expect(persisted.opportunities).toHaveLength(1);
    expect(await readTasks(tasksFile)).toMatchObject([{ id: "task-next", status: "open" }]);
  });

  it("classifies no grant as wouldConfirm and deterministically selects the earliest exact active grant", async () => {
    const fixture = await createFixture();
    const noGrant = await observe(fixture, "run-no-grant", "call-1");
    expect(noGrant).toMatchObject({ shadowAssessment: "wouldConfirm", shadowRationale: "no exact active standing grant" });

    const authorization = {};
    const admin = new FileProgressiveAutonomyAdminStore({
      file: fixture.autonomyFile,
      verifyUserAuthorization: (candidate) => candidate === authorization
    });
    const grantInput = {
      action: "muse.tasks.complete-linked-next-step" as const,
      executorVersion: 1,
      link: {
        artifactType: "task" as const,
        linkedAt: fixture.linkedAt,
        providerId: "local" as const,
        role: "next-step" as const,
        taskId: fixture.taskId
      },
      maxUses: 5,
      policyVersion: 1,
      schemaVersion: 1 as const,
      threadId: fixture.threadId,
      transition: { from: "open" as const, to: "done" as const },
      userId: "dogfood-user"
    };
    await admin.issueGrant(authorization, { ...grantInput, expiresAt: "2026-07-20T00:00:00.000Z" }, {
      idFactory: () => "grant-later",
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    await admin.issueGrant(authorization, { ...grantInput, expiresAt: "2026-07-19T00:00:00.000Z" }, {
      idFactory: () => "grant-earlier",
      now: () => new Date("2026-07-17T00:00:01.000Z")
    });

    const active = await observe(fixture, "run-active", "call-1");
    expect(active).toMatchObject({ matchedGrantId: "grant-earlier", shadowAssessment: "wouldAllowStanding" });
    expect((await admin.listGrantRecords()).map((record) => record.usedCount)).toEqual([0, 0]);
  });

  it("does not match revoked or expired grants", async () => {
    const fixture = await createFixture();
    const authorization = {};
    const admin = new FileProgressiveAutonomyAdminStore({
      file: fixture.autonomyFile,
      verifyUserAuthorization: (candidate) => candidate === authorization
    });
    const input = {
      action: "muse.tasks.complete-linked-next-step" as const,
      executorVersion: 1,
      expiresAt: "2026-07-18T00:00:00.000Z",
      link: { artifactType: "task" as const, linkedAt: fixture.linkedAt, providerId: "local" as const, role: "next-step" as const, taskId: fixture.taskId },
      maxUses: 1,
      policyVersion: 1,
      schemaVersion: 1 as const,
      threadId: fixture.threadId,
      transition: { from: "open" as const, to: "done" as const },
      userId: "dogfood-user"
    };
    const revoked = await admin.issueGrant(authorization, input, {
      idFactory: () => "grant-revoked",
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    await admin.revokeGrant(authorization, revoked.id, { now: () => new Date("2026-07-17T01:00:00.000Z") });

    expect(await observe(fixture, "run-revoked", "call-1")).toMatchObject({ shadowAssessment: "wouldConfirm" });
    expect(await observe(fixture, "run-expired", "call-1", new Date("2026-07-19T00:00:00.000Z")))
      .toMatchObject({ shadowAssessment: "wouldConfirm" });

    const exhaustedGrant = await admin.issueGrant(authorization, {
      ...input,
      expiresAt: "2026-07-20T00:00:00.000Z"
    }, { idFactory: () => "grant-exhausted", now: () => new Date("2026-07-17T01:30:00.000Z") });
    const before = { createdAt: "2026-07-17T00:00:00.000Z", id: fixture.taskId, status: "open" as const, title: "Finish the linked next step" };
    const intendedAfter = { ...before, completedAt: "2026-07-17T01:31:00.000Z", status: "done" as const };
    const envelope = {
      action: exhaustedGrant.action,
      idempotencyKey: "exhaust-grant-once",
      link: exhaustedGrant.link,
      schemaVersion: exhaustedGrant.schemaVersion,
      threadId: exhaustedGrant.threadId,
      traceId: "exhaust-grant-once",
      transition: exhaustedGrant.transition,
      userId: exhaustedGrant.userId
    };
    const executor = admin.executorStore();
    await executor.prepareExecution({
      before,
      beforeFingerprint: fingerprintLocalTaskSnapshot(before),
      envelope,
      executionId: "exhaust-grant-once",
      grantId: exhaustedGrant.id,
      intendedAfter,
      intendedAfterFingerprint: fingerprintLocalTaskSnapshot(intendedAfter),
      preparedAt: "2026-07-17T01:31:00.000Z"
    });
    await executor.claimExecution("exhaust-grant-once", {
      executorVersion: 1,
      mode: "live",
      now: () => new Date("2026-07-17T01:32:00.000Z"),
      policyVersion: 1,
      validateAuthority: async () => ({ authorityStatus: "exact" })
    });
    expect(await observe(fixture, "run-exhausted", "call-1"))
      .toMatchObject({ shadowAssessment: "wouldConfirm" });
  });

  it("dedupes exact replay without a write, tracks a new tool-call trace without recounting the logical opportunity, and rejects trace scope conflicts", async () => {
    const fixture = await createFixture();
    const first = await observe(fixture, "run-replay", "call-1");
    const firstBytes = await readFile(fixture.opportunitiesFile, "utf8");
    await observe(fixture, "run-replay", "call-1", new Date("2026-07-17T04:00:00.000Z"));
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(firstBytes);

    await observe(fixture, "run-replay", "call-2");
    const store = new FileProgressiveAutonomyOpportunityStore({ file: fixture.opportunitiesFile });
    expect(await store.list()).toHaveLength(1);
    const bytesBeforeConflict = await readFile(fixture.opportunitiesFile, "utf8");
    await expect(store.record({
      ...first!,
      envelope: {
        ...first!.envelope,
        idempotencyKey: "runtime-opportunity:run-replay:different-task",
        link: { ...first!.envelope.link, taskId: "different-task" }
      }
    })).rejects.toThrow("different scope");
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(bytesBeforeConflict);
  });

  it("ignores missing, closed, and multiply-linked local next steps", async () => {
    const malformed = await createFixture();
    expect(await observeProgressiveAutonomyToolOpportunity({
      arguments: { id: "   " },
      runId: "run-malformed",
      toolCallId: "call-1",
      toolName: "muse.tasks.complete",
      userId: "dogfood-user"
    }, { ...malformed, now: () => new Date("2026-07-17T03:00:00.000Z") })).toBeUndefined();
    expect(await observeProgressiveAutonomyToolOpportunity({
      arguments: { id: malformed.taskId },
      runId: "run-other-tool",
      toolCallId: "call-1",
      toolName: "external.tasks.complete",
      userId: "dogfood-user"
    }, { ...malformed, now: () => new Date("2026-07-17T03:00:00.000Z") })).toBeUndefined();

    const missing = await createFixture({ task: false });
    expect(await observe(missing, "run-missing", "call-1")).toBeUndefined();

    const closed = await createFixture({ closed: true });
    expect(await observe(closed, "run-closed", "call-1")).toBeUndefined();

    const ambiguous = await createFixture();
    const second = await createPersonalThread(ambiguous.attunementFile, { kind: "work", title: "Work" }, {
      idFactory: () => "thread-work",
      now: () => new Date("2026-07-17T02:30:00.000Z")
    });
    await linkArtifact(ambiguous.attunementFile, {
      artifactId: ambiguous.taskId,
      artifactType: "task",
      role: "next-step",
      threadId: second.id
    }, { now: () => new Date("2026-07-17T02:31:00.000Z"), validateArtifact: async (input) => input });
    expect(await observe(ambiguous, "run-ambiguous", "call-1")).toBeUndefined();
  });

  it("records corrupt grant authority as wouldDeny and never overwrites corrupt opportunity evidence", async () => {
    const fixture = await createFixture();
    const corruptAuthority = "{bad authority\n";
    await writeFile(fixture.autonomyFile, corruptAuthority, "utf8");
    expect(await observe(fixture, "run-corrupt-authority", "call-1")).toMatchObject({
      shadowAssessment: "wouldDeny",
      shadowRationale: "exact current link authority is unavailable"
    });
    expect(await readFile(fixture.autonomyFile, "utf8")).toBe(corruptAuthority);

    const corruptOpportunities = JSON.stringify({ schemaVersion: 999, opportunities: [], traces: [] });
    await writeFile(fixture.opportunitiesFile, corruptOpportunities, "utf8");
    await expect(observe(fixture, "run-corrupt-opportunities", "call-1")).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(fixture.opportunitiesFile, "utf8")).toBe(corruptOpportunities);
  });

  async function createFixture(options: { readonly closed?: boolean; readonly task?: boolean } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "muse-runtime-autonomy-adapter-"));
    dirs.push(dir);
    const fixture = {
      attunementFile: join(dir, "attunement.json"),
      autonomyFile: join(dir, "progressive-autonomy.json"),
      dir,
      linkedAt: "2026-07-17T02:00:00.000Z",
      opportunitiesFile: join(dir, "progressive-autonomy-opportunities.json"),
      taskId: "task-next",
      tasksFile: join(dir, "tasks.json"),
      threadId: "thread-life"
    };
    if (options.task !== false) {
      await writeTasks(fixture.tasksFile, [{
        ...(options.closed ? { completedAt: "2026-07-17T02:30:00.000Z" } : {}),
        createdAt: "2026-07-17T00:00:00.000Z",
        id: fixture.taskId,
        status: options.closed ? "done" : "open",
        title: "Finish the linked next step"
      }]);
    }
    const thread = await createPersonalThread(fixture.attunementFile, { kind: "life", title: "Life" }, {
      idFactory: () => fixture.threadId,
      now: () => new Date("2026-07-17T01:00:00.000Z")
    });
    await linkArtifact(fixture.attunementFile, {
      artifactId: fixture.taskId,
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, { now: () => new Date(fixture.linkedAt), validateArtifact: async (input) => input });
    return { ...fixture, threadId: thread.id };
  }

  function observe(fixture: Awaited<ReturnType<typeof createFixture>>, runId: string, toolCallId: string, now = new Date("2026-07-17T03:00:00.000Z")) {
    return observeProgressiveAutonomyToolOpportunity({
      arguments: { id: fixture.taskId },
      runId,
      toolCallId,
      toolName: "muse.tasks.complete",
      userId: "dogfood-user"
    }, { ...fixture, now: () => now });
  }
});
