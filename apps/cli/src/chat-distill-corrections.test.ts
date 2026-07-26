import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ModelProvider } from "@muse/model";
import {
  queryPlaybook,
  recordPlaybookStrategy as recordPlaybookStrategyImpl,
  setLearningPaused
} from "@muse/stores";
import { describe, expect, it } from "vitest";

import { distillSessionCorrections as distillSessionCorrectionsImpl } from "./chat-distill-corrections.js";
import { appendPlaybookInjection } from "./playbook-injections.js";

const recordPlaybookStrategy = (
  file: string,
  entry: Parameters<typeof recordPlaybookStrategyImpl>[1]
) => recordPlaybookStrategyImpl(file, entry, { run: (operation) => operation() });
const distillSessionCorrections = (
  options: Parameters<typeof distillSessionCorrectionsImpl>[0]
) => {
  const originalReadEnv = options.readEnv;
  const holdRoot = dirname(options.playbookFile ?? join(tmpdir(), `muse-distill-${randomUUID()}`, "playbook.json"));
  return distillSessionCorrectionsImpl({
    ...options,
    readEnv: () => {
      const supplied = originalReadEnv?.() ?? {};
      return {
        HOME: holdRoot,
        MUSE_LEARNING_PAUSE_FILE: join(holdRoot, "learning-paused.json"),
        ...supplied,
        MUSE_QUALIFICATION_LEARNING_HOLD_FILE: join(holdRoot, "qualification-learning-hold.json")
      };
    }
  });
};

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
const schedulingSession = [
  { content: "회의 잡아줘", role: "user" as const },
  { content: "잡기 전에 확인차 여쭤볼게요, 시간 괜찮으세요?", role: "assistant" as const },
  { content: "그게 아니라 물어보지 말고 그냥 바로 잡아줘", role: "user" as const }
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
      readInjectedIds: async () => new Set<string>(),
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
      readInjectedIds: async () => new Set<string>(),
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
      readInjectedIds: async () => new Set<string>(),
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
      readInjectedIds: async () => new Set<string>(),
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
      readInjectedIds: async () => new Set<string>(),
      readLines: async () => correctedSession
    });
    expect(res.status).toBe("skipped");
    expect(await queryPlaybook(file, "stark")).toHaveLength(1); // only the seed survives
  });

  it("records a conflict edge against an existing injectable strategy it contradicts", async () => {
    // The learn-time half of the behavioural-rule budget: when a new strategy is
    // distilled, it is classified against every existing injectable strategy and the
    // conflict edge is persisted, so inject-time resolution is a zero-model lookup.
    const file = await tmpPlaybook();
    await recordPlaybookStrategy(file, {
      createdAt: "2026-05-01T00:00:00.000Z",
      id: "pb_existing",
      reward: 2,
      text: "일정 잡기 전에 항상 확인하기",
      userId: "stark"
    });
    // One provider, two jobs: the distiller call returns a strategy; the
    // conflict-classifier call (its own system prompt) returns CONFLICT. Keyed on
    // the prompt so the stub depends on WHICH question it was asked.
    const provider: ModelProvider = {
      id: "dual",
      async generate({ messages }) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const output = system.includes("Reply with exactly one word: CONFLICT or OK")
          ? "CONFLICT"
          : "strategy: 일정은 물어보지 말고 바로 잡기\ntag: scheduling";
        return { id: "r", model: "m", output };
      },
      async listModels() { return []; },
      async *stream() {}
    };
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: provider,
      embed: async (text: string) => text.startsWith("그게") ? [1, 0, 0] : [0.8, 0.6, 0],
      idFactory: () => "pb_new",
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readInjectedIds: async () => new Set<string>(),
      readLines: async () => schedulingSession,
      strategyConsistencySamples: 1
    });
    expect(res.status).toBe("recorded");
    const entries = await queryPlaybook(file, "stark");
    const fresh = entries.find((e) => e.id === "pb_new");
    expect(fresh?.conflictsWith).toEqual(["pb_existing"]);
  });

  it("a conflict-classifier failure records NO edge but still writes the strategy (fail-soft)", async () => {
    const file = await tmpPlaybook();
    await recordPlaybookStrategy(file, {
      createdAt: "2026-05-01T00:00:00.000Z",
      id: "pb_existing",
      reward: 2,
      text: "일정 잡기 전에 항상 확인하기",
      userId: "stark"
    });
    const provider: ModelProvider = {
      id: "dual",
      async generate({ messages }) {
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        if (system.includes("Reply with exactly one word: CONFLICT or OK")) {
          throw new Error("classifier down");
        }
        return { id: "r", model: "m", output: "strategy: 일정은 물어보지 말고 바로 잡기\ntag: scheduling" };
      },
      async listModels() { return []; },
      async *stream() {}
    };
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: provider,
      embed: async (text: string) => text.startsWith("그게") ? [1, 0, 0] : [0.8, 0.6, 0],
      idFactory: () => "pb_new",
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readInjectedIds: async () => new Set<string>(),
      readLines: async () => schedulingSession,
      strategyConsistencySamples: 1
    });
    expect(res.status).toBe("recorded");
    const fresh = (await queryPlaybook(file, "stark")).find((e) => e.id === "pb_new");
    expect(fresh).toBeDefined();
    expect(fresh?.conflictsWith ?? []).toEqual([]);
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
      readInjectedIds: async () => new Set<string>(),
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
      readInjectedIds: async () => new Set<string>(),
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
      readInjectedIds: async () => new Set<string>(),
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
      readInjectedIds: async () => new Set<string>(),
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
    // cue↔strategy cosine is 0.37 — above the SOLE-candidate reinforce floor
    // (0.35) but below the decay floor (0.40), so a DECAY must NOT fire (a wrong
    // decay of a possibly grounded strategy is costlier than a missed reinforce —
    // WEDGE). Floors live-calibrated: eval:playbook-credit.
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_target", text: "summarize notes as bullet points", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("NONE"), // no new distillation — isolate the decay-credit decision
      // cue (contains 회의록) ↔ pb_target cosine = 0.37; lexical overlap ~0 (KO↔EN).
      embed: async (t: string) => (t.includes("회의록") ? [0.37, 0.92899] : [1, 0]),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readInjectedIds: async () => new Set<string>(),
      readLines: async () => correctedSession
    });
    expect(res.decayed).toHaveLength(0); // 0.37 < 0.40 decay floor → no decay
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
      readInjectedIds: async () => new Set<string>(),
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

