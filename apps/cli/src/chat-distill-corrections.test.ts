import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider } from "@muse/model";
import { queryPlaybook, recordPlaybookStrategy } from "@muse/mcp";
import { describe, expect, it } from "vitest";

import { distillSessionCorrections } from "./chat-distill-corrections.js";

const stub = (output: string): ModelProvider => ({
  id: "stub",
  async generate() { return { id: "r", model: "m", output }; },
  async listModels() { return []; },
  async *stream() {}
});

async function tmpPlaybook(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "muse-distill-"));
  return join(dir, "playbook.json");
}

const correctedSession = [
  { content: "회의록 정리해줘", role: "user" as const },
  { content: "문단으로 정리했습니다", role: "assistant" as const },
  { content: "그게 아니라 불릿으로 해줘", role: "user" as const }
];
const boundaries = [{ tsIso: "2026-05-28T00:00:00.000Z", userId: "stark" }];

describe("distillSessionCorrections — end-of-session auto-distillation (ReasoningBank 2509.25140)", () => {
  it("records a distilled strategy from a corrected session", async () => {
    const file = await tmpPlaybook();
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: when summarising notes, use bullet points not prose\ntag: notes"),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(res.status).toBe("recorded");
    const saved = await queryPlaybook(file, "stark");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.text).toContain("bullet points");
    expect(saved[0]!.tag).toBe("notes");
  });

  it("skips when the session has no correction", async () => {
    const file = await tmpPlaybook();
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: should not be used\ntag: -"),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "회의록 정리해줘", role: "user" },
        { content: "정리했습니다", role: "assistant" },
        { content: "고마워!", role: "user" }
      ]
    });
    expect(res.status).toBe("skipped");
    expect(await queryPlaybook(file, "stark")).toHaveLength(0);
  });

  it("dedups against an existing near-duplicate strategy", async () => {
    const file = await tmpPlaybook();
    await recordPlaybookStrategy(file, {
      createdAt: "2026-05-01T00:00:00.000Z",
      id: "pb_seed",
      text: "when summarising notes use bullet points not prose",
      userId: "stark"
    });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: when summarising notes, use bullet points not prose\ntag: notes"),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(res.status).toBe("skipped");
    expect(await queryPlaybook(file, "stark")).toHaveLength(1); // only the seed survives
  });

  it("skips when no userId resolves", async () => {
    const file = await tmpPlaybook();
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: x\ntag: -"),
      playbookFile: file,
      readBoundaries: async () => [{ tsIso: "2026-05-28T00:00:00.000Z" }],
      readLines: async () => correctedSession
    });
    expect(res.status).toBe("skipped");
  });

  it("RL decay: docks the reward of the strategy a correction implicates, leaving unrelated ones untouched", async () => {
    const file = await tmpPlaybook();
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_culprit", text: "회의록은 문단으로 정리한다", userId: "stark" });
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_email", text: "이메일은 네 문장 이내로 작성한다", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: when summarising notes, use bullet points not prose\ntag: notes"),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession // request "회의록 정리해줘" → corrected to bullets
    });
    expect(res.decayed.map((d) => d.text)).toContain("회의록은 문단으로 정리한다");
    const saved = await queryPlaybook(file, "stark");
    expect(saved.find((e) => e.id === "pb_culprit")!.reward).toBe(-1); // implicated → decayed below neutral
    expect(saved.find((e) => e.id === "pb_email")!.reward).toBeUndefined(); // unrelated → never touched
  });

  it("RL reinforce: an explicit approval lifts the reward of the strategy that applied (no correction needed)", async () => {
    const file = await tmpPlaybook();
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_good", text: "회의록은 불릿으로 정리한다", userId: "stark" });
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_email", text: "이메일은 네 문장 이내로 작성한다", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: unused\ntag: -"),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "회의록 정리해줘", role: "user" },
        { content: "불릿으로 정리했습니다", role: "assistant" },
        { content: "완벽해! 딱 좋아", role: "user" } // explicit approval, no correction
      ]
    });
    expect(res.status).toBe("skipped"); // nothing distilled (no correction) — but a reward moved
    expect(res.reinforced.map((r) => r.text)).toContain("회의록은 불릿으로 정리한다");
    const saved = await queryPlaybook(file, "stark");
    expect(saved.find((e) => e.id === "pb_good")!.reward).toBe(1); // approved → reinforced
    expect(saved.find((e) => e.id === "pb_email")!.reward).toBeUndefined(); // unrelated → never touched
  });
});
