import { describe, expect, it } from "vitest";

import { consumeAskStream, decompositionJsonFields, decompositionStderrNotes, parseBoundedInt, renderAskStreamError, resolveAskTierModels, routeAskTierModel, type AskStreamEvent } from "./commands-ask.js";

describe("decompositionJsonFields — surface fan-out trust signals on `muse ask --json` (a machine consumer can't read a stderr banner)", () => {
  it("emits a `decomposition` object with conflicts / incompleteness / truncation when the answer was decomposed", () => {
    const out = decompositionJsonFields({
      answer: "x", groundingSources: [], toolsUsed: [], decomposed: true, subtaskCount: 3, reason: "structural decomposition (capped at 8)",
      truncated: true, subtaskConflicts: ['"A" vs "B"'], synthesisIncomplete: ["task X"]
    });
    expect(out.decomposition).toBeDefined();
    expect(out.decomposition?.subtaskCount).toBe(3);
    expect(out.decomposition?.truncated).toBe(true);
    expect(out.decomposition?.subtaskConflicts).toEqual(['"A" vs "B"']);
    expect(out.decomposition?.synthesisIncomplete).toEqual(["task X"]);
  });
  it("emits NO decomposition key on a single-run (decomposed=false) — no noise on the common path", () => {
    const out = decompositionJsonFields({
      answer: "x", groundingSources: [], toolsUsed: [], decomposed: false, subtaskCount: 1, reason: "single-agent", truncated: false
    });
    expect(out.decomposition).toBeUndefined();
  });
  it("a clean decomposed run (no conflicts/incomplete/truncation) still reports decomposed + count, with empty signal arrays absent", () => {
    const out = decompositionJsonFields({
      answer: "x", groundingSources: [], toolsUsed: [], decomposed: true, subtaskCount: 2, reason: "structural decomposition", truncated: false
    });
    expect(out.decomposition?.subtaskCount).toBe(2);
    expect(out.decomposition?.truncated).toBe(false);
    expect(out.decomposition?.subtaskConflicts).toBeUndefined();
    expect(out.decomposition?.synthesisIncomplete).toBeUndefined();
    expect(out.decomposition?.subtaskRedundancies).toBeUndefined();
    expect(out.decomposition?.reasoningActionGaps).toBeUndefined();
  });
  it("ALSO emits subtaskRedundancies + reasoningActionGaps (the fire-7/fire-10 signals a `--json` consumer was blind to)", () => {
    const out = decompositionJsonFields({
      answer: "x", groundingSources: [], toolsUsed: [], decomposed: true, subtaskCount: 3, reason: "structural decomposition",
      truncated: false, subtaskRedundancies: ['"회의록 요약" ≈ "액션아이템 추출"'], reasoningActionGaps: ['"일정 등록"']
    });
    expect(out.decomposition?.subtaskRedundancies).toEqual(['"회의록 요약" ≈ "액션아이템 추출"']);
    expect(out.decomposition?.reasoningActionGaps).toEqual(['"일정 등록"']);
  });
});

describe("decompositionStderrNotes — human-facing fan-out warnings (conflict + redundancy; gaps stay --json-only)", () => {
  const base = { answer: "x", groundingSources: [], toolsUsed: [], decomposed: true, subtaskCount: 3, reason: "structural decomposition", truncated: false };
  it("emits a CONFLICT warning line when sub-results disagree", () => {
    const notes = decompositionStderrNotes({ ...base, subtaskConflicts: ['"A" vs "B"'] });
    expect(notes.some((n) => n.includes("disagree") && n.includes('"A" vs "B"'))).toBe(true);
  });
  it("ALSO emits a REDUNDANCY warning line (the precise signal a human should see)", () => {
    const notes = decompositionStderrNotes({ ...base, subtaskRedundancies: ['"회의록 요약" ≈ "액션아이템 추출"'] });
    expect(notes.some((n) => n.includes("near-identical") && n.includes("≈"))).toBe(true);
  });
  it("does NOT surface reasoningActionGaps to the human (too noisy — stays --json-only)", () => {
    const notes = decompositionStderrNotes({ ...base, reasoningActionGaps: ['"step 2"'] });
    expect(notes).toEqual([]);
  });
  it("a clean run produces no notes", () => {
    expect(decompositionStderrNotes(base)).toEqual([]);
  });
  it("conflict + redundancy together → two distinct lines", () => {
    const notes = decompositionStderrNotes({ ...base, subtaskConflicts: ['"A" vs "B"'], subtaskRedundancies: ['"C" ≈ "D"'] });
    expect(notes).toHaveLength(2);
  });
});

