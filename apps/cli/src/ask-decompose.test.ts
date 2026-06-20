import type { AgentRunInput } from "@muse/agent-core";
import { describe, expect, it, vi } from "vitest";

import { parsePlannerLines, runDecomposedAgentAsk, type AskAgentRunResult } from "./ask-decompose.js";

describe("parsePlannerLines — strips real list markers but PRESERVES leading-digit content", () => {
  it("preserves '1분기' (Q1) — the old greedy regex collapsed 3 distinct quarters into identical text", () => {
    expect(parsePlannerLines("1분기 정리\n2분기 정리\n3분기 정리")).toEqual(["1분기 정리", "2분기 정리", "3분기 정리"]);
  });
  it("strips a real numbered / bullet / paren marker", () => {
    expect(parsePlannerLines("1. 회의록 요약\n- 액션 추출\n2) 일정 등록")).toEqual(["회의록 요약", "액션 추출", "일정 등록"]);
  });
  it("drops blank lines", () => {
    expect(parsePlannerLines("회의 요약\n\n  \n액션 추출")).toEqual(["회의 요약", "액션 추출"]);
  });
});

function userContentOf(input: AgentRunInput): string {
  const user = input.messages.find((m) => m.role === "user");
  return typeof user?.content === "string" ? user.content : "";
}

function runnerReturning(byUserContent: (content: string) => AskAgentRunResult) {
  return {
    run: vi.fn(async (input: AgentRunInput): Promise<AskAgentRunResult> => byUserContent(userContentOf(input)))
  };
}

const baseArgs = { metadata: {}, model: "gemma4:12b", systemPrompt: "you are muse" };

describe("runDecomposedAgentAsk — simple request runs once", () => {
  it("does not decompose a simple ask", async () => {
    const runner = runnerReturning((content) => ({ response: { output: `A:${content}` } }));
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: "지금 몇시야?", runner });

    expect(result.decomposed).toBe(false);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("A:지금 몇시야?");
  });
});

describe("runDecomposedAgentAsk — fan-out + synthesis", () => {
  const listQuery = "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록";

  it("runs each sub-task in its own run, then a synthesis run (3 + 1 = 4 runs)", async () => {
    const runner = runnerReturning((content) =>
      content.startsWith("사용자 요청:")
        ? { response: { output: "SYNTH" } }
        : { response: { output: `done:${content}` } }
    );
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: listQuery, runner });

    expect(result.decomposed).toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(4);
    expect(result.answer).toBe("SYNTH");
  });

  it("merges groundingSources from every sub-task AND the synthesis (feeds the citation gate)", async () => {
    const runner = runnerReturning((content) =>
      content.startsWith("사용자 요청:")
        ? { groundingSources: [{ source: "synth.md", text: "s" }], response: { output: "SYNTH" } }
        : { groundingSources: [{ source: `${content}.md`, text: content }], response: { output: `done:${content}` } }
    );
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: listQuery, runner });

    const sources = result.groundingSources.map((s) => s.source);
    expect(sources).toContain("회의록 요약.md");
    expect(sources).toContain("액션아이템 추출.md");
    expect(sources).toContain("일정 등록.md");
    expect(sources).toContain("synth.md");
  });

  it("merges toolsUsed across sub-tasks (deduped)", async () => {
    const runner = runnerReturning((content) =>
      content.startsWith("사용자 요청:")
        ? { response: { output: "SYNTH" }, toolsUsed: ["knowledge_search"] }
        : { response: { output: `done:${content}` }, toolsUsed: ["knowledge_search"] }
    );
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: listQuery, runner });
    expect(result.toolsUsed).toEqual(["knowledge_search"]);
  });
});

describe("runDecomposedAgentAsk — planner + grounding gate are wired (not dead)", () => {
  it("invokes the planner for a broad-scope ask with no literal structure", async () => {
    const query = "내 노트 전부 훑어서 분기별 보고서 만들어줘";
    const runner = runnerReturning((content) => {
      if (content.startsWith("사용자 요청:")) return { response: { output: "SYNTH" } };
      if (content === query) return { response: { output: "1분기 정리\n2분기 정리\n3분기 정리" } };
      return { response: { output: `done:${content}` } };
    });
    const result = await runDecomposedAgentAsk({ ...baseArgs, query, runner });

    expect(result.decomposed).toBe(true);
    expect(result.reason).toContain("model-planned");
    expect(result.answer).toBe("SYNTH");
  });

  it("flags the synthesis INCOMPLETE when a completed sub-task is dropped from the fan-in (G1 maker != judge)", async () => {
    const query = "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록";
    const runner = runnerReturning((content) => {
      if (content.startsWith("사용자 요청:")) return { response: { output: "회의록 요약 완료, 액션아이템 추출 완료." } }; // drops 일정 등록
      return { response: { output: `done:${content}` } };
    });
    const result = await runDecomposedAgentAsk({ ...baseArgs, query, runner });
    expect(result.reason).toContain("synthesis incomplete");
    expect(result.synthesisIncomplete).toContain("일정 등록");
  });

  it("fail-closes a refusing sub-task via the grounding gate (abstention is not folded in)", async () => {
    const runner = runnerReturning((content) => {
      if (content.startsWith("사용자 요청:")) return { response: { output: "SYNTH" } };
      if (content.includes("회의록")) return { response: { output: "I'm not sure about that." } };
      return { response: { output: `done:${content}` } };
    });
    const result = await runDecomposedAgentAsk({
      ...baseArgs,
      query: "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록",
      runner
    });
    // The refusing "회의록" sub-task must not count as completed.
    expect(result.answer).toBe("SYNTH");
  });
});

describe("runDecomposedAgentAsk — failure handling (no partial-answer fabrication)", () => {
  it("a thrown sub-task does not abort the run; synthesis folds the survivors", async () => {
    const runner = {
      run: vi.fn(async (input: AgentRunInput): Promise<AskAgentRunResult> => {
        const user = userContentOf(input);
        if (user.includes("액션아이템") && !user.startsWith("사용자 요청:")) throw new Error("boom");
        return { response: { output: user.startsWith("사용자 요청:") ? "SYNTH" : `done:${user}` } };
      })
    };
    const result = await runDecomposedAgentAsk({
      ...baseArgs,
      query: "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록",
      runner
    });
    expect(result.answer).toBe("SYNTH");
  });

  it("returns an empty answer when every sub-task fails (caller falls back, no fabrication)", async () => {
    const runner = { run: vi.fn(async (): Promise<AskAgentRunResult> => { throw new Error("all down"); }) };
    const result = await runDecomposedAgentAsk({
      ...baseArgs,
      query: "다음 3개 해줘: 1. A 2. B 3. C",
      runner
    });
    expect(result.answer).toBe("");
  });
});
