import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mutateTasks, writeTasks } from "@muse/stores";
import { describe, expect, it } from "vitest";

import {
  createLocalArtifactValidator,
  createLocalContinuityTaskInteractionSourceResolver,
  createLocalExactArtifactResolver,
  createPersonalThread,
  buildContinuityInteractionAudit,
  buildContinuityInteractionDigest,
  buildContinuityInteractionReport,
  buildContinuityInteractionProjection,
  linkArtifact,
  openPreparedContinuityPack,
  readAttunementState,
  recordContinuityTaskCompletionInteraction,
  unlinkArtifact,
  type ContinuityInteractionProjectionItem,
  type PersonalThreadKind
} from "./index.js";
import { createOrganicContinuityWriteAuthority } from "./evidence-provenance.js";

function projectionItem(input: {
  readonly completedAt?: string;
  readonly deliveryEvidenceClass?: "organic" | "controlled" | "unclassified";
  readonly deliveryId: string;
  readonly openedAt: string;
  readonly state: "exact" | "none" | "unavailable";
  readonly receiptEvidenceClass?: "organic" | "controlled" | "unclassified";
  readonly threadKind: PersonalThreadKind;
}): ContinuityInteractionProjectionItem {
  return {
    deliveryId: input.deliveryId,
    deliveryEvidenceClass: input.deliveryEvidenceClass ?? "organic",
    interaction: input.state === "exact"
      ? {
          receipt: {
            artifactId: `task_${input.deliveryId}`,
            completedAt: input.completedAt!,
            deliveryId: input.deliveryId,
            doneStateFingerprint: "a".repeat(64),
            eventId: `event_${input.deliveryId}`,
            evidenceClass: input.receiptEvidenceClass ?? "organic",
            id: `receipt_${input.deliveryId}`,
            linkedAt: input.openedAt,
            openStateFingerprint: "b".repeat(64),
            providerId: "local",
            recordedAt: input.completedAt!,
            role: "next-step",
            runId: `run_${input.deliveryId}`,
            threadId: `thread_${input.deliveryId}`,
            transition: "open-to-done"
          },
          state: "exact"
        }
      : input.state === "unavailable"
        ? { reason: "controlled unavailable case", state: "unavailable" }
        : { state: "none" },
    openedAt: input.openedAt,
    ...(input.state === "exact" ? { runId: `run_${input.deliveryId}` } : {}),
    threadId: `thread_${input.deliveryId}`,
    threadKind: input.threadKind
  };
}