describe("renderAskStreamError", () => {
  const base = { answer: "partial ", error: "Ollama request failed — is Ollama running? (`ollama serve`)", model: "ollama/qwen3:8b", query: "hi" };

  it("--json emits a parseable structured error on stdout (no stderr)", () => {
    const r = renderAskStreamError({ ...base, json: true });
    expect(r.stderr).toBeUndefined();
    expect(r.stdout).toBeDefined();
    const parsed = JSON.parse(r.stdout!) as Record<string, unknown>;
    expect(parsed).toEqual({
      query: "hi",
      model: "ollama/qwen3:8b",
      answer: "partial ",
      error: base.error
    });
    expect(r.stdout!.endsWith("\n")).toBe(true);
  });

  it("non-json keeps the human stderr line and no stdout (unchanged behaviour)", () => {
    const r = renderAskStreamError({ ...base, json: false });
    expect(r.stdout).toBeUndefined();
    expect(r.stderr).toBe(`\n(error: ${base.error})\n`);
  });

  it("--json with an empty answer (agent threw before producing output) is still a parseable object", () => {
    // The --with-tools agent path passes answer:"" when
    // agentRuntime.run() throws before assigning output.
    const r = renderAskStreamError({ ...base, answer: "", json: true });
    const parsed = JSON.parse(r.stdout!) as { answer: unknown; error: unknown };
    expect(parsed.answer).toBe("");
    expect(parsed.error).toBe(base.error);
  });
});

async function* gen(events: AskStreamEvent[]): AsyncIterable<AskStreamEvent> {
  for (const e of events) yield e;
}

describe("resolveAskTierModels / routeAskTierModel", () => {
  it("falls back to the default model for any tier env that is unset or blank", () => {
    expect(resolveAskTierModels("ollama/qwen3:8b", {})).toEqual({
      fast: "ollama/qwen3:8b",
      heavy: "ollama/qwen3:8b"
    });
    expect(resolveAskTierModels("ollama/qwen3:8b", { MUSE_FAST_MODEL: "  ", MUSE_HEAVY_MODEL: "" })).toEqual({
      fast: "ollama/qwen3:8b",
      heavy: "ollama/qwen3:8b"
    });
  });

  it("uses the tier env models when present, trimming whitespace", () => {
    expect(resolveAskTierModels("def", { MUSE_FAST_MODEL: " ollama/qwen3:8b ", MUSE_HEAVY_MODEL: "ollama/qwen3.6:35b-a3b" })).toEqual({
      fast: "ollama/qwen3:8b",
      heavy: "ollama/qwen3.6:35b-a3b"
    });
  });

  it("routes a lookup query to the fast tier model and a reasoning query to the heavy tier model", () => {
    const env = { MUSE_FAST_MODEL: "ollama/qwen3:8b", MUSE_HEAVY_MODEL: "ollama/qwen3.6:35b-a3b" };
    expect(routeAskTierModel("what is the capital of France", "def", env)).toEqual({
      model: "ollama/qwen3:8b",
      tier: "fast"
    });
    expect(routeAskTierModel("analyze the trade-offs between two designs", "def", env)).toEqual({
      model: "ollama/qwen3.6:35b-a3b",
      tier: "heavy"
    });
  });

  it("defaults an ambiguous query to the heavy tier — never silently downgrades reasoning", () => {
    const env = { MUSE_FAST_MODEL: "ollama/qwen3:8b", MUSE_HEAVY_MODEL: "ollama/qwen3.6:35b-a3b" };
    expect(routeAskTierModel("the numbers and what they mean for us", "def", env).tier).toBe("heavy");
  });
});

