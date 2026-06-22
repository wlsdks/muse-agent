import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRunContext, HookStage } from "@muse/agent-core";
import { readCheckins } from "@muse/proactivity";
import type { ModelResponse } from "@muse/model";
import { describe, expect, it } from "vitest";

import type { UserModelSlot } from "@muse/memory";

import { buildBackgroundReviewHooks } from "../src/context-engineering-builders.js";
import { inferPreferencesFromTurns, scanCommitmentsFromTurns } from "../src/context-engineering-turn-analysis.js";

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

  it("fires the SKILL arm on a hard task at the iter trigger WITH a tool failure (salience gate)", async () => {
    const skillCalls: string[] = [];
    const env = { MUSE_BACKGROUND_REVIEW_ENABLED: "1", MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "999", MUSE_BACKGROUND_REVIEW_SKILL_ITERS: "2" };
    const hooks = buildBackgroundReviewHooks(env, { reviewSkill: async () => { skillCalls.push("skill"); } });
    // two tool iterations crossing the trigger, one of which FAILED → salient → skill fires
    hooks[0]!.afterTool!(ctx, {} as never, { status: "completed" } as never);
    hooks[0]!.afterTool!(ctx, {} as never, { status: "failed" } as never);
    hooks[0]!.afterComplete!(ctx, res);
    await flush();
    expect(skillCalls).toEqual(["skill"]);
  });

  it("does NOT fire the SKILL arm on a clean hard task (no tool failure → not salient)", async () => {
    const skillCalls: string[] = [];
    const env = { MUSE_BACKGROUND_REVIEW_ENABLED: "1", MUSE_BACKGROUND_REVIEW_MEMORY_TURNS: "999", MUSE_BACKGROUND_REVIEW_SKILL_ITERS: "2" };
    const hooks = buildBackgroundReviewHooks(env, { reviewSkill: async () => { skillCalls.push("skill"); } });
    hooks[0]!.afterTool!(ctx, {} as never, { status: "completed" } as never);
    hooks[0]!.afterTool!(ctx, {} as never, { status: "completed" } as never);
    hooks[0]!.afterComplete!(ctx, res);
    await flush();
    expect(skillCalls).toEqual([]);
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

  // Branching stub: the polarity classifier system prompt asks for one word
  // (CONTRADICT/AGREE/UNRELATED); the inference prompt yields the preference block.
  const supersedeProvider = (polarity: (userMsg: string) => string) => ({
    generate: async (req: { messages: readonly { role: string; content: string }[] }) => {
      const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
      if (sys.includes("EXACTLY one word")) {
        const userMsg = req.messages.find((m) => m.role === "user")?.content ?? "";
        return { output: polarity(userMsg) };
      }
      return { output: "preference: write in flowing prose, no lists\ncategory: style\nconfidence: 0.8" };
    }
  }) as unknown as Parameters<typeof inferPreferencesFromTurns>[1]["modelProvider"];

  function supersedingStore() {
    const slots = new Map<string, UserModelSlot>([
      ["pref-format", { id: "pref-format", kind: "preference", value: "always answer in bullet points", category: "format", updatedAt: new Date("2026-05-01T00:00:00Z") }]
    ]);
    return {
      slots,
      store: {
        upsertUserModelSlot: async (_u: string, slot: UserModelSlot) => { slots.set(slot.id, slot); },
        removeUserModelSlot: async (_u: string, id: string) => { slots.delete(id); }
      },
      listExistingPreferences: async () => [...slots.values()].map((s) => ({ id: s.id, value: s.value }))
    };
  }

  it("belief revision: a new pref that contradicts a stored DIFFERENT-category one supersedes it (arXiv:2606.09483)", async () => {
    const { slots, store, listExistingPreferences } = supersedingStore();
    await inferPreferencesFromTurns(correction, {
      model: "q",
      modelProvider: supersedeProvider((userMsg) => (userMsg.includes("bullet points") ? "CONTRADICT" : "UNRELATED")),
      store,
      userId: "stark",
      listExistingPreferences
    });
    // The new style pref is written and the contradicted format pref is dropped → one slot.
    expect([...slots.keys()].sort()).toEqual(["pref-style"]);
    expect(slots.get("pref-style")?.value).toBe("write in flowing prose, no lists");
  });

  it("no supersession when the new pref does NOT contradict the stored one (both coexist)", async () => {
    const { slots, store, listExistingPreferences } = supersedingStore();
    await inferPreferencesFromTurns(correction, {
      model: "q",
      modelProvider: supersedeProvider(() => "UNRELATED"),
      store,
      userId: "stark",
      listExistingPreferences
    });
    expect([...slots.keys()].sort()).toEqual(["pref-format", "pref-style"]);
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

  it("cross-session auto-discharge: a standing check-in is cancelled when the user reports it done (CLI parity)", async () => {
    const VOCAB = ["email", "bob", "report", "dentist"] as const;
    const stubEmbed = async (text: string): Promise<readonly number[]> => {
      const lower = text.toLowerCase();
      return VOCAB.map((w) => (lower.includes(w) ? 1 : 0));
    };
    const file = join(mkdtempSync(join(tmpdir(), "muse-bgr-discharge-")), "checkins.json");
    await scanCommitmentsFromTurns(["I need to email Bob the report tomorrow"], { embed: stubEmbed, file, now: () => new Date("2026-06-01T09:00:00Z"), userId: "stark" });
    expect((await readCheckins(file)).find((c) => c.commitment.toLowerCase().includes("email"))?.status).toBe("scheduled");

    // a later session reports it done → the daemon-path scan auto-discharges it
    await scanCommitmentsFromTurns(["done, I emailed Bob the report"], { embed: stubEmbed, file, now: () => new Date("2026-06-05T09:00:00Z"), userId: "stark" });
    expect((await readCheckins(file)).find((c) => c.commitment.toLowerCase().includes("email"))?.status).toBe("cancelled");
  });

  it("assembled-path: near-duplicate commitments collapse → FEWER check-ins than lexical-only baseline", async () => {
    // Two near-duplicate phrasings of the same commitment (would survive lexical dedup).
    // "I need to email Bob the report" and "I have to email Bob about the report"
    // differ in both kind AND phrasing, so the lexical seen-set passes both.
    // With the semantic embedder they should collapse to one.
    const turns = [
      "I need to email Bob the report.",
      "I have to email Bob about the report."
    ];

    // Baseline: no embedder (pass a no-collapse stub that always throws → fail-soft = no collapse).
    const baselineFile = join(mkdtempSync(join(tmpdir(), "muse-checkin-baseline-")), "checkins.json");
    const throwEmbed = async (_text: string): Promise<readonly number[]> => { throw new Error("no embed"); };
    const baselineFresh = await scanCommitmentsFromTurns(turns, {
      file: baselineFile,
      now: () => new Date("2026-05-01T09:00:00Z"),
      userId: "stark",
      embed: throwEmbed
    });

    // With semantic collapse: inject a stub that maps both phrases to nearly-identical vectors.
    const nearA = [1, 0.05, 0];
    const nearB = [0.99, 0.06, 0.01]; // cos(nearA, nearB) ≈ 0.999 — well above 0.86
    const collapsingEmbed = async (text: string): Promise<readonly number[]> => {
      if (text.includes("email Bob the report")) return nearA;
      if (text.includes("email Bob about the report")) return nearB;
      return [0, 0, 1];
    };
    const collapsedFile = join(mkdtempSync(join(tmpdir(), "muse-checkin-collapsed-")), "checkins.json");
    const collapsedFresh = await scanCommitmentsFromTurns(turns, {
      file: collapsedFile,
      now: () => new Date("2026-05-01T09:00:00Z"),
      userId: "stark",
      embed: collapsingEmbed
    });

    // Baseline should schedule 2 check-ins (one per distinct lexical commitment).
    expect(baselineFresh.length).toBeGreaterThanOrEqual(2);
    // Semantic collapse should produce strictly fewer check-ins.
    expect(collapsedFresh.length).toBeLessThan(baselineFresh.length);
    expect(collapsedFresh.length).toBeGreaterThanOrEqual(1);
  });
});
