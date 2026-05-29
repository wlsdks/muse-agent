import type { AgentRunContext, HookStage } from "@muse/agent-core";
import type { ModelResponse } from "@muse/model";
import { describe, expect, it } from "vitest";

import { buildBackgroundReviewHooks } from "../src/context-engineering-builders.js";

const ctx = { input: { messages: [], metadata: { userId: "stark" }, model: "m" }, runId: "r", startedAt: new Date("2026-05-01T00:00:00Z") } as unknown as AgentRunContext;
const res = { id: "x", model: "m", output: "ok" } as ModelResponse;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function spyAutoExtract() {
  const calls: string[] = [];
  const hook: HookStage = { afterComplete: async () => { calls.push("extract"); }, id: "auto-extract" };
  return { calls, hook };
}

describe("buildBackgroundReviewHooks", () => {
  it("default (flag off) → the standalone auto-extract hook, unchanged", () => {
    const { hook } = spyAutoExtract();
    expect(buildBackgroundReviewHooks({}, { autoExtractHook: hook })).toEqual([hook]);
    expect(buildBackgroundReviewHooks({}, {})).toEqual([]); // no model → no hook
  });

  it("flag on → ONE engine hook (not the raw auto-extract), routing memory on the turn-count trigger", async () => {
    const { calls, hook } = spyAutoExtract();
    const env = { MUSE_BACKGROUND_REVIEW_ENABLED: "true", MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "2", MUSE_BACKGROUND_REVIEW_SKILL_ITERS: "999" };
    const hooks = buildBackgroundReviewHooks(env, { autoExtractHook: hook });
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.id).not.toBe("auto-extract"); // it's the engine, which OWNS the cadence

    await hooks[0]!.afterComplete!(ctx, res); // turn 1 → below threshold, no extract
    await flush();
    expect(calls).toEqual([]);
    await hooks[0]!.afterComplete!(ctx, res); // turn 2 → memory fires → auto-extract runs once
    await flush();
    expect(calls).toEqual(["extract"]);
  });

  it("flag on with no auto-extract hook still yields the engine (memory arm just no-ops)", async () => {
    const hooks = buildBackgroundReviewHooks({ MUSE_BACKGROUND_REVIEW_ENABLED: "1", MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "1" }, {});
    expect(hooks).toHaveLength(1);
    expect(() => hooks[0]!.afterComplete!(ctx, res)).not.toThrow(); // sync, non-blocking
    await flush();
  });

  it("fires the SKILL arm on the tool-iteration trigger (hard tasks teach)", async () => {
    const skillCalls: string[] = [];
    const env = { MUSE_BACKGROUND_REVIEW_ENABLED: "1", MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "999", MUSE_BACKGROUND_REVIEW_SKILL_ITERS: "2" };
    const hooks = buildBackgroundReviewHooks(env, { reviewSkill: async () => { skillCalls.push("skill"); } });
    // two tool iterations (a "hard" task) then complete → skill trigger fires
    hooks[0]!.afterTool!(ctx, {} as never, {} as never);
    hooks[0]!.afterTool!(ctx, {} as never, {} as never);
    hooks[0]!.afterComplete!(ctx, res);
    await flush();
    expect(skillCalls).toEqual(["skill"]);
  });
});