describe("parseBoundedInt", () => {
  it("returns the fallback when the flag is absent or blank", () => {
    expect(parseBoundedInt(undefined, "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("", "--top", 1, 20, 3)).toBe(3);
    expect(parseBoundedInt("   ", "--top", 1, 20, 3)).toBe(3);
  });

  it("accepts a genuine number, truncating and clamping to max", () => {
    expect(parseBoundedInt("5", "--top", 1, 20, 3)).toBe(5);
    expect(parseBoundedInt(" 7 ", "--top", 1, 20, 3)).toBe(7);
    expect(parseBoundedInt("4.9", "--top", 1, 20, 3)).toBe(4);
    expect(parseBoundedInt("999", "--top", 1, 20, 3)).toBe(20); // clamp high
  });

  it("rejects a unit slip / non-numeric / below-min instead of silently defaulting", () => {
    expect(() => parseBoundedInt("5x", "--top", 1, 20, 3)).toThrow(/--top must be an integer in \[1, 20\]/u);
    expect(() => parseBoundedInt("abc", "--top", 1, 20, 3)).toThrow(/got 'abc'/u);
    expect(() => parseBoundedInt("0", "--top", 1, 20, 3)).toThrow(/\[1, 20\]/u);
    expect(() => parseBoundedInt("-2", "--top", 1, 20, 3)).toThrow(/\[1, 20\]/u);
  });

  it("works for the --calendar-days bounds too", () => {
    expect(parseBoundedInt("14", "--calendar-days", 1, 30, 7)).toBe(14);
    expect(parseBoundedInt("60", "--calendar-days", 1, 30, 7)).toBe(30);
    expect(() => parseBoundedInt("14d", "--calendar-days", 1, 30, 7))
      .toThrow(/--calendar-days must be an integer in \[1, 30\]/u);
  });
});

describe("consumeAskStream", () => {
  it("accumulates text-delta events and forwards each delta", async () => {
    const seen: string[] = [];
    const res = await consumeAskStream(
      gen([
        { type: "text-delta", text: "Hello" },
        { type: "text-delta", text: " world" },
        { type: "done" }
      ]),
      (t) => seen.push(t),
      () => false
    );
    expect(res).toEqual({ answer: "Hello world" });
    expect(seen).toEqual(["Hello", " world"]);
  });

  it("surfaces a provider error instead of silently dropping it", async () => {
    const res = await consumeAskStream(
      gen([
        { type: "text-delta", text: "partial" },
        { type: "error", error: { message: "run `ollama pull qwen3:8b`" } }
      ]),
      () => {},
      () => false
    );
    expect(res.error).toBe("run `ollama pull qwen3:8b`");
    expect(res.answer).toBe("partial"); // partial output preserved
  });

  it("falls back to a generic message when the error carries none", async () => {
    const res = await consumeAskStream(
      gen([{ type: "error" }]),
      () => {},
      () => false
    );
    expect(res.error).toBe("model request failed");
  });

  it("stops forwarding once aborted", async () => {
    const seen: string[] = [];
    let calls = 0;
    const res = await consumeAskStream(
      gen([
        { type: "text-delta", text: "a" },
        { type: "text-delta", text: "b" }
      ]),
      (t) => seen.push(t),
      () => (calls++ > 0) // aborted from the 2nd iteration on
    );
    expect(seen).toEqual(["a"]);
    expect(res.answer).toBe("a");
    expect(res.error).toBeUndefined();
  });
});