describe("INJECTED-ID reinforcement credit — reward targets an ACTUALLY-injected strategy", () => {
  it("HEADLINE: a correction decays the recorded-injected strategy, NOT the cue-nearest never-injected bystander", async () => {
    const file = await tmpPlaybook();
    // pb_bystander is the cue-NEAREST strategy (cosine 1.0) but was never
    // injected this session; pb_injected (cosine 0.8, above the 0.62 decay
    // floor) is the one the session's prompts actually carried. Cosine-only
    // credit decays the bystander — the recorded id set must redirect it.
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_bystander", text: "회의록은 문단으로 정리한다", userId: "stark" });
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_injected", text: "회의록은 표로 정리한다", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("NONE"), // no new distillation — isolate the credit decision
      // cue ("… 그게 아니라 …") → [1,0]; bystander ("…문단…") → [1,0] (cosine 1.0);
      // injected ("…표…") → [0.8,0.6] (cosine 0.8 ≥ 0.62 decay floor).
      embed: async (text: string) => (text.includes("그게") || text.includes("문단") ? [1, 0] : [0.8, 0.6]),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readInjectedIds: async () => new Set(["pb_injected"]),
      readLines: async () => correctedSession
    });
    expect(res.decayed.map((d) => d.text)).toContain("회의록은 표로 정리한다");
    const saved = await queryPlaybook(file, "stark");
    expect(saved.find((e) => e.id === "pb_injected")!.reward).toBe(-1); // actually injected → decayed
    expect(saved.find((e) => e.id === "pb_bystander")!.reward).toBeUndefined(); // never injected → untouched
  });

  it("fail-closed: a recorded set that intersects no injectable candidate moves NOTHING (no cosine fallback)", async () => {
    const file = await tmpPlaybook();
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_bystander", text: "회의록은 문단으로 정리한다", userId: "stark" });
    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("NONE"),
      embed: async () => [1, 0],
      playbookFile: file,
      readBoundaries: async () => boundaries,
      // The recorded injected id is gone from the store (e.g. merged away):
      // the session's real influencer can't be credited, and the bystander
      // MUST NOT absorb the decay in its place.
      readInjectedIds: async () => new Set(["pb_gone"]),
      readLines: async () => correctedSession
    });
    expect(res.decayed).toHaveLength(0);
    expect((await queryPlaybook(file, "stark")).find((e) => e.id === "pb_bystander")!.reward).toBeUndefined();
  });

  it("default reader wiring: the on-disk injections record (MUSE_PLAYBOOK_INJECTIONS_FILE) restricts credit end-to-end", async () => {
    const file = await tmpPlaybook();
    const injectionsFile = join(await mkdtemp(join(tmpdir(), "muse-injections-")), "playbook-injections.jsonl");
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_bystander", text: "회의록은 문단으로 정리한다", userId: "stark" });
    await recordPlaybookStrategy(file, { createdAt: "2026-05-01T00:00:00.000Z", id: "pb_injected", text: "회의록은 표로 정리한다", userId: "stark" });
    await appendPlaybookInjection({ ids: ["pb_injected"], tsIso: "2026-05-28T01:00:00.000Z", userId: "stark" }, injectionsFile);
    process.env.MUSE_PLAYBOOK_INJECTIONS_FILE = injectionsFile;
    try {
      const res = await distillSessionCorrections({
        model: "m",
        modelProvider: stub("NONE"),
        embed: async (text: string) => (text.includes("그게") || text.includes("문단") ? [1, 0] : [0.8, 0.6]),
        playbookFile: file,
        readBoundaries: async () => boundaries, // session starts 2026-05-28T00:00 — the record above is in-session
        readLines: async () => correctedSession
      });
      expect(res.decayed.map((d) => d.text)).toContain("회의록은 표로 정리한다");
      expect((await queryPlaybook(file, "stark")).find((e) => e.id === "pb_bystander")!.reward).toBeUndefined();
    } finally {
      delete process.env.MUSE_PLAYBOOK_INJECTIONS_FILE;
    }
  });
});

