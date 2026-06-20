import { describe, expect, it, vi } from "vitest";

import {
  dedupeSubtasks,
  detectSubtaskConflicts,
  runLeadWorkerTask,
  verifySynthesisCoverage,
  type LeadWorkerDeps,
  type Subtask,
  type SubtaskExecution,
  type SubtaskOutput
} from "../src/index.js";

describe("detectSubtaskConflicts — cross-subtask CONTRADICTION on the fan-in (an internally-inconsistent answer is GROUNDED != TRUE)", () => {
  // stub embed: same-topic vector for deadline statements, orthogonal otherwise
  const embed = async (t: string): Promise<readonly number[]> => (t.toLowerCase().includes("deadline") ? [1, 0] : [0, 1]);
  const ex = (text: string, output: string, status: SubtaskExecution["status"] = "completed"): SubtaskExecution => ({ output, status, subtask: { id: "s", text } });
  it("flags two completed sub-answers that DISAGREE on the same topic (high sim + high overlap + neither-subset)", async () => {
    const out = await detectSubtaskConflicts(
      [ex("find deadline", "the project deadline is tuesday"), ex("confirm deadline", "the project deadline is wednesday")],
      embed
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("find deadline");
    expect(out[0]).toContain("confirm deadline");
  });
  it("does NOT flag sub-answers on DIFFERENT topics (low cosine)", async () => {
    expect(await detectSubtaskConflicts([ex("a", "the project deadline is tuesday"), ex("b", "lunch is kimbap today")], embed)).toEqual([]);
  });
  it("does NOT flag an ELABORATION (one is a superset — neither-subset gate)", async () => {
    expect(await detectSubtaskConflicts([ex("a", "the project deadline is tuesday"), ex("b", "the project deadline is tuesday afternoon")], embed)).toEqual([]);
  });
  it("ignores failed / ungrounded sub-tasks — only completed pairs are compared", async () => {
    expect(await detectSubtaskConflicts([ex("a", "the project deadline is tuesday"), ex("b", "the project deadline is wednesday", "failed")], embed)).toEqual([]);
  });
  it("fail-soft: an embed that throws yields no conflicts (never blocks the run)", async () => {
    expect(await detectSubtaskConflicts([ex("a", "the project deadline is tuesday"), ex("b", "the project deadline is wednesday")], async () => { throw new Error("down"); })).toEqual([]);
  });
});

describe("verifySynthesisCoverage — objective-satisfaction on the fan-in (maker != judge)", () => {
  const ex = (text: string, output: string, status: SubtaskExecution["status"] = "completed"): SubtaskExecution => ({ output, status, subtask: { id: "s", text } });
  it("flags a completed sub-task the synthesis DROPPED (its salient tokens absent)", () => {
    const v = verifySynthesisCoverage("The Q3 budget is approved at 5M.", [
      ex("summarize Q3 budget", "Q3 budget approved at 5M"),
      ex("list action items", "Action items: hire two engineers, ship the payments API")
    ]);
    expect(v.satisfied).toBe(false);
    expect(v.missing).toContain("list action items");
  });
  it("passes when the synthesis incorporates every completed sub-task", () => {
    const v = verifySynthesisCoverage("Q3 budget approved at 5M. Action items: hire engineers, ship the payments API.", [
      ex("summarize Q3 budget", "Q3 budget approved at 5M"),
      ex("list action items", "Action items: hire two engineers, ship the payments API")
    ]);
    expect(v.satisfied).toBe(true);
    expect(v.missing).toEqual([]);
  });
  it("ignores failed / empty sub-tasks — only completed, non-empty ones must be covered", () => {
    const v = verifySynthesisCoverage("done", [ex("x", "", "completed"), ex("y", "irrelevant unrelated stuff", "failed")]);
    expect(v.satisfied).toBe(true);
  });
});

describe("dedupeSubtasks — MAST #3: no duplicated sub-agent work", () => {
  it("drops case/whitespace-duplicate text (keep first, re-id sequentially, drop empty)", () => {
    const out = dedupeSubtasks([
      { id: "subtask_1", text: "회의록 요약" },
      { id: "subtask_2", text: "  회의록   요약 " },
      { id: "subtask_3", text: "회의록 요약" },
      { id: "subtask_4", text: "액션 추출" },
      { id: "subtask_5", text: "   " }
    ]);
    expect(out.map((s) => s.text)).toEqual(["회의록 요약", "액션 추출"]);
    expect(out.map((s) => s.id)).toEqual(["subtask_1", "subtask_2"]);
  });
  it("leaves already-distinct subtasks unchanged", () => {
    const input: readonly Subtask[] = [{ id: "subtask_1", text: "a" }, { id: "subtask_2", text: "b" }];
    expect(dedupeSubtasks(input).map((s) => s.text)).toEqual(["a", "b"]);
  });
});

describe("runLeadWorkerTask — dedupes duplicate planner subtasks before fan-out (MAST #3)", () => {
  it("runs a duplicated subtask ONCE (no N× wall-clock waste on a single GPU)", async () => {
    const execute = vi.fn(async (s: Subtask) => ({ output: `done:${s.text}` }));
    const planner = async (): Promise<readonly string[]> => ["요약 작성", "요약 작성", "액션 추출"];
    const result = await runLeadWorkerTask("내 노트 전부 훑어서 분기별 보고서 만들어줘", deps({ execute, planner }));
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.subtasks.map((s) => s.text)).toEqual(["요약 작성", "액션 추출"]);
  });
  it("leaves distinct planner subtasks untouched (regression guard)", async () => {
    const execute = vi.fn(async (s: Subtask) => ({ output: `done:${s.text}` }));
    const planner = async (): Promise<readonly string[]> => ["A 요약", "B 추출", "C 정리"];
    const result = await runLeadWorkerTask("내 노트 전부 훑어서 분기별 보고서 만들어줘", deps({ execute, planner }));
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.subtasks).toHaveLength(3);
  });
});

