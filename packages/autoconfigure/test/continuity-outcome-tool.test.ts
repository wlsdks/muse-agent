import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPersonalThread,
  openContinuityDelivery,
  readAttunementState
} from "@muse/attunement";
import { afterEach, describe, expect, it } from "vitest";

import { createMuseRuntimeAssembly } from "../src/index.js";
import { createContinuityOutcomeTool } from "../src/continuity-outcome-tool.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { force: true, recursive: true });
  directory = undefined;
});

describe("normal-chat explicit Continuity outcome tool", () => {
  it("passes through the canonical activation-none learning opportunity", async () => {
    const tool = createContinuityOutcomeTool({
      recordOutcome: async (deliveryId, outcome) => ({
        applied: true,
        delivery: {
          id: deliveryId,
          outcome: {
            authority: "owner-explicit",
            evidenceClass: "organic",
            id: "continuity_outcome_1",
            outcome,
            policyVersion: 2,
            recordedAt: "2026-07-30T11:05:00.000Z"
          }
        },
        learningOpportunity: {
          activation: "none",
          boundary: {
            actionScope: "not-expanded",
            permission: "unchanged",
            recipient: "unchanged",
            retention: "unchanged",
            source: "unchanged"
          },
          deliveryId,
          opportunityId: `learning_opportunity_${"a".repeat(64)}`,
          outcome: {
            outcome: "ignored",
            outcomeId: "continuity_outcome_1",
            recordedAt: "2026-07-30T11:05:00.000Z"
          },
          requiredReview: {
            boundedDraft: true,
            explicitApproval: true,
            frozenReplayEvidence: true
          },
          schemaVersion: 1,
          scope: { threadId: "thread-1" },
          sourceRun: {
            behaviorDigest: "b".repeat(64),
            completedAt: "2026-07-30T11:00:00.000Z",
            evidenceClass: "organic-production",
            runId: "run-1"
          },
          status: "review-required"
        },
        policy: { version: 2 }
      })
    });

    await expect(tool.execute({
      deliveryId: "delivery_opportunity_1",
      outcome: "ignored"
    }, { runId: "approved" })).resolves.toMatchObject({
      learningOpportunity: {
        activation: "none",
        opportunityId: `learning_opportunity_${"a".repeat(64)}`,
        status: "review-required"
      },
      success: true
    });
  });

  it("registers four explicit outcomes and records one exact owner note only", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-outcome-"));
    const file = join(directory, "attunement.json");
    const thread = await createPersonalThread(file, {
      kind: "work",
      title: "Daily agent"
    });
    const delivery = await openContinuityDelivery(file, {
      evidenceRefs: [],
      expectedPolicyVersion: thread.policy.version,
      threadId: thread.id
    });
    const tools = createMuseRuntimeAssembly({
      env: { HOME: directory, MUSE_ATTUNEMENT_FILE: file }
    }).toolRegistry.list().filter(
      (tool) => tool.definition.name === "muse.continuity.delivery.outcome"
    );
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.definition).toMatchObject({
      inputSchema: {
        additionalProperties: false,
        properties: {
          outcome: { enum: ["used", "adjusted", "ignored", "rejected"] },
          ownerNote: { maxLength: 500, minLength: 1 }
        },
        required: ["deliveryId", "outcome"]
      },
      risk: "write"
    });
    expect(tool.definition.description).toContain("never infer it from timeout");
    expect(tool.definition.description).toContain("task receipts");

    await expect(tool.execute({
      deliveryId: delivery.id,
      outcome: "adjusted",
      ownerNote: "Keep the next step, but show less context."
    }, { runId: "approved" })).resolves.toMatchObject({
      applied: true,
      deliveryId: delivery.id,
      outcome: "adjusted",
      ownerNoteRecorded: true,
      success: true
    });
    const state = await readAttunementState(file);
    expect(state.deliveries[0]!.outcome).toMatchObject({
      evidenceClass: "organic",
      outcome: "adjusted",
      ownerNote: "Keep the next step, but show less context."
    });
  });

  it("rejects hidden-signal, invalid, extra, and accessor input with outcome zero", async () => {
    directory = await mkdtemp(join(tmpdir(), "muse-continuity-outcome-negative-"));
    const file = join(directory, "attunement.json");
    const thread = await createPersonalThread(file, {
      kind: "life",
      title: "Sleep"
    });
    const delivery = await openContinuityDelivery(file, {
      evidenceRefs: [],
      expectedPolicyVersion: thread.policy.version,
      threadId: thread.id
    });
    const tool = createMuseRuntimeAssembly({
      env: { HOME: directory, MUSE_ATTUNEMENT_FILE: file }
    }).toolRegistry.list().find(
      (candidate) => candidate.definition.name === "muse.continuity.delivery.outcome"
    )!;
    const before = await readFile(file);
    let getterReads = 0;
    const accessor = Object.defineProperty({
      deliveryId: delivery.id
    }, "outcome", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "used";
      }
    });

    for (const args of [
      { deliveryId: delivery.id, outcome: "positive" },
      { deliveryId: delivery.id, outcome: "used", timeout: true },
      { deliveryId: delivery.id, outcome: "used", sentiment: 0.9 },
      { deliveryId: delivery.id, outcome: "used", taskReceipt: "done" },
      { assistantGuess: true, deliveryId: delivery.id, outcome: "used" }
    ]) {
      await expect(tool.execute(args, { runId: "hidden" })).rejects.toThrow();
    }
    await expect(tool.execute(accessor, { runId: "accessor" }))
      .rejects.toThrow(/plain data property/u);
    expect(getterReads).toBe(0);
    expect(await readFile(file)).toEqual(before);
    expect((await readAttunementState(file)).deliveries[0]!.outcome)
      .toBeUndefined();
  });
});
