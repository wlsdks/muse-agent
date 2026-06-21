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

  it("flags near-identical (redundant) sub-answers when an embed is supplied — MAST step-repetition surfaced (live wiring)", async () => {
    // Every sub-task worker returns the SAME output → near-identical → redundant pairs.
    const runner = runnerReturning((content) =>
      content.startsWith("사용자 요청:")
        ? { response: { output: "SYNTH" } }
        : { response: { output: "the quarterly budget is set at 1250 dollars" } }
    );
    const result = await runDecomposedAgentAsk({
      ...baseArgs,
      query: listQuery,
      runner,
      embed: async () => [0.9, 0.1, 0, 0] // constant vector → cosine 1.0, topic gate always passes
    });
    expect(result.subtaskRedundancies).toBeDefined();
    expect(result.subtaskRedundancies!.length).toBeGreaterThanOrEqual(1);
  });

  it("runs each sub-task in its own run, then a synthesis run (3 + 1 = 4 runs) when the synthesis is complete", async () => {
    // A synthesis that COVERS every sub-task output passes verifySynthesisCoverage,
    // so no re-synthesis fires — the fan-out is exactly 3 sub-tasks + 1 synthesis.
    const covering = "회의록 요약 · 액션아이템 추출 · 일정 등록 종합 완료";
    const runner = runnerReturning((content) =>
      content.startsWith("사용자 요청:")
        ? { response: { output: covering } }
        : { response: { output: `done:${content}` } }
    );
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: listQuery, runner });

    expect(result.decomposed).toBe(true);
    expect(runner.run).toHaveBeenCalledTimes(4);
    expect(result.answer).toBe(covering);
  });

  it("re-synthesizes ONCE when the first synthesis drops sub-results (3 + 1 + 1 retry = 5 runs)", async () => {
    // "SYNTH" shares no tokens with any sub-task output, so verifySynthesisCoverage
    // flags every sub-result missing → exactly one verifier-gated re-synthesis fires.
    const runner = runnerReturning((content) =>
      content.startsWith("사용자 요청:")
        ? { response: { output: "SYNTH" } }
        : { response: { output: `done:${content}` } }
    );
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: listQuery, runner });
    expect(runner.run).toHaveBeenCalledTimes(5); // 3 sub-tasks + 1 synthesis + 1 retry, bounded
    expect(result.answer).toBe("SYNTH"); // retry no better → original kept (never worsens)
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

  it("does NOT leak an UNGROUNDED sub-task's sources into the merged evidence (fan-in source-leak: a refused subtask's secret.md must not grade the answer)", async () => {
    const query = "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록";
    const runner = {
      run: async (input: AgentRunInput): Promise<AskAgentRunResult> => {
        const content = (input.messages[input.messages.length - 1]?.content ?? "") as string;
        if (content.startsWith("사용자 요청:")) return { response: { output: "SYNTH" }, groundingSources: [{ source: "synth.md", text: "s" }] };
        if (content.includes("회의록")) return { response: { output: "I'm not sure about that." }, groundingSources: [{ source: "secret.md", text: "x" }] }; // REFUSES → ungrounded
        if (content.includes("액션")) return { response: { output: "action items extracted" }, groundingSources: [{ source: "actions.md", text: "a" }] };
        return { response: { output: "scheduled" }, groundingSources: [{ source: "cal.md", text: "c" }] };
      }
    };
    const result = await runDecomposedAgentAsk({ ...baseArgs, query, runner });
    const names = result.groundingSources.map((s) => s.source);
    expect(names).not.toContain("secret.md"); // the refused subtask's source is DROPPED
    expect(names).toContain("actions.md"); // a completed subtask's source survives
    expect(names).toContain("synth.md"); // the synthesis run's own source survives
  });

  it("flags a cross-subtask CONFLICT when two sub-answers contradict on the same topic (J2 fan-in conflict)", async () => {
    const query = "다음 3개 해줘: 1. 마감일 찾기 2. 마감일 확인 3. 일정 등록";
    const runner = runnerReturning((content) => {
      if (content.startsWith("사용자 요청:")) return { response: { output: "SYNTH" } };
      if (content.includes("찾기")) return { response: { output: "the project deadline is tuesday" } };
      if (content.includes("확인")) return { response: { output: "the project deadline is wednesday" } };
      return { response: { output: "scheduled" } };
    });
    const embed = async (t: string): Promise<readonly number[]> => (t.toLowerCase().includes("deadline") ? [1, 0] : [0, 1]);
    const result = await runDecomposedAgentAsk({ ...baseArgs, embed, query, runner });
    expect(result.subtaskConflicts).toBeDefined();
    expect(result.subtaskConflicts?.some((c) => c.includes("마감일 찾기") && c.includes("마감일 확인"))).toBe(true);
  });

  it("threads a prior step's output into the next worker for a SEQUENCED ask (dependent steps see upstream result)", async () => {
    const seen: string[] = [];
    const runner = runnerReturning((content) => {
      seen.push(content);
      if (content.startsWith("사용자 요청:")) return { response: { output: "SYNTH" } };
      return { response: { output: `done:${content.slice(0, 12)}` } };
    });
    await runDecomposedAgentAsk({ ...baseArgs, query: "먼저 회의록을 요약하고 그 다음 그 요약에서 액션아이템을 추출해줘", runner });
    const worker2 = seen.find((c) => c.includes("이전 단계 결과"));
    expect(worker2).toBeDefined();
    expect(worker2).toContain("이어서 처리");
    expect(worker2).toContain("done:"); // the actual upstream output is in the worker-2 message
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

  it("END-TO-END: a >MAX_SUBTASKS request delivers the partiality notice into the synthesis prompt the model receives (engine→CLI wiring)", async () => {
    let synthPrompt = "";
    const many = Array.from({ length: 11 }, (_v, i) => `${i + 1}. 항목${i + 1}`).join(" ");
    const runner = {
      run: vi.fn(async (input: AgentRunInput): Promise<AskAgentRunResult> => {
        const user = userContentOf(input);
        if (user.startsWith("사용자 요청:")) { synthPrompt = user; return { response: { output: "SYNTH" } }; }
        return { response: { output: `done:${user}` } };
      })
    };
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: `다음 처리해줘: ${many}`, runner });
    expect(result.truncated).toBe(true);
    expect(synthPrompt).toContain("부분 응답"); // the synthesis prompt the model actually saw carries the partiality caveat
    expect(synthPrompt).toContain("3"); // 11 - 8 dropped
  });
});

describe("runDecomposedAgentAsk — surfaces a sequenced step that ignored its upstream (MAST FM-2.6, live wiring)", () => {
  const seqQuery = "먼저 회의록을 요약하고 그 다음 그 요약에서 액션아이템을 추출해줘";
  it("a sequenced downstream step whose output ignores the upstream result populates reasoningActionGaps", async () => {
    const runner = runnerReturning((content) =>
      content.startsWith("사용자 요청:")
        ? { response: { output: "SYNTH" } }
        : content.includes("액션")
          ? { response: { output: "전혀 무관한 잡담 텍스트 입니다" } } // blind downstream
          : { response: { output: "회의 예산 삭감 요약 내용" } }       // upstream
    );
    const result = await runDecomposedAgentAsk({ ...baseArgs, query: seqQuery, runner });
    expect(result.reasoningActionGaps).toBeDefined();
    expect(result.reasoningActionGaps!.length).toBeGreaterThanOrEqual(1);
  });
});