describe("runLeadWorkerTask — fan-in verifier surfaces a dropped sub-task instead of returning confident-complete (G1)", () => {
  const req = "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록";
  it("sets synthesisIncomplete + reason when verifySynthesis reports a dropped sub-task", async () => {
    const result = await runLeadWorkerTask(req, deps({ verifySynthesis: () => ({ missing: ["일정 등록"], satisfied: false }) }));
    expect(result.synthesisIncomplete).toEqual(["일정 등록"]);
    expect(result.reason).toContain("synthesis incomplete");
  });
  it("leaves synthesisIncomplete unset when the verifier is satisfied", async () => {
    const result = await runLeadWorkerTask(req, deps({ verifySynthesis: () => ({ missing: [], satisfied: true }) }));
    expect(result.synthesisIncomplete).toBeUndefined();
  });
  it("is back-compat: no verifier ⇒ no synthesisIncomplete; a throwing verifier is fail-soft", async () => {
    expect((await runLeadWorkerTask(req, deps())).synthesisIncomplete).toBeUndefined();
    const throwing = await runLeadWorkerTask(req, deps({ verifySynthesis: () => { throw new Error("boom"); } }));
    expect(throwing.synthesisIncomplete).toBeUndefined();
    expect(throwing.finalAnswer).not.toBe("");
  });
});

