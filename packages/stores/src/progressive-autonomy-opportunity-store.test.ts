import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileProgressiveAutonomyOpportunityStore,
  type ProgressiveAutonomyRuntimeOpportunityReceipt
} from "./progressive-autonomy-opportunity-store.js";

describe("FileProgressiveAutonomyOpportunityStore public evidence contract", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("reads schema v1 as unclassified without rewriting bytes", async () => {
    const { file, store } = await fixture();
    const { evidenceClass: _evidenceClass, ...legacy } = receipt();
    const raw = `${JSON.stringify({
      opportunities: [legacy],
      schemaVersion: 1,
      traces: [{ envelope: legacy.envelope, runId: legacy.runId, toolCallId: legacy.toolCallId }]
    }, null, 2)}\n`;
    await writeFile(file, raw, "utf8");

    expect(await store.list()).toEqual([{ ...legacy, evidenceClass: "unclassified" }]);
    expect(await readFile(file, "utf8")).toBe(raw);

    const next = receipt();
    await store.record({
      ...next,
      envelope: {
        ...next.envelope,
        idempotencyKey: "runtime-opportunity:run-2:task-next",
        traceId: "runtime-tool:run-2:call-1"
      },
      id: "opportunity-2",
      runId: "run-2"
    });
    const migrated = JSON.parse(await readFile(file, "utf8")) as {
      opportunities: Array<{ evidenceClass: string }>;
      reviews: unknown[];
      schemaVersion: number;
    };
    expect(migrated).toMatchObject({ schemaVersion: 2, reviews: [] });
    expect(migrated.opportunities.map((entry) => entry.evidenceClass)).toEqual(["unclassified", "unclassified"]);
  });

  it("records one normalized organic review, replays without writing, conflicts on change, and fails closed on cross-record corruption", async () => {
    const { file, store } = await fixture();
    const opportunity = { ...receipt(), evidenceClass: "organic" as const };
    await store.record(opportunity);
    const review = {
      action: opportunity.envelope.action,
      decision: "would-deny" as const,
      evidenceClass: "organic" as const,
      id: "review-1",
      linkedAt: opportunity.envelope.link.linkedAt,
      opportunityId: opportunity.id,
      ownerUserId: opportunity.envelope.userId,
      reason: "  not yet  ",
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: opportunity.runId,
      sourceState: "exact" as const,
      taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId,
      toolCallId: opportunity.toolCallId
    };
    expect(await store.recordReview(review)).toMatchObject({ reason: "not yet" });
    const exactBytes = await readFile(file, "utf8");
    expect(await store.recordReview({
      ...review, id: "review-replay", reason: "not yet", recordedAt: "2026-07-17T05:00:00.000Z"
    })).toMatchObject({ id: "review-1", reason: "not yet" });
    expect(await readFile(file, "utf8")).toBe(exactBytes);
    await expect(store.recordReview({ ...review, decision: "would-approve" }))
      .rejects.toThrow("already has a different review");
    expect(await readFile(file, "utf8")).toBe(exactBytes);

    const corrupt = JSON.parse(exactBytes) as { reviews: Array<{ ownerUserId: string }> };
    corrupt.reviews[0]!.ownerUserId = "different-user";
    const corruptBytes = JSON.stringify(corrupt);
    await writeFile(file, corruptBytes, "utf8");
    await expect(store.listReviews()).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(file, "utf8")).toBe(corruptBytes);
  });

  it("normalizes a blank candidate reason to absent while persisted blank reason remains corrupt", async () => {
    const { file, store } = await fixture();
    const opportunity = { ...receipt(), evidenceClass: "organic" as const };
    await store.record(opportunity);
    const recorded = await store.recordReview({
      action: opportunity.envelope.action,
      decision: "needs-adjustment",
      evidenceClass: "organic",
      id: "review-blank",
      linkedAt: opportunity.envelope.link.linkedAt,
      opportunityId: opportunity.id,
      ownerUserId: opportunity.envelope.userId,
      reason: "   ",
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: opportunity.runId,
      sourceState: "exact",
      taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId,
      toolCallId: opportunity.toolCallId
    });
    expect(recorded).not.toHaveProperty("reason");

    const state = JSON.parse(await readFile(file, "utf8")) as { reviews: Array<Record<string, unknown>> };
    state.reviews[0]!.reason = "   ";
    const corruptBytes = JSON.stringify(state);
    await writeFile(file, corruptBytes, "utf8");
    await expect(store.listReviews()).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(file, "utf8")).toBe(corruptBytes);
  });

  it("rejects would-approve with stale source as a candidate or persisted full-state corruption without overwriting bytes", async () => {
    const { file, store } = await fixture();
    const opportunity = { ...receipt(), evidenceClass: "organic" as const };
    await store.record(opportunity);
    const staleApproval = {
      action: opportunity.envelope.action,
      decision: "would-approve" as const,
      evidenceClass: "organic" as const,
      id: "review-stale-approve",
      linkedAt: opportunity.envelope.link.linkedAt,
      opportunityId: opportunity.id,
      ownerUserId: opportunity.envelope.userId,
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: opportunity.runId,
      sourceReason: "recorded task is no longer open",
      sourceState: "stale" as const,
      taskId: opportunity.envelope.link.taskId,
      threadId: opportunity.envelope.threadId,
      toolCallId: opportunity.toolCallId
    };
    const beforeCandidate = await readFile(file, "utf8");
    await expect(store.recordReview(staleApproval)).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(file, "utf8")).toBe(beforeCandidate);

    const state = JSON.parse(beforeCandidate) as { reviews: unknown[] };
    state.reviews.push(staleApproval);
    const corruptBytes = JSON.stringify(state);
    await writeFile(file, corruptBytes, "utf8");
    await expect(store.listReviews()).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(file, "utf8")).toBe(corruptBytes);
  });

  it("retains stale would-deny and needs-adjustment reviews as valid negative evidence", async () => {
    for (const decision of ["would-deny", "needs-adjustment"] as const) {
      const { store } = await fixture();
      const opportunity = { ...receipt(), evidenceClass: "organic" as const };
      await store.record(opportunity);
      expect(await store.recordReview({
        action: opportunity.envelope.action,
        decision,
        evidenceClass: "organic",
        id: `review-${decision}`,
        linkedAt: opportunity.envelope.link.linkedAt,
        opportunityId: opportunity.id,
        ownerUserId: opportunity.envelope.userId,
        recordedAt: "2026-07-17T04:00:00.000Z",
        runId: opportunity.runId,
        sourceReason: "recorded task is no longer open",
        sourceState: "stale",
        taskId: opportunity.envelope.link.taskId,
        threadId: opportunity.envelope.threadId,
        toolCallId: opportunity.toolCallId
      })).toMatchObject({ decision, sourceState: "stale" });
    }
  });

  it("keeps v2 opportunity timestamps parseable while new review timestamps remain canonical UTC", async () => {
    const offsetFixture = await fixture();
    const offsetOpportunity = {
      ...receipt(),
      envelope: {
        ...receipt().envelope,
        link: { ...receipt().envelope.link, linkedAt: "2026-07-17T11:00:00+09:00" }
      },
      evidenceClass: "organic" as const,
      recordedAt: "2026-07-17T12:00:00+09:00"
    };
    expect(await offsetFixture.store.record(offsetOpportunity)).toMatchObject({
      envelope: { link: { linkedAt: "2026-07-17T11:00:00+09:00" } },
      recordedAt: "2026-07-17T12:00:00+09:00"
    });
    const offsetBytes = await readFile(offsetFixture.file, "utf8");
    await expect(offsetFixture.store.recordReview({
      action: offsetOpportunity.envelope.action,
      decision: "would-deny",
      evidenceClass: "organic",
      id: "review-offset-linked-at",
      linkedAt: offsetOpportunity.envelope.link.linkedAt,
      opportunityId: offsetOpportunity.id,
      ownerUserId: offsetOpportunity.envelope.userId,
      recordedAt: "2026-07-17T04:00:00.000Z",
      runId: offsetOpportunity.runId,
      sourceState: "exact",
      taskId: offsetOpportunity.envelope.link.taskId,
      threadId: offsetOpportunity.envelope.threadId,
      toolCallId: offsetOpportunity.toolCallId
    })).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(offsetFixture.file, "utf8")).toBe(offsetBytes);

    const recordedAtFixture = await fixture();
    const canonicalOpportunity = { ...receipt(), evidenceClass: "organic" as const };
    await recordedAtFixture.store.record(canonicalOpportunity);
    const canonicalBytes = await readFile(recordedAtFixture.file, "utf8");
    await expect(recordedAtFixture.store.recordReview({
      action: canonicalOpportunity.envelope.action,
      decision: "would-deny",
      evidenceClass: "organic",
      id: "review-offset-recorded-at",
      linkedAt: canonicalOpportunity.envelope.link.linkedAt,
      opportunityId: canonicalOpportunity.id,
      ownerUserId: canonicalOpportunity.envelope.userId,
      recordedAt: "2026-07-17T13:00:00+09:00",
      runId: canonicalOpportunity.runId,
      sourceState: "exact",
      taskId: canonicalOpportunity.envelope.link.taskId,
      threadId: canonicalOpportunity.envelope.threadId,
      toolCallId: canonicalOpportunity.toolCallId
    })).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(recordedAtFixture.file, "utf8")).toBe(canonicalBytes);
  });

  it("is no-write idempotent for exact replay, records a new trace without recounting a logical duplicate, and rejects a conflicting trace scope", async () => {
    const { file, store } = await fixture();
    const first = receipt();
    await store.record(first);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    const exactBytes = await readFile(file, "utf8");
    await store.record({ ...first, recordedAt: "2026-07-17T04:00:00.000Z" });
    expect(await readFile(file, "utf8")).toBe(exactBytes);

    await store.record({
      ...first,
      envelope: { ...first.envelope, traceId: "runtime-tool:run-1:call-2" },
      id: "opportunity-2",
      toolCallId: "call-2"
    });
    expect(await store.list()).toEqual([first]);

    const beforeConflict = await readFile(file, "utf8");
    await expect(store.record({
      ...first,
      envelope: {
        ...first.envelope,
        idempotencyKey: "runtime-opportunity:run-1:other-task",
        link: { ...first.envelope.link, taskId: "other-task" }
      }
    })).rejects.toThrow("different scope");
    expect(await readFile(file, "utf8")).toBe(beforeConflict);
  });

  it("fails closed on corrupt or unknown schema without overwriting bytes", async () => {
    const sample = receipt();
    for (const raw of [
      "{not-json\n",
      JSON.stringify({ opportunities: [], schemaVersion: 999, traces: [] }),
      JSON.stringify({
        opportunities: [],
        schemaVersion: 1,
        traces: [{ envelope: sample.envelope, runId: sample.runId, toolCallId: sample.toolCallId }]
      })
    ]) {
      const { file, store } = await fixture();
      await writeFile(file, raw, "utf8");

      await expect(store.list()).rejects.toThrow("opportunity store is corrupt");
      await expect(store.record(receipt())).rejects.toThrow("opportunity store is corrupt");
      expect(await readFile(file, "utf8")).toBe(raw);
    }
  });

  it("validates the complete candidate before the first write", async () => {
    const { file, store } = await fixture();
    const invalid = {
      ...receipt(),
      envelope: { ...receipt().envelope, transition: { from: "open", to: "open" } }
    } as unknown as ProgressiveAutonomyRuntimeOpportunityReceipt;

    await expect(store.record(invalid)).rejects.toThrow("opportunity store is corrupt");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an orphan opportunity with no semantic trace and preserves corrupt bytes", async () => {
    const { file, store } = await fixture();
    await store.record(receipt());
    const state = JSON.parse(await readFile(file, "utf8")) as { traces: unknown[] };
    state.traces = [];
    const corrupt = JSON.stringify(state);
    await writeFile(file, corrupt, "utf8");

    await expect(store.list()).rejects.toThrow("opportunity store is corrupt");
    await expect(store.record(receipt())).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(file, "utf8")).toBe(corrupt);
  });

  it("rejects traces whose semantic scope differs from their opportunity beyond tool-call traceId", async () => {
    type MutableEnvelope = {
      idempotencyKey: string;
      link: { linkedAt: string };
      threadId: string;
      transition: { from: string; to: string };
      userId: string;
    };
    const mutations = [
      (envelope: MutableEnvelope) => { envelope.threadId = "thread-other"; },
      (envelope: MutableEnvelope) => { envelope.userId = "other-user"; },
      (envelope: MutableEnvelope) => { envelope.link.linkedAt = "2026-07-17T02:00:01.000Z"; },
      (envelope: MutableEnvelope) => { envelope.idempotencyKey = "different-idempotency"; },
      (envelope: MutableEnvelope) => { envelope.transition = { from: "open", to: "open" }; }
    ];
    for (const mutate of mutations) {
      const { file, store } = await fixture();
      await store.record(receipt());
      const state = JSON.parse(await readFile(file, "utf8")) as { traces: Array<{ envelope: MutableEnvelope }> };
      mutate(state.traces[0]!.envelope);
      const corrupt = JSON.stringify(state);
      await writeFile(file, corrupt, "utf8");

      await expect(store.list()).rejects.toThrow("opportunity store is corrupt");
      expect(await readFile(file, "utf8")).toBe(corrupt);
    }
  });

  it("rejects an impossible wouldAllowStanding decision without an exact matched grant", async () => {
    const { file, store } = await fixture();
    await store.record(receipt());
    const state = JSON.parse(await readFile(file, "utf8")) as {
      opportunities: Array<{ shadowAssessment: string; shadowRationale: string }>;
    };
    state.opportunities[0]!.shadowAssessment = "wouldAllowStanding";
    state.opportunities[0]!.shadowRationale = "exact active standing grant";
    const corrupt = JSON.stringify(state);
    await writeFile(file, corrupt, "utf8");

    await expect(store.list()).rejects.toThrow("opportunity store is corrupt");
    await expect(store.record(receipt())).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(file, "utf8")).toBe(corrupt);
  });

  it("rejects every other impossible shadow decision/grant combination", async () => {
    const mutations = [
      (entry: Record<string, unknown>) => { entry.matchedGrantId = "grant-unexpected"; },
      (entry: Record<string, unknown>) => {
        entry.enforcementDecision = "deny";
        entry.matchedGrantId = "grant-unexpected";
        entry.shadowAssessment = "wouldDeny";
      },
      (entry: Record<string, unknown>) => {
        entry.enforcementDecision = "allow-standing";
        entry.matchedGrantId = "grant-1";
        entry.shadowAssessment = "wouldAllowStanding";
      }
    ];
    for (const mutate of mutations) {
      const { file, store } = await fixture();
      await store.record(receipt());
      const state = JSON.parse(await readFile(file, "utf8")) as { opportunities: Array<Record<string, unknown>> };
      mutate(state.opportunities[0]!);
      const corrupt = JSON.stringify(state);
      await writeFile(file, corrupt, "utf8");

      await expect(store.list()).rejects.toThrow("opportunity store is corrupt");
      expect(await readFile(file, "utf8")).toBe(corrupt);
    }
  });

  it("rejects duplicate opportunity receipt IDs across distinct logical opportunities", async () => {
    const { file, store } = await fixture();
    const first = receipt();
    await store.record(first);
    await store.record({
      ...first,
      envelope: {
        ...first.envelope,
        idempotencyKey: "runtime-opportunity:run-2:task-next",
        traceId: "runtime-tool:run-2:call-1"
      },
      id: "opportunity-2",
      runId: "run-2"
    });
    const state = JSON.parse(await readFile(file, "utf8")) as { opportunities: Array<{ id: string }> };
    state.opportunities[1]!.id = state.opportunities[0]!.id;
    const corrupt = JSON.stringify(state);
    await writeFile(file, corrupt, "utf8");

    await expect(store.list()).rejects.toThrow("opportunity store is corrupt");
    expect(await readFile(file, "utf8")).toBe(corrupt);
  });

  it("rejects persisted tool-call, traceId, and logical idempotency bindings that are individually or jointly inconsistent", async () => {
    type MutableBinding = {
      envelope: { idempotencyKey: string; traceId: string };
      toolCallId: string;
    };
    type MutableState = {
      opportunities: MutableBinding[];
      traces: MutableBinding[];
    };
    const mutations = [
      (state: MutableState) => { state.opportunities[0]!.toolCallId = "different-call"; },
      (state: MutableState) => {
        state.opportunities[0]!.envelope.traceId = "arbitrary-shared-trace";
        state.traces[0]!.envelope.traceId = "arbitrary-shared-trace";
      },
      (state: MutableState) => {
        state.opportunities[0]!.envelope.idempotencyKey = "arbitrary-shared-key";
        state.traces[0]!.envelope.idempotencyKey = "arbitrary-shared-key";
      },
      (state: MutableState) => {
        state.traces[0]!.toolCallId = "different-call";
        state.opportunities[0]!.envelope.traceId = "arbitrary-shared-trace";
        state.traces[0]!.envelope.traceId = "arbitrary-shared-trace";
        state.opportunities[0]!.envelope.idempotencyKey = "arbitrary-shared-key";
        state.traces[0]!.envelope.idempotencyKey = "arbitrary-shared-key";
      }
    ];
    for (const mutate of mutations) {
      const { file, store } = await fixture();
      await store.record(receipt());
      const state = JSON.parse(await readFile(file, "utf8")) as MutableState;
      mutate(state);
      const corrupt = JSON.stringify(state);
      await writeFile(file, corrupt, "utf8");

      await expect(store.list()).rejects.toThrow("opportunity store is corrupt");
      await expect(store.record(receipt())).rejects.toThrow("opportunity store is corrupt");
      expect(await readFile(file, "utf8")).toBe(corrupt);
    }
  });

  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "muse-opportunity-store-"));
    dirs.push(dir);
    const file = join(dir, "progressive-autonomy-opportunities.json");
    return { file, store: new FileProgressiveAutonomyOpportunityStore({ file }) };
  }
});

function receipt(): ProgressiveAutonomyRuntimeOpportunityReceipt {
  return {
    evidenceClass: "unclassified",
    enforcementDecision: "confirm",
    envelope: {
      action: "muse.tasks.complete-linked-next-step",
      idempotencyKey: "runtime-opportunity:run-1:task-next",
      link: {
        artifactType: "task",
        linkedAt: "2026-07-17T02:00:00.000Z",
        providerId: "local",
        role: "next-step",
        taskId: "task-next"
      },
      schemaVersion: 1,
      threadId: "thread-life",
      traceId: "runtime-tool:run-1:call-1",
      transition: { from: "open", to: "done" },
      userId: "dogfood-user"
    },
    id: "opportunity-1",
    origin: "runtime-opportunity",
    rationale: "explicit confirmation required",
    recordedAt: "2026-07-17T03:00:00.000Z",
    runId: "run-1",
    shadowAssessment: "wouldConfirm",
    shadowRationale: "no exact active standing grant",
    toolCallId: "call-1"
  };
}
