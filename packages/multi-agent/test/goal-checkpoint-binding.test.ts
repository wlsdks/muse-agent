import { describe, expect, it } from "vitest";

import {
  assessGoalCheckpointResume,
  createGoalCheckpointBinding
} from "../src/goal-checkpoint-binding.js";

const PLAN_A = `sha256:${"a".repeat(64)}`;
const PLAN_B = `sha256:${"b".repeat(64)}`;

describe("goal checkpoint binding", () => {
  it("binds a plan digest to a canonical exact pending-effect set", () => {
    const binding = createGoalCheckpointBinding({
      pendingEffectIds: ["effect_task_2", "effect_email_1"],
      planDigest: PLAN_A
    });

    expect(binding).toEqual({
      pendingEffectIds: ["effect_email_1", "effect_task_2"],
      planDigest: PLAN_A,
      schemaVersion: 1
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.pendingEffectIds)).toBe(true);
  });

  it("returns resume-ready only for the same digest and exact set, regardless of order", () => {
    const binding = createGoalCheckpointBinding({
      pendingEffectIds: ["effect_email_1", "effect_task_2"],
      planDigest: PLAN_A
    });
    const decision = assessGoalCheckpointResume(binding, {
      pendingEffectIds: ["effect_task_2", "effect_email_1"],
      planDigest: PLAN_A
    });

    expect(decision).toEqual({
      decision: "resume-ready",
      pendingEffectIds: ["effect_email_1", "effect_task_2"],
      planDigest: PLAN_A
    });
    expect("executionAuthorized" in decision).toBe(false);
  });

  it.each([
    {
      expected: { pendingEffectIds: ["effect_email_1"], planDigest: PLAN_B },
      reason: "plan-mismatch"
    },
    {
      expected: { pendingEffectIds: [], planDigest: PLAN_A },
      reason: "pending-effect-mismatch"
    },
    {
      expected: { pendingEffectIds: ["effect_email_1", "effect_task_2"], planDigest: PLAN_A },
      reason: "pending-effect-mismatch"
    },
    {
      expected: { pendingEffectIds: ["effect_other"], planDigest: PLAN_A },
      reason: "pending-effect-mismatch"
    }
  ])("refuses plan or pending-effect mismatch", ({ expected, reason }) => {
    const binding = createGoalCheckpointBinding({
      pendingEffectIds: ["effect_email_1"],
      planDigest: PLAN_A
    });

    expect(assessGoalCheckpointResume(binding, expected)).toEqual({
      decision: "refused",
      reason
    });
  });

  it("fails closed on duplicate, sparse, malformed, and accessor inputs", () => {
    const sparse = Array(1) as string[];
    let getterCalls = 0;
    const accessor = Object.defineProperty({ pendingEffectIds: [] }, "planDigest", {
      get() {
        getterCalls += 1;
        return PLAN_A;
      }
    });

    expect(() => createGoalCheckpointBinding({
      pendingEffectIds: ["same", "same"],
      planDigest: PLAN_A
    })).toThrow(/duplicate/u);
    expect(() => createGoalCheckpointBinding({
      pendingEffectIds: sparse,
      planDigest: PLAN_A
    })).toThrow(/pendingEffectIds/u);
    expect(() => createGoalCheckpointBinding({
      pendingEffectIds: [],
      planDigest: "invalid"
    })).toThrow(/planDigest/u);
    expect(() => createGoalCheckpointBinding(
      accessor as Parameters<typeof createGoalCheckpointBinding>[0]
    )).toThrow(/planDigest/u);
    expect(getterCalls).toBe(0);
  });

  it("rejects extra or inherited authority fields instead of canonicalizing them", () => {
    const valid = {
      pendingEffectIds: [],
      planDigest: PLAN_A
    };
    expect(() => createGoalCheckpointBinding({
      ...valid,
      executionAuthorized: true
    } as Parameters<typeof createGoalCheckpointBinding>[0])).toThrow(/shape/u);
    expect(() => createGoalCheckpointBinding({
      ...valid,
      schemaVersion: 999
    } as Parameters<typeof createGoalCheckpointBinding>[0])).toThrow(/shape/u);
    expect(() => createGoalCheckpointBinding(
      Object.assign(Object.create({ executionAuthorized: true }), valid)
    )).toThrow(/prototype/u);

    const binding = createGoalCheckpointBinding(valid);
    expect(() => assessGoalCheckpointResume(
      { ...binding, executionAuthorized: true } as Parameters<typeof assessGoalCheckpointResume>[0],
      valid
    )).toThrow(/shape/u);
    expect(() => assessGoalCheckpointResume(binding, {
      ...valid,
      status: "active"
    } as Parameters<typeof assessGoalCheckpointResume>[1])).toThrow(/shape/u);
  });
});