describe("Continuity interaction evidence", () => {
  it("counts exact readiness only when both delivery and receipt are organic", () => {
    const organic = projectionItem({
      completedAt: "2026-07-18T00:00:00.001Z",
      deliveryId: "organic-pair",
      openedAt: "2026-07-18T00:00:00.000Z",
      state: "exact",
      threadKind: "life"
    });
    const controlledDelivery = projectionItem({
      completedAt: "2026-07-19T00:00:00.001Z",
      deliveryEvidenceClass: "controlled",
      deliveryId: "controlled-delivery",
      openedAt: "2026-07-19T00:00:00.000Z",
      state: "exact",
      threadKind: "life"
    });
    const controlledReceipt = projectionItem({
      completedAt: "2026-07-20T00:00:00.001Z",
      deliveryId: "controlled-receipt",
      openedAt: "2026-07-20T00:00:00.000Z",
      receiptEvidenceClass: "controlled",
      state: "exact",
      threadKind: "life"
    });

    expect(buildContinuityInteractionAudit([organic, controlledDelivery, controlledReceipt]).byThreadKind.life)
      .toMatchObject({ distinctUtcOpenedDates: 1, exactInteractions: 1, remainingExactInteractions: 9 });
  });

  it("reports an explicit finite collection gap for an empty interaction set", () => {
    expect(buildContinuityInteractionAudit([])).toEqual({
      byThreadKind: {
        life: {
          distinctUtcOpenedDates: 0,
          distinctUtcOpenedDatesTarget: 2,
          exactInteractions: 0,
          exactInteractionsTarget: 10,
          remainingDates: 2,
          remainingExactInteractions: 10
        },
        work: {
          distinctUtcOpenedDates: 0,
          distinctUtcOpenedDatesTarget: 2,
          exactInteractions: 0,
          exactInteractionsTarget: 10,
          remainingDates: 2,
          remainingExactInteractions: 10
        }
      },
      reason: expect.stringContaining("collect"),
      status: "collecting"
    });
  });

  it("requires exact interactions in both kinds across two opened UTC dates before audit", () => {
    const exact = (kind: PersonalThreadKind, count: number, dates: number): ContinuityInteractionProjectionItem[] =>
      Array.from({ length: count }, (_, index) => {
        const day = 18 + (index % dates);
        const openedAt = `2026-07-${day.toString().padStart(2, "0")}T00:00:00.000Z`;
        return projectionItem({
          completedAt: `2026-07-${day.toString().padStart(2, "0")}T00:00:00.001Z`,
          deliveryId: `${kind}_${count.toString()}_${dates.toString()}_${index.toString()}`,
          openedAt,
          state: "exact",
          threadKind: kind
        });
      });

    const complete = [...exact("life", 10, 2), ...exact("work", 10, 2)];
    expect(buildContinuityInteractionAudit(complete)).toMatchObject({
      byThreadKind: {
        life: { distinctUtcOpenedDates: 2, exactInteractions: 10, remainingDates: 0, remainingExactInteractions: 0 },
        work: { distinctUtcOpenedDates: 2, exactInteractions: 10, remainingDates: 0, remainingExactInteractions: 0 }
      },
      status: "audit-required"
    });
    expect(buildContinuityInteractionAudit([...exact("life", 10, 2), ...exact("work", 9, 2)]).status)
      .toBe("collecting");
    expect(buildContinuityInteractionAudit([...exact("life", 10, 2), ...exact("work", 10, 1)]).status)
      .toBe("collecting");
    expect(buildContinuityInteractionAudit(exact("life", 10, 2)).status).toBe("collecting");

    const nonExactAcrossDates = Array.from({ length: 20 }, (_, index) => projectionItem({
      deliveryId: `non_exact_${index.toString()}`,
      openedAt: `2026-08-${(index + 1).toString().padStart(2, "0")}T00:00:00.000Z`,
      state: index % 2 === 0 ? "none" : "unavailable",
      threadKind: index % 2 === 0 ? "life" : "work"
    }));
    expect(buildContinuityInteractionAudit(nonExactAcrossDates)).toMatchObject({
      byThreadKind: { life: { distinctUtcOpenedDates: 0 }, work: { distinctUtcOpenedDates: 0 } },
      status: "collecting"
    });

    const outcomeVariant = complete.map((item, index) => ({
      ...item,
      explicitOutcome: (["used", "adjusted", "ignored", "rejected"] as const)[index % 4]
    }));
    expect(buildContinuityInteractionAudit(outcomeVariant)).toEqual(buildContinuityInteractionAudit(complete));
  });

  it("builds a finite empty digest with explicit zero-sample latency", () => {
    expect(buildContinuityInteractionDigest([])).toEqual({
      byThreadKind: {
        life: {
          completionLatencyMs: { maxMs: null, medianMs: null, minMs: null, p95Ms: null, sampleSize: 0 },
          states: {
            exact: { count: 0, ratio: 0 },
            none: { count: 0, ratio: 0 },
            unavailable: { count: 0, ratio: 0 }
          },
          totalDeliveries: 0
        },
        work: {
          completionLatencyMs: { maxMs: null, medianMs: null, minMs: null, p95Ms: null, sampleSize: 0 },
          states: {
            exact: { count: 0, ratio: 0 },
            none: { count: 0, ratio: 0 },
            unavailable: { count: 0, ratio: 0 }
          },
          totalDeliveries: 0
        }
      },
      overall: {
        completionLatencyMs: { maxMs: null, medianMs: null, minMs: null, p95Ms: null, sampleSize: 0 },
        states: {
          exact: { count: 0, ratio: 0 },
          none: { count: 0, ratio: 0 },
          unavailable: { count: 0, ratio: 0 }
        },
        totalDeliveries: 0
      }
    });
  });

  it("reports the fixed 24-case life/work shadow matrix with nearest-rank latency", () => {
    const openedAt = "2026-07-18T00:00:00.000Z";
    const entries: ContinuityInteractionProjectionItem[] = [];
    for (const [kind, offset] of [["life", 0], ["work", 40]] as const) {
      for (let index = 1; index <= 4; index += 1) {
        entries.push(projectionItem({
          completedAt: `2026-07-18T00:00:00.${String(offset + index * 10).padStart(3, "0")}Z`,
          deliveryId: `${kind}_exact_${index.toString()}`,
          openedAt,
          state: "exact",
          threadKind: kind
        }));
        entries.push(projectionItem({ deliveryId: `${kind}_none_${index.toString()}`, openedAt, state: "none", threadKind: kind }));
        entries.push(projectionItem({ deliveryId: `${kind}_unavailable_${index.toString()}`, openedAt, state: "unavailable", threadKind: kind }));
      }
    }

    const digest = buildContinuityInteractionDigest(entries);

    expect(digest.overall).toEqual({
      completionLatencyMs: { maxMs: 80, medianMs: 40, minMs: 10, p95Ms: 80, sampleSize: 8 },
      states: {
        exact: { count: 8, ratio: 1 / 3 },
        none: { count: 8, ratio: 1 / 3 },
        unavailable: { count: 8, ratio: 1 / 3 }
      },
      totalDeliveries: 24
    });
    expect(digest.byThreadKind.life).toEqual({
      completionLatencyMs: { maxMs: 40, medianMs: 20, minMs: 10, p95Ms: 40, sampleSize: 4 },
      states: {
        exact: { count: 4, ratio: 1 / 3 },
        none: { count: 4, ratio: 1 / 3 },
        unavailable: { count: 4, ratio: 1 / 3 }
      },
      totalDeliveries: 12
    });
    expect(buildContinuityInteractionDigest(entries.map((entry, index) => ({
      ...entry,
      explicitOutcome: (["used", "adjusted", "ignored", "rejected"] as const)[index % 4]
    })))).toEqual(digest);
  });

  it("fails closed instead of publishing a complete-looking digest for invalid exact evidence", () => {
    expect(() => buildContinuityInteractionDigest([projectionItem({
      completedAt: "2026-07-18T00:00:00.000Z",
      deliveryId: "negative",
      openedAt: "2026-07-18T00:00:00.001Z",
      state: "exact",
      threadKind: "work"
    })])).toThrow(/chronology/iu);
    expect(() => buildContinuityInteractionDigest([{
      ...projectionItem({
        completedAt: "2026-07-18T00:00:00.001Z",
        deliveryId: "missing-receipt",
        openedAt: "2026-07-18T00:00:00.000Z",
        state: "exact",
        threadKind: "life"
      }),
      interaction: { state: "exact" }
    }])).toThrow(/receipt/iu);
    expect(() => buildContinuityInteractionDigest([
      projectionItem({ deliveryId: "duplicate", openedAt: "2026-07-18T00:00:00.000Z", state: "none", threadKind: "life" }),
      projectionItem({ deliveryId: "duplicate", openedAt: "2026-07-18T00:00:00.000Z", state: "none", threadKind: "life" })
    ])).toThrow(/duplicate/iu);
    expect(() => buildContinuityInteractionDigest([projectionItem({
      deliveryId: "bad-date",
      openedAt: "not-a-date",
      state: "none",
      threadKind: "work"
    })])).toThrow(/chronology/iu);

    const first = projectionItem({
      completedAt: "2026-07-18T00:00:00.010Z",
      deliveryId: "receipt-a",
      openedAt: "2026-07-18T00:00:00.000Z",
      state: "exact",
      threadKind: "life"
    });
    const second = projectionItem({
      completedAt: "2026-07-18T00:00:00.020Z",
      deliveryId: "receipt-b",
      openedAt: "2026-07-18T00:00:00.000Z",
      state: "exact",
      threadKind: "work"
    });
    expect(() => buildContinuityInteractionDigest([first, {
      ...second,
      interaction: {
        ...second.interaction,
        receipt: { ...second.interaction.receipt!, eventId: first.interaction.receipt!.eventId, id: first.interaction.receipt!.id }
      }
    }])).toThrow(/receipt.*(id|identity|duplicate)/iu);

    expect(() => buildContinuityInteractionDigest([{
      ...first,
      runId: "run_other",
      threadId: "thread_other"
    }])).toThrow(/binding/iu);
    expect(() => buildContinuityInteractionDigest([{
      ...first,
      interaction: {
        ...first.interaction,
        receipt: { ...first.interaction.receipt!, recordedAt: "2026-07-18T00:00:00.005Z" }
      }
    }])).toThrow(/chronology/iu);
    expect(() => buildContinuityInteractionAudit([{
      ...first,
      interaction: {
        ...first.interaction,
        receipt: { ...first.interaction.receipt!, recordedAt: "2026-07-18T00:00:00.005Z" }
      }
    }])).toThrow(/chronology/iu);
  });

  it("records one immutable factual receipt for an anchored task completion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-continuity-interaction-"));
    const attunementFile = join(dir, "attunement.json");
    const notesDir = join(dir, "notes");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{
      createdAt: "2026-07-18T00:00:00.000Z",
      id: "task_exact",
      status: "open",
      title: "Finish the exact task"
    }]);
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "Exact work" }, {
      idFactory: () => "thread"
    });
    await linkArtifact(attunementFile, {
      artifactId: "task_exact",
      artifactType: "task",
      role: "next-step",
      threadId: thread.id
    }, {
      now: () => new Date("2026-07-18T00:30:00.000Z"),
      validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile })
    });
    const organic = createOrganicContinuityWriteAuthority();
    const opened = await openPreparedContinuityPack(
      attunementFile,
      thread.id,
      createLocalExactArtifactResolver({ notesDir, tasksFile }),
      {
        evidenceAuthority: organic,
        idFactory: () => "opened",
        now: () => Date.parse("2026-07-18T01:00:00.000Z")
      }
    );

    expect(opened.delivery.interactionAnchor).toMatchObject({
      artifactId: "task_exact",
      linkedAt: expect.any(String),
      observedStatus: "open",
      providerId: "local",
      role: "next-step"
    });
    expect(opened.delivery.runId).toBe("continuity_run_opened");

    await mutateTasks(tasksFile, (tasks) => tasks.map((task) => task.id === "task_exact"
      ? { ...task, completedAt: "2026-07-18T02:00:00.000Z", status: "done" as const }
      : task));
    const recorded = await recordContinuityTaskCompletionInteraction(
      attunementFile,
      tasksFile,
      "task_exact",
      { evidenceAuthority: organic }
    );
    expect(recorded.kind).toBe("recorded");

    const state = await readAttunementState(attunementFile);
    expect(state.interactionReceipts).toHaveLength(1);
    expect(state.interactionReceipts[0]).toMatchObject({
      artifactId: "task_exact",
      completedAt: "2026-07-18T02:00:00.000Z",
      deliveryId: opened.delivery.id,
      runId: opened.delivery.runId,
      threadId: thread.id,
      transition: "open-to-done"
    });
    expect(state.deliveries[0]?.outcome).toBeUndefined();

    const report = await buildContinuityInteractionReport(
      state,
      createLocalContinuityTaskInteractionSourceResolver(tasksFile)
    );
    expect(report).toMatchObject({
      audit: {
        byThreadKind: { work: { exactInteractions: 1, remainingExactInteractions: 9 } },
        status: "collecting"
      },
      digest: {
        byThreadKind: { work: { completionLatencyMs: { sampleSize: 1 }, totalDeliveries: 1 } },
        overall: { completionLatencyMs: { sampleSize: 1 }, states: { exact: { count: 1 } }, totalDeliveries: 1 }
      },
      interactions: [expect.objectContaining({ threadKind: "work" })],
      schemaVersion: 2
    });

    const beforeReplay = await readFile(attunementFile, "utf8");
    const replay = await recordContinuityTaskCompletionInteraction(attunementFile, tasksFile, "task_exact");
    expect(replay).toEqual(recorded);
    expect(await readFile(attunementFile, "utf8")).toBe(beforeReplay);

    await writeTasks(tasksFile, [{
      completedAt: "2026-07-18T02:00:00.000Z",
      createdAt: "2026-07-18T01:30:00.000Z",
      id: "task_exact",
      status: "done",
      title: "Replacement reusing the event identity"
    }]);
    const beforeIdentityConflict = await readFile(attunementFile, "utf8");
    expect(await recordContinuityTaskCompletionInteraction(attunementFile, tasksFile, "task_exact"))
      .toEqual({ kind: "not-correlated" });
    expect(await readFile(attunementFile, "utf8")).toBe(beforeIdentityConflict);
  });

  it("fails closed after the exact next-step link is replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-continuity-relink-"));
    const attunementFile = join(dir, "attunement.json");
    const notesDir = join(dir, "notes");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{ createdAt: "2026-07-18T00:00:00.000Z", id: "task_relinked", status: "open", title: "Relink me" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "life", title: "Relink" });
    const validator = createLocalArtifactValidator({ notesDir, tasksFile });
    await linkArtifact(attunementFile, {
      artifactId: "task_relinked", artifactType: "task", role: "next-step", threadId: thread.id
    }, { now: () => new Date("2026-07-18T00:30:00.000Z"), validateArtifact: validator });
    const opened = await openPreparedContinuityPack(
      attunementFile,
      thread.id,
      createLocalExactArtifactResolver({ notesDir, tasksFile }),
      { now: () => Date.parse("2026-07-18T01:00:00.000Z") }
    );
    await unlinkArtifact(attunementFile, { artifactId: "task_relinked", artifactType: "task", threadId: thread.id });
    await linkArtifact(attunementFile, {
      artifactId: "task_relinked", artifactType: "task", role: "next-step", threadId: thread.id
    }, { now: () => new Date("2026-07-18T01:30:00.000Z"), validateArtifact: validator });
    await mutateTasks(tasksFile, (tasks) => tasks.map((task) => ({
      ...task, completedAt: "2026-07-18T02:00:00.000Z", status: "done" as const
    })));

    expect(await recordContinuityTaskCompletionInteraction(attunementFile, tasksFile, "task_relinked"))
      .toEqual({ kind: "not-correlated" });
    const state = await readAttunementState(attunementFile);
    expect(state.interactionReceipts).toEqual([]);
    const projection = await buildContinuityInteractionProjection(state, async (artifactId) => ({
      artifactId, createdAt: "2026-07-18T00:00:00.000Z", status: "done", updatedAt: "2026-07-18T02:00:00.000Z"
    }));
    expect(projection.find((entry) => entry.deliveryId === opened.delivery.id)?.interaction)
      .toMatchObject({ state: "unavailable" });
  });

  it("does not guess which delivery caused one completion when two anchors are eligible", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-continuity-ambiguous-"));
    const attunementFile = join(dir, "attunement.json");
    const notesDir = join(dir, "notes");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{ createdAt: "2026-07-18T00:00:00.000Z", id: "task_ambiguous", status: "open", title: "Ambiguous" }]);
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "Ambiguous delivery" });
    await linkArtifact(attunementFile, {
      artifactId: "task_ambiguous", artifactType: "task", role: "next-step", threadId: thread.id
    }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
    const resolver = createLocalExactArtifactResolver({ notesDir, tasksFile });
    await openPreparedContinuityPack(attunementFile, thread.id, resolver, {
      now: () => Date.parse("2026-07-18T01:00:00.000Z")
    });
    await openPreparedContinuityPack(attunementFile, thread.id, resolver, {
      now: () => Date.parse("2026-07-18T01:30:00.000Z")
    });
    await mutateTasks(tasksFile, (tasks) => tasks.map((task) => ({
      ...task, completedAt: "2026-07-18T02:00:00.000Z", status: "done" as const
    })));

    const before = await readFile(attunementFile, "utf8");
    expect(await recordContinuityTaskCompletionInteraction(attunementFile, tasksFile, "task_ambiguous"))
      .toEqual({ kind: "not-correlated" });
    expect(await readFile(attunementFile, "utf8")).toBe(before);
    expect((await readAttunementState(attunementFile)).interactionReceipts).toEqual([]);
  });

  it("fails closed when a different task reuses the anchored task id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-continuity-id-reuse-"));
    const attunementFile = join(dir, "attunement.json");
    const notesDir = join(dir, "notes");
    const tasksFile = join(dir, "tasks.json");
    await writeTasks(tasksFile, [{
      createdAt: "2026-07-18T00:00:00.000Z", id: "same-id", status: "open", title: "Original task"
    }]);
    const thread = await createPersonalThread(attunementFile, { kind: "work", title: "Exact identity" });
    await linkArtifact(attunementFile, {
      artifactId: "same-id", artifactType: "task", role: "next-step", threadId: thread.id
    }, { validateArtifact: createLocalArtifactValidator({ notesDir, tasksFile }) });
    const opened = await openPreparedContinuityPack(
      attunementFile,
      thread.id,
      createLocalExactArtifactResolver({ notesDir, tasksFile }),
      { now: () => Date.parse("2026-07-18T01:00:00.000Z") }
    );
    await writeTasks(tasksFile, [{
      completedAt: "2026-07-18T02:00:00.000Z",
      createdAt: "2026-07-18T01:30:00.000Z",
      id: "same-id",
      status: "done",
      title: "Replacement task"
    }]);

    const before = await readFile(attunementFile, "utf8");
    expect(await recordContinuityTaskCompletionInteraction(attunementFile, tasksFile, "same-id"))
      .toEqual({ kind: "not-correlated" });
    expect(await readFile(attunementFile, "utf8")).toBe(before);
    const projection = await buildContinuityInteractionProjection(
      await readAttunementState(attunementFile),
      createLocalContinuityTaskInteractionSourceResolver(tasksFile)
    );
    expect(projection.find((entry) => entry.deliveryId === opened.delivery.id)?.interaction)
      .toMatchObject({ state: "unavailable" });
  });

  it("reads schema v1 without rewriting and migrates on the first valid mutation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-continuity-v1-"));
    const file = join(dir, "attunement.json");
    const legacy = `${JSON.stringify({
      deliveries: [], nextPolicyVersion: 1, resetReceipts: [], schemaVersion: 1, threads: [], undoResetReceipts: []
    }, null, 2)}\n`;
    await writeFile(file, legacy, { mode: 0o600 });

    const read = await readAttunementState(file);
    expect(read).toMatchObject({ interactionReceipts: [], schemaVersion: 4 });
    expect(await readFile(file, "utf8")).toBe(legacy);

    await createPersonalThread(file, { kind: "work", title: "Migrate once" });
    const migrated = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(migrated).toMatchObject({ interactionReceipts: [], schemaVersion: 4 });
  });
});
