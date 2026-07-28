import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { createGoalCheckpointBinding } from "../src/goal-checkpoint-binding.js";
import { inspectGoalCheckpointResume } from "../src/goal-checkpoint-inspection.js";

const PLAN_A = `sha256:${"a".repeat(64)}`;
const PLAN_B = `sha256:${"b".repeat(64)}`;

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("persisted goal checkpoint inspection", () => {
  it.each([
    '{"schemaVersion":1',
    JSON.stringify({ pendingEffectIds: [], planDigest: PLAN_A }),
    JSON.stringify({
      executionAuthorized: true,
      pendingEffectIds: [],
      planDigest: PLAN_A,
      schemaVersion: 1
    })
  ])("refuses corrupt checkpoint text with an explicit preservation path", (checkpointText) => {
    const before = digest(checkpointText);
    const result = inspectGoalCheckpointResume(checkpointText, {
      pendingEffectIds: [],
      planDigest: PLAN_A
    });

    expect(result).toEqual({
      decision: "refused",
      reason: "corrupt-checkpoint",
      recovery: "preserve-and-recreate"
    });
    expect(digest(checkpointText)).toBe(before);
  });

  it.each([
    {
      current: { pendingEffectIds: ["effect_1"], planDigest: PLAN_B },
      detail: "plan-mismatch"
    },
    {
      current: { pendingEffectIds: [], planDigest: PLAN_A },
      detail: "pending-effect-mismatch"
    }
  ])("refuses stale checkpoint text without rewriting it", ({ current, detail }) => {
    const checkpointText = JSON.stringify(createGoalCheckpointBinding({
      pendingEffectIds: ["effect_1"],
      planDigest: PLAN_A
    }));
    const before = digest(checkpointText);

    expect(inspectGoalCheckpointResume(checkpointText, current)).toEqual({
      decision: "refused",
      detail,
      reason: "stale-checkpoint",
      recovery: "review-plan-and-pending-effects"
    });
    expect(digest(checkpointText)).toBe(before);
  });

  it("returns resume-ready only for an exact persisted binding", () => {
    const checkpointText = JSON.stringify(createGoalCheckpointBinding({
      pendingEffectIds: ["effect_2", "effect_1"],
      planDigest: PLAN_A
    }));

    expect(inspectGoalCheckpointResume(checkpointText, {
      pendingEffectIds: ["effect_1", "effect_2"],
      planDigest: PLAN_A
    })).toEqual({
      decision: "resume-ready",
      pendingEffectIds: ["effect_1", "effect_2"],
      planDigest: PLAN_A
    });
  });

  it.each(["", 42, "x".repeat(70_000)])(
    "does not mask malformed current expectations behind checkpoint corruption",
    (checkpointText) => {
      expect(() => inspectGoalCheckpointResume(
        checkpointText as string,
        { pendingEffectIds: [], planDigest: "not-a-digest" }
      )).toThrow(/planDigest/u);
    }
  );
});
