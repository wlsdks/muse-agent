import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunContext, HookStage } from "@muse/agent-core";
import { readCheckins } from "@muse/mcp";
import type { ModelResponse } from "@muse/model";
import { describe, expect, it } from "vitest";

import type { UserModelSlot } from "@muse/memory";

import { buildBackgroundReviewHooks, inferPreferencesFromTurns, scanCommitmentsFromTurns } from "../src/context-engineering-builders.js";

const ctx = { input: { messages: [], metadata: { userId: "stark" }, model: "m" }, runId: "r", startedAt: new Date("2026-05-01T00:00:00Z") } as unknown as AgentRunContext;
const res = { id: "x", model: "m", output: "ok" } as ModelResponse;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function spyAutoExtract() {
  const calls: string[] = [];
  const hook: HookStage = { afterComplete: async () => { calls.push("extract"); }, id: "auto-extract" };
  return { calls, hook };
}

describe("buildBackgroundReviewHooks", () => {
  it("is purely additive: off → [] (auto-extract is the caller's separate every-turn hook)", () => {
    expect(buildBackgroundReviewHooks({}, {})).toEqual([]);
    expect(buildBackgroundReviewHooks({}, { reviewCommitments: async () => undefined })).toEqual([]); // off → still nothing
  });

  it("flag on → ONE engine hook; it does NOT call any auto-extract (that stays separate)", async () => {
    const { calls } = spyAutoExtract();
    const env = { MUSE_BACKGROUND_REVIEW_ENABLED: "true", MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "1" };
    const hooks = buildBackgroundReviewHooks(env, {});
    expect(hooks).toHaveLength(1);
    await hooks[0]!.afterComplete!(ctx, res);
    await flush();
    expect(calls).toEqual([]); // engine never touches auto-extract
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

  it("fires the COMMITMENT + PREFERENCE arms on the memory (turn-count) trigger", async () => {
    const calls: string[] = [];
    const env = { MUSE_BACKGROUND_REVIEW_ENABLED: "1", MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "1" };
    const hooks = buildBackgroundReviewHooks(env, {
      reviewCommitments: async () => { calls.push("commit"); },
      reviewPreferences: async () => { calls.push("pref"); }
    });
    hooks[0]!.afterComplete!(ctx, res);
    await flush();
    expect(calls.sort()).toEqual(["commit", "pref"]);
  });
});

describe("inferPreferencesFromTurns — correction → typed user-model preference (server learns style)", () => {
  const correction = [
    { content: "summarise the meeting", role: "user" as const },
    { content: "Here is a long prose summary...", role: "assistant" as const },
    { content: "no, that's not what I asked — use bullet points", role: "user" as const }
  ];
  const fakeProvider = (output: string) => ({ generate: async () => ({ output }) }) as unknown as Parameters<typeof inferPreferencesFromTurns>[1]["modelProvider"];

  it("upserts a categorised preference (id pref-<category>) for a correction", async () => {
    const saved: UserModelSlot[] = [];
    const added = await inferPreferencesFromTurns(correction, {
      model: "qwen",
      modelProvider: fakeProvider("preference: prefers bullet points\ncategory: format\nconfidence: 0.8"),
      store: { upsertUserModelSlot: async (_u, slot) => { saved.push(slot); } },
      userId: "stark"
    });
    expect(added).toEqual(["prefers bullet points (format)"]);
    expect(saved[0]).toMatchObject({ id: "pref-format", kind: "preference", value: "prefers bullet points", category: "format", confidence: 0.8 });
  });

  it("never fabricates: a NONE verdict upserts nothing; a no-correction turn does nothing", async () => {
    const saved: UserModelSlot[] = [];
    const store = { upsertUserModelSlot: async (_u: string, slot: UserModelSlot) => { saved.push(slot); } };
    expect(await inferPreferencesFromTurns(correction, { model: "q", modelProvider: fakeProvider("NONE"), store, userId: "s" })).toEqual([]);
    expect(await inferPreferencesFromTurns([{ content: "hi", role: "user" }, { content: "hello", role: "assistant" }], { model: "q", modelProvider: fakeProvider("preference: x\ncategory: style\nconfidence: 0.9"), store, userId: "s" })).toEqual([]);
    expect(saved).toEqual([]);
  });
});

describe("scanCommitmentsFromTurns — deterministic open-loop → check-in (server gets it too)", () => {
  it("schedules a check-in for a voiced commitment and persists it; a no-commitment turn schedules none", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgr-checkin-")), "checkins.json");
    const fresh = await scanCommitmentsFromTurns(
      ["I need to email Bob about the Q3 report tomorrow", "thanks"],
      { file, now: () => new Date("2026-05-01T09:00:00Z"), userId: "stark" }
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.question).toContain("email Bob");
    expect((await readCheckins(file)).map((c) => c.status)).toEqual(["scheduled"]);

    const none = await scanCommitmentsFromTurns(["what time is it?"], { file, userId: "stark" });
    expect(none).toEqual([]);
  });
});
