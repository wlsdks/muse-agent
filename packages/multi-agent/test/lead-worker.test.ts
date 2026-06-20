import { describe, expect, it, vi } from "vitest";

import {
  dedupeSubtasks,
  runLeadWorkerTask,
  type LeadWorkerDeps,
  type Subtask,
  type SubtaskExecution,
  type SubtaskOutput
} from "../src/index.js";

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

  it("isolates context — a worker never sees the other sub-tasks' text", async () => {
    const inputs: string[] = [];
    const execute = vi.fn(async (s: Subtask) => {
      inputs.push(s.text);
      return { output: `done:${s.text}` };
    });
    await runLeadWorkerTask("먼저 회의록을 요약하고 그 다음 액션아이템을 추출해줘", deps({ execute }));

    expect(inputs.length).toBe(2);
    expect(inputs[0]).not.toContain("액션아이템");
    expect(inputs[1]).not.toContain("회의록");
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
