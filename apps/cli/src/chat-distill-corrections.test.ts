import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelProvider } from "@muse/model";
import { queryPlaybook, recordPlaybookStrategy } from "@muse/stores";
import { describe, expect, it } from "vitest";

import { distillSessionCorrections } from "./chat-distill-corrections.js";

const stub = (output: string): ModelProvider => ({
  id: "stub",
  async generate() { return { id: "r", model: "m", output }; },
  async listModels() { return []; },
  async *stream() {}
});

// Returns a DIFFERENT output per generate() call (clamped to the last) — to
// exercise the k-sample self-consistency gate with DISAGREEING drafts.
const varyingStub = (outputs: readonly string[]): ModelProvider => {
  let i = 0;
  return {
    id: "vary",
    async generate() { return { id: "r", model: "m", output: outputs[Math.min(i++, outputs.length - 1)]! }; },
    async listModels() { return []; },
    async *stream() {}
  };
};

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
      // Korean strategy (same script as the Korean correction) so the held-out
      // support gate can verify it. Embed simulates grounded-but-abstracted:
      // correction ("그게 아니라") → [1,0,0]; strategy ("회의록은") → [0.8,0.6,0].
      // Support cosine = 0.8 ≥ 0.50 (grounded). Gist cosine = 0.8 < 0.92 (abstracted → kept).
      modelProvider: stub("strategy: 회의록은 불릿으로 정리하기\ntag: notes"),
      embed: async (text: string) => text.startsWith("그게") ? [1, 0, 0] : [0.8, 0.6, 0],
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(res.status).toBe("recorded");
    const saved = await queryPlaybook(file, "stark");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.text).toContain("불릿");
    expect(saved[0]!.tag).toBe("notes");
  });

  it("counts a low-consistency rejection in lowConsistencyRejected and banks nothing (telemetry sink, fire-10 onReject seam)", async () => {
    const file = await tmpPlaybook();
    // 3 DISAGREEING drafts for the one correction → self-consistency gate rejects
    // (no embed → support/verbatim gates skip, so all 3 become drafts that disagree).
    const res = await distillSessionCorrections({
      model: "m",
      // Same-script (Korean) drafts so each clears the held-out support gate
      // (cosine 0.8 ∈ [0.50, 0.92)); their TEXT disagrees (near-zero Jaccard) so
      // the self-consistency gate rejects via the DISAGREEMENT path (fires onReject).
      modelProvider: varyingStub([
        "strategy: 회의는 오전에 잡기\ntag: -",
        "strategy: 이메일은 짧게 쓰기\ntag: -",
        "strategy: 단위는 미터법으로 쓰기\ntag: -"
      ]),
      embed: async (text: string) => text.startsWith("그게") ? [1, 0, 0] : [0.8, 0.6, 0],
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(res.lowConsistencyRejected).toBe(1);
    expect(res.status).toBe("skipped");
    expect(await queryPlaybook(file, "stark")).toHaveLength(0);
  });

  it("does NOT promote a near-verbatim restatement of the correction (gist gate, SIB arXiv:2603.01455)", async () => {
    const file = await tmpPlaybook();
    // Embed simulates a verbatim restatement: correction and strategy map to the
    // SAME vector → gist cosine 1.0 ≥ 0.92 → dropped before recordPlaybookStrategy.
    // This is the end-to-end seam guard: a verbatim strategy is NOT written.
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: 그게 아니라 한국어로\ntag: notes"),
      embed: async () => [1, 0, 0],
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(res.status).toBe("skipped");
    expect(await queryPlaybook(file, "stark")).toHaveLength(0);
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
      embed: async () => [1, 0], // supportive (hermetic) — keep the gate out of these unit tests
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
      embed: async () => [1, 0], // supportive (hermetic) — keep the gate out of these unit tests
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
      // Credit assignment now embeds the cue+strategies (semantic), so inject a
      // deterministic stub (mirrors the decay test): the 회의록 strategy matches
      // the cue (request "회의록 정리해줘"), the email one is orthogonal.
      embed: async (text: string) => text.includes("회의록") ? [1, 0, 0] : [0, 1, 0],
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

  it("does NOT reward a PROBATION strategy (never-injected) even when it's the most cue-similar — credit scoped to injectable, parity with the decay daemon", async () => {
    const file = await tmpPlaybook();
    // pb_prob is on probation (recorded but NEVER injected by contract), and is the MOST
    // cue-similar to the approval cue. The injectable pb_real is orthogonal. A correct
    // reward loop must NOT credit the probation guess the user never actually benefited from.
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_prob", probation: true, text: "회의록은 불릿으로 정리한다", userId: "stark" });
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_real", text: "이메일은 네 문장 이내로 작성한다", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: unused\ntag: -"),
      embed: async (text: string) => text.includes("회의록") ? [1, 0, 0] : [0, 1, 0], // cue is 회의록-similar → matches pb_prob
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "회의록 정리해줘", role: "user" },
        { content: "불릿으로 정리했습니다", role: "assistant" },
        { content: "완벽해! 딱 좋아", role: "user" }
      ]
    });
    expect(res.reinforced.map((r) => r.text)).not.toContain("회의록은 불릿으로 정리한다"); // probation never credited
    const saved = await queryPlaybook(file, "stark");
    expect(saved.find((e) => e.id === "pb_prob")!.reward).toBeUndefined(); // unchanged — not injectable
  });

  it("REGRESSION: an INJECTABLE strategy still gets rewarded normally (the scoping only excludes non-injectable)", async () => {
    const file = await tmpPlaybook();
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_inj", text: "회의록은 불릿으로 정리한다", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: unused\ntag: -"),
      embed: async (text: string) => text.includes("회의록") ? [1, 0, 0] : [0, 1, 0],
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "회의록 정리해줘", role: "user" },
        { content: "불릿으로 정리했습니다", role: "assistant" },
        { content: "완벽해! 딱 좋아", role: "user" }
      ]
    });
    expect(res.reinforced.map((r) => r.text)).toContain("회의록은 불릿으로 정리한다");
    expect((await queryPlaybook(file, "stark")).find((e) => e.id === "pb_inj")!.reward).toBe(1);
  });

  it("asymmetric floor: a borderline cross-distribution correction does NOT decay a strategy (Memory-R2 2605.21768)", async () => {
    const file = await tmpPlaybook();
    // pb_target shares ~no tokens with the Korean cue (cross-distribution). The
    // cue↔strategy cosine is 0.58 — ABOVE the 0.55 reinforce floor but BELOW the
    // 0.62 decay floor, so a DECAY must NOT fire (a wrong decay of a possibly
    // grounded strategy is costlier than a missed reinforce — WEDGE).
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_target", text: "summarize notes as bullet points", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("NONE"), // no new distillation — isolate the decay-credit decision
      // cue (contains 회의록) ↔ pb_target cosine = 0.58; lexical overlap ~0 (KO↔EN).
      embed: async (t: string) => (t.includes("회의록") ? [0.58, 0.81462] : [1, 0]),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => correctedSession
    });
    expect(res.decayed).toHaveLength(0); // 0.58 < 0.62 decay floor → no decay
    const saved = await queryPlaybook(file, "stark");
    expect(saved.find((e) => e.id === "pb_target")!.reward).toBeUndefined(); // strategy protected
  });

  it("SEMANTIC credit: reward lands on the strategy the cue MEANS, not the lexical decoy (Memory-R2 2605.21768)", async () => {
    const file = await tmpPlaybook();
    // pb_true is the genuine match but shares ~no tokens with the cue; pb_decoy
    // shares tokens (회의록/정리) but is semantically the wrong strategy. Lexical
    // Jaccard would credit pb_decoy; semantic cosine credits pb_true.
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_true", text: "노트는 핵심만 추려서 쓴다", userId: "stark" });
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_decoy", text: "회의록 정리 회의록 정리", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("strategy: unused\ntag: -"),
      // The cue ("회의록 정리해줘 … 완벽해 …") and pb_true ("…핵심만…") both map to
      // [1,0,0]; pb_decoy (lexically-overlapping) is orthogonal [0,1,0].
      embed: async (text: string) => (text.includes("핵심") || text.includes("완벽해") ? [1, 0, 0] : [0, 1, 0]),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readLines: async () => [
        { content: "회의록 정리해줘", role: "user" },
        { content: "정리했습니다", role: "assistant" },
        { content: "완벽해! 딱 좋아", role: "user" } // approval
      ]
    });
    expect(res.reinforced.map((r) => r.text)).toContain("노트는 핵심만 추려서 쓴다");
    const saved = await queryPlaybook(file, "stark");
    expect(saved.find((e) => e.id === "pb_true")!.reward).toBe(1); // semantic match → reinforced
    expect(saved.find((e) => e.id === "pb_decoy")!.reward).toBeUndefined(); // lexical decoy → NOT credited
  });
});