/**
 * Independent-review regression pin: `muse playbook pause` tells the user "Muse
 * won't learn anything new". The daemon ticks honoured it; THIS path — the one
 * that runs at the end of every session — did not, so a paused user still had a
 * new strategy written AND an existing one decayed. The brake is cited as the
 * reason unattended learning may default to ON, so it has to hold here.
 */
describe("distillSessionCorrections — the learning-pause kill switch", () => {
  it("writes NOTHING and moves NO reward while learning is paused", async () => {
    const file = await tmpPlaybook();
    const pauseFile = join(tmpdir(), `muse-pause-${randomUUID()}.json`);
    await setLearningPaused(pauseFile, true);
    await recordPlaybookStrategy(file, {
      createdAt: "2026-05-01T00:00:00.000Z",
      id: "pb_existing",
      reward: 3,
      text: "회의록은 문단으로 정리한다",
      userId: "stark"
    });

    const res = await distillSessionCorrections({
      model: "m",
      modelProvider: stub("회의록은 불릿으로 정리하기"),
      playbookFile: file,
      readBoundaries: async () => boundaries,
      readEnv: () => ({ MUSE_LEARNING_PAUSE_FILE: pauseFile }) as NodeJS.ProcessEnv,
      readInjectedIds: async () => new Set<string>(),
      readLines: async () => correctedSession
    });

    expect(res.status).toBe("skipped");
    expect(res.decayed).toEqual([]);
    expect(res.reinforced).toEqual([]);
    const saved = await queryPlaybook(file, "stark");
    expect(saved).toHaveLength(1);
    expect(saved[0]?.reward).toBe(3);
  });
});