describe("runLeadWorkerTask — surfaces cross-subtask conflicts at the fan-in (not silently concatenated)", () => {
  const req = "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록";
  it("sets subtaskConflicts + reason when detectConflicts reports a contradiction", async () => {
    const result = await runLeadWorkerTask(req, deps({ detectConflicts: () => Promise.resolve(['"회의록 요약" vs "액션아이템 추출"']) }));
    expect(result.subtaskConflicts).toEqual(['"회의록 요약" vs "액션아이템 추출"']);
    expect(result.reason).toContain("conflict");
  });
  it("back-compat: no detector / no conflicts ⇒ unset; a throwing detector is fail-soft", async () => {
    expect((await runLeadWorkerTask(req, deps({ detectConflicts: () => Promise.resolve([]) }))).subtaskConflicts).toBeUndefined();
    expect((await runLeadWorkerTask(req, deps())).subtaskConflicts).toBeUndefined();
    const throwing = await runLeadWorkerTask(req, deps({ detectConflicts: () => { throw new Error("boom"); } }));
    expect(throwing.subtaskConflicts).toBeUndefined();
    expect(throwing.finalAnswer).not.toBe("");
  });
});

describe("runLeadWorkerTask — verifier-gated single re-synthesis recovers a dropped sub-task (H1 follow-up)", () => {
  const req = "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록";

  it("re-synthesizes ONCE when incomplete and the retry that COVERS everything is accepted (synthesisIncomplete cleared)", async () => {
    let call = 0;
    const synthesize = async (): Promise<string> => (++call === 1 ? "partial" : "full");
    const verifySynthesis = (_r: string, answer: string) =>
      answer === "full" ? { missing: [], satisfied: true } : { missing: ["일정 등록"], satisfied: false };
    const result = await runLeadWorkerTask(req, deps({ synthesize, verifySynthesis }));
    expect(result.finalAnswer).toBe("full");
    expect(result.synthesisIncomplete).toBeUndefined();
    expect(call).toBe(2); // exactly one retry, not an unbounded loop
  });

  it("threads the MISSING sub-results into the retry request (not a bare 'try again')", async () => {
    const seen: string[] = [];
    const synthesize = async (request: string): Promise<string> => { seen.push(request); return seen.length === 1 ? "partial" : "full"; };
    const verifySynthesis = (_r: string, answer: string) =>
      answer === "full" ? { missing: [], satisfied: true } : { missing: ["일정 등록"], satisfied: false };
    await runLeadWorkerTask(req, deps({ synthesize, verifySynthesis }));
    expect(seen[1]).toContain("일정 등록"); // the retry prompt names what was dropped
  });

  it("accepts a retry that drops FEWER results (2 missing → 1) and keeps the smaller flag", async () => {
    let call = 0;
    const synthesize = async (): Promise<string> => (++call === 1 ? "a" : "b");
    const verifySynthesis = (_r: string, answer: string) =>
      answer === "a" ? { missing: ["x", "y"], satisfied: false } : { missing: ["y"], satisfied: false };
    const result = await runLeadWorkerTask(req, deps({ synthesize, verifySynthesis }));
    expect(result.finalAnswer).toBe("b");
    expect(result.synthesisIncomplete).toEqual(["y"]);
  });

  it("REJECTS a retry that is no better — keeps the original answer + flag, retries only ONCE (never worsens)", async () => {
    let call = 0;
    const synthesize = async (): Promise<string> => (++call === 1 ? "orig" : "worse");
    const verifySynthesis = (_r: string, answer: string) =>
      answer === "orig" ? { missing: ["y"], satisfied: false } : { missing: ["y", "z"], satisfied: false };
    const result = await runLeadWorkerTask(req, deps({ synthesize, verifySynthesis }));
    expect(result.finalAnswer).toBe("orig"); // retry was worse → original kept
    expect(result.synthesisIncomplete).toEqual(["y"]);
    expect(call).toBe(2); // bounded: one retry attempt only
  });

  it("does NOT accept a retry whose verifier ERRORED — keeps the original flagged answer (never claims false completeness)", async () => {
    let call = 0;
    const synthesize = async (): Promise<string> => (++call === 1 ? "orig" : "retry");
    let verifyCall = 0;
    const verifySynthesis = () => {
      if (++verifyCall === 1) return { missing: ["y"], satisfied: false };
      throw new Error("verifier down on retry");
    };
    const result = await runLeadWorkerTask(req, deps({ synthesize, verifySynthesis }));
    expect(result.finalAnswer).toBe("orig"); // unverified retry rejected → original kept
    expect(result.synthesisIncomplete).toEqual(["y"]); // flag NOT cleared by an errored retry
  });
});

