import { describe, expect, it } from "vitest";

import {
  activateGoalPlan,
  createGoalDecompositionDraft,
  projectGoalProgress
} from "../src/index.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function plan() {
  const draft = createGoalDecompositionDraft("research first. then write report.");
  return activateGoalPlan(draft, {
    acceptanceCriteria: ["report is source-backed"],
    killConditions: ["owner cancels"],
    nonGoals: ["send the report"]
  });
}

describe("goal progress projection", () => {
  it("keeps narrative claims, tool errors, and unverifiable output out of completion", () => {
    const active = plan();
    const firstId = active.subtasks[0]!.id;
    const projection = projectGoalProgress(active, [
      { actionId: firstId, evidenceLink: "trace://claim", kind: "assistant-claim", schemaVersion: 1 },
      { actionId: firstId, evidenceLink: "trace://error", kind: "tool-error", schemaVersion: 1 },
      {
        actionId: firstId,
        evidenceLink: "trace://unverifiable",
        kind: "unverifiable-output",
        schemaVersion: 1
      }
    ]);

    expect(projection).toMatchObject({
      completedCount: 0,
      completedPercentage: 0,
      completedSubtaskIds: []
    });
    expect(projection.actions[0]).toMatchObject({ actionId: firstId, status: "attempted" });
  });

  it("counts one exact applied verified-effect receipt once", () => {
    const active = plan();
    const firstId = active.subtasks[0]!.id;
    const receipt = {
      actionId: firstId,
      effectId: "effect_1",
      effectState: "applied" as const,
      evidenceLink: "artifact://effect-1",
      payloadDigest: DIGEST,
      schemaVersion: 1 as const,
      status: "verified-effect" as const
    };
    const projection = projectGoalProgress(active, [receipt, receipt]);

    expect(projection.completedCount).toBe(1);
    expect(projection.completedPercentage).toBe(50);
    expect(projection.completedSubtaskIds).toEqual([firstId]);
    expect(projection.actions[0]).toEqual({
      actionId: firstId,
      evidenceLinks: ["artifact://effect-1"],
      status: "verified"
    });
  });

  it("does not count a verified rolled-back effect", () => {
    const active = plan();
    const firstId = active.subtasks[0]!.id;
    const projection = projectGoalProgress(active, [{
      actionId: firstId,
      effectId: "effect_1",
      effectState: "rolled-back",
      evidenceLink: "artifact://rollback-1",
      payloadDigest: DIGEST,
      schemaVersion: 1,
      status: "verified-effect"
    }]);

    expect(projection.completedCount).toBe(0);
    expect(projection.actions[0]?.status).toBe("rolled-back");
  });

  it("keeps a distinct applied effect complete when another effect was rolled back", () => {
    const active = plan();
    const firstId = active.subtasks[0]!.id;
    const projection = projectGoalProgress(active, [
      {
        actionId: firstId,
        effectId: "effect_applied",
        effectState: "applied",
        evidenceLink: "artifact://applied",
        payloadDigest: DIGEST,
        schemaVersion: 1,
        status: "verified-effect"
      },
      {
        actionId: firstId,
        effectId: "effect_rolled_back",
        effectState: "rolled-back",
        evidenceLink: "artifact://rolled-back",
        payloadDigest: `sha256:${"b".repeat(64)}`,
        schemaVersion: 1,
        status: "verified-effect"
      }
    ]);

    expect(projection.completedCount).toBe(1);
    expect(projection.actions[0]?.status).toBe("verified");
  });

  it("rejects unknown actions, conflicting effect snapshots, and forged authority fields", () => {
    const active = plan();
    const firstId = active.subtasks[0]!.id;
    const receipt = {
      actionId: firstId,
      effectId: "effect_1",
      effectState: "applied" as const,
      evidenceLink: "artifact://effect-1",
      payloadDigest: DIGEST,
      schemaVersion: 1 as const,
      status: "verified-effect" as const
    };

    expect(() => projectGoalProgress(active, [
      { ...receipt, actionId: "unknown" }
    ])).toThrow(/unknown actionId/u);
    expect(() => projectGoalProgress(active, [
      receipt,
      { ...receipt, effectState: "rolled-back" }
    ])).toThrow(/conflicting verified receipts/u);
    expect(() => projectGoalProgress(active, [
      { ...receipt, executionAuthorized: true }
    ])).toThrow(/shape/u);
  });

  it("rejects accessors and preserves deeply frozen inputs and outputs", () => {
    const active = plan();
    const evidence = [{
      actionId: active.subtasks[0]!.id,
      evidenceLink: "trace://blocked",
      kind: "blocked" as const,
      schemaVersion: 1 as const
    }];
    const before = JSON.stringify({ active, evidence });
    const projection = projectGoalProgress(active, evidence);

    expect(JSON.stringify({ active, evidence })).toBe(before);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.actions)).toBe(true);
    expect(Object.isFrozen(projection.actions[0])).toBe(true);
    expect(Object.isFrozen(projection.actions[0]?.evidenceLinks)).toBe(true);

    const forged = { ...evidence[0] };
    Object.defineProperty(forged, "kind", { get: () => "assistant-claim" });
    expect(() => projectGoalProgress(active, [
      forged as typeof evidence[number]
    ])).toThrow(/own data property/u);
  });

  it("rejects authority expandos and custom prototypes on every input array", () => {
    const active = plan();
    const receipt = {
      actionId: active.subtasks[0]!.id,
      effectId: "effect_1",
      effectState: "applied" as const,
      evidenceLink: "artifact://effect-1",
      payloadDigest: DIGEST,
      schemaVersion: 1 as const,
      status: "verified-effect" as const
    };
    const expandedEvidence = Object.assign([receipt], { executionAuthorized: true });
    const expandedSubtasks = Object.assign([...active.subtasks], { executionAuthorized: true });
    const inheritedEvidence = [receipt];
    Object.setPrototypeOf(inheritedEvidence, Object.create(Array.prototype, {
      executionAuthorized: { value: true }
    }));

    expect(() => projectGoalProgress(active, expandedEvidence)).toThrow(/dense indices/u);
    expect(() => projectGoalProgress(active, inheritedEvidence)).toThrow(/prototype/u);
    expect(() => projectGoalProgress(
      { ...active, subtasks: expandedSubtasks },
      [receipt]
    )).toThrow(/dense indices/u);
  });
});