function deps(overrides: Partial<LeadWorkerDeps> = {}): LeadWorkerDeps {
  return {
    execute: async (subtask: Subtask): Promise<SubtaskOutput> => ({ output: `done:${subtask.text}` }),
    synthesize: async (_request: string, executions: readonly SubtaskExecution[]): Promise<string> =>
      executions
        .filter((e) => e.status === "completed")
        .map((e) => e.output)
        .join(" | "),
    ...overrides
  };
}

describe("runLeadWorkerTask — simple request bypasses decomposition", () => {
  it("runs a simple ask as a single execution (no fan-out)", async () => {
    const execute = vi.fn(async (s: Subtask) => ({ output: `answer:${s.text}` }));
    const result = await runLeadWorkerTask("지금 몇시야?", deps({ execute }));

    expect(result.decomposed).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.finalAnswer).toBe("answer:지금 몇시야?");
    expect(result.subtasks.length).toBe(1);
  });
});

describe("runLeadWorkerTask — fan-out into independent sub-tasks", () => {
  it("runs each list item as its OWN execution and synthesizes", async () => {
    const seen: string[] = [];
    const execute = vi.fn(async (s: Subtask) => {
      seen.push(s.text);
      return { output: `done:${s.text}` };
    });
    const synthesize = vi.fn(async (_q: string, execs: readonly SubtaskExecution[]) =>
      `report(${execs.length})`
    );

    const result = await runLeadWorkerTask(
      "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록",
      deps({ execute, synthesize })
    );

    expect(result.decomposed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(result.finalAnswer).toBe("report(3)");
  });

  it("isolates context — an INDEPENDENT (list) worker never sees the other sub-tasks' text", async () => {
    const inputs: string[] = [];
    const execute = vi.fn(async (s: Subtask) => {
      inputs.push(s.text);
      return { output: `done:${s.text}` };
    });
    await runLeadWorkerTask("다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록", deps({ execute }));

    expect(inputs.length).toBe(3);
    expect(inputs[0]).not.toContain("액션아이템");
    expect(inputs[1]).not.toContain("회의록");
  });
});

describe("runLeadWorkerTask — SEQUENCED decomposition threads prior step output forward (MAST reasoning-action mismatch)", () => {
  const capturePriors = (): { priors: (readonly string[] | undefined)[]; execute: (s: Subtask, prior?: readonly string[]) => Promise<SubtaskOutput> } => {
    const priors: (readonly string[] | undefined)[] = [];
    return { execute: async (s, prior) => { priors.push(prior); return { output: `done:${s.text}` }; }, priors };
  };
  it("passes each completed prior step's output to the next worker for an ordered sequence", async () => {
    const { priors, execute } = capturePriors();
    await runLeadWorkerTask("먼저 회의록을 요약하고 그 다음 그 요약에서 액션아이템을 추출해줘", deps({ execute }));
    expect(priors).toHaveLength(2);
    expect(priors[0]).toBeUndefined(); // step 1 has no prior
    expect(priors[1]?.some((p) => p.includes("회의록"))).toBe(true); // step 2 SEES step 1's output
  });
  it("does NOT thread for an INDEPENDENT (numbered) list — isolation preserved", async () => {
    const { priors, execute } = capturePriors();
    await runLeadWorkerTask("다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록", deps({ execute }));
    expect(priors.every((p) => p === undefined)).toBe(true);
  });
  it("fail-closes: a failed (blank) prior step is NOT threaded forward (no blank/garbage context)", async () => {
    const priors: (readonly string[] | undefined)[] = [];
    const execute = async (s: Subtask, prior?: readonly string[]): Promise<SubtaskOutput> => {
      priors.push(prior);
      return { output: s.text.includes("회의록") ? "   " : `done:${s.text}` }; // step 1 returns blank → failed
    };
    await runLeadWorkerTask("먼저 회의록을 요약하고 그 다음 액션아이템을 추출해줘", deps({ execute }));
    expect(priors[1] ?? []).toEqual([]); // step 2 gets NO prior (the blank failed, not threaded)
  });
});

describe("runLeadWorkerTask — failure propagation (MAST: never swallow)", () => {
  it("records a thrown sub-task as failed, continues the rest, surfaces all to synthesize", async () => {
    const execute = vi.fn(async (s: Subtask) => {
      if (s.text.includes("액션아이템")) throw new Error("worker boom");
      return { output: `done:${s.text}` };
    });
    let handed: readonly SubtaskExecution[] = [];
    const synthesize = vi.fn(async (_q: string, execs: readonly SubtaskExecution[]) => {
      handed = execs;
      return "synth";
    });

    const result = await runLeadWorkerTask(
      "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록",
      deps({ execute, synthesize })
    );

    expect(execute).toHaveBeenCalledTimes(3);
    expect(handed.length).toBe(3);
    const failed = result.executions.find((e) => e.status === "failed");
    expect(failed?.error).toContain("worker boom");
    expect(result.executions.filter((e) => e.status === "completed").length).toBe(2);
  });

  it("fail-closes a blank sub-task output (never folds an empty answer as completed)", async () => {
    const execute = vi.fn(async (s: Subtask) => ({ output: s.text.includes("회의록") ? "   " : `done:${s.text}` }));
    const result = await runLeadWorkerTask(
      "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록",
      deps({ execute })
    );
    const blank = result.executions.find((e) => e.subtask.text === "회의록 요약");
    expect(blank?.status).toBe("failed");
    expect(blank?.error).toContain("empty");
    expect(result.executions.filter((e) => e.status === "completed").length).toBe(2);
  });

  it("marks a sub-task ungrounded when the grounding gate rejects it (fail-close)", async () => {
    const groundingGate = vi.fn((out: SubtaskOutput) => !out.output.includes("회의록"));
    const result = await runLeadWorkerTask(
      "다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록",
      deps({ groundingGate })
    );

    const ungrounded = result.executions.filter((e) => e.status === "ungrounded");
    expect(ungrounded.length).toBe(1);
    expect(ungrounded[0].subtask.text).toBe("회의록 요약");
  });
});

describe("runLeadWorkerTask — model planner for unstructured complex asks", () => {
  it("invokes the planner for a broad-scope aggregation with no literal structure", async () => {
    const planner = vi.fn(async () => ["1분기 정리", "2분기 정리", "3분기 정리"]);
    const execute = vi.fn(async (s: Subtask) => ({ output: `done:${s.text}` }));
    const result = await runLeadWorkerTask("내 노트 전부 훑어서 분기별 보고서 만들어줘", deps({ execute, planner }));

    expect(planner).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(result.reason).toContain("model-planned");
  });

  it("falls back to single execution when the planner returns fewer than 2 tasks", async () => {
    const planner = vi.fn(async () => ["just one"]);
    const execute = vi.fn(async (s: Subtask) => ({ output: `done:${s.text}` }));
    const result = await runLeadWorkerTask("내 노트 전부 훑어서 보고서 만들어줘", deps({ execute, planner }));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.decomposed).toBe(false);
  });
});

describe("runLeadWorkerTask — bounded termination", () => {
  it("caps the number of sub-tasks at MAX_SUBTASKS", async () => {
    const items = Array.from({ length: 20 }, (_v, i) => `${i + 1}. 항목${i + 1}`).join(" ");
    const execute = vi.fn(async (s: Subtask) => ({ output: `done:${s.text}` }));
    const result = await runLeadWorkerTask(`다음 처리해줘: ${items}`, deps({ execute }));

    expect(execute.mock.calls.length).toBeLessThanOrEqual(8);
    expect(result.reason).toContain("capped at 8");
  });
});
