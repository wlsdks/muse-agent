import { describe, expect, it } from "vitest";

import { decomposeRequest, decomposeRequestWithKind, shouldDecompose } from "../src/index.js";

describe("decomposeRequestWithKind — flags a SEQUENCED (dependent) split vs an INDEPENDENT list", () => {
  it("marks an ordered sequence sequenced=true (later steps may depend on earlier output)", () => {
    expect(decomposeRequestWithKind("먼저 회의록을 요약하고 그 다음 그 요약에서 액션아이템을 추출해줘").sequenced).toBe(true);
    expect(decomposeRequestWithKind("First, gather the notes. Then summarize them.").sequenced).toBe(true);
  });
  it("marks a numbered / bulleted list sequenced=false (independent items, stay isolated)", () => {
    expect(decomposeRequestWithKind("다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록").sequenced).toBe(false);
    expect(decomposeRequestWithKind("정리해줘:\n- 비용\n- 일정\n- 리스크").sequenced).toBe(false);
  });
  it("a no-structure request is sequenced=false with one subtask", () => {
    const d = decomposeRequestWithKind("이 문서 요약해줘");
    expect(d.sequenced).toBe(false);
    expect(d.subtasks.length).toBe(1);
  });
  it("decomposeRequest stays a thin back-compat wrapper (same subtasks)", () => {
    expect(decomposeRequest("먼저 A 그 다음 B").map((s) => s.text)).toEqual(decomposeRequestWithKind("먼저 A 그 다음 B").subtasks.map((s) => s.text));
  });
});

describe("shouldDecompose — single-agent bias (no fan-out for simple asks)", () => {
  it("does NOT decompose a simple lookup", () => {
    for (const q of ["지금 몇시야?", "김철수 전화번호 뭐야", "what time is it?", "내일 일정 추가해줘"]) {
      const d = shouldDecompose(q);
      expect(d.decompose).toBe(false);
    }
  });

  it("does NOT decompose a single-document synthesis ask (synthesis signal alone is insufficient)", () => {
    const d = shouldDecompose("이 문서 요약해줘");
    expect(d.decompose).toBe(false);
    expect(d.signals.synthesis).toBe(true);
    expect(d.signals.broadScope).toBe(false);
  });

  it("does NOT decompose on a lone sequencing marker", () => {
    const d = shouldDecompose("회의 끝난 후에 알려줘");
    expect(d.decompose).toBe(false);
  });
});

describe("shouldDecompose — fan-out for genuine multi-task shapes", () => {
  it("decomposes an explicit numbered list of 3+ items", () => {
    const d = shouldDecompose("다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록");
    expect(d.decompose).toBe(true);
    expect(d.signals.enumeration).toBeGreaterThanOrEqual(3);
    expect(d.reason).toContain("list");
  });

  it("decomposes a bulleted list of 3+ items", () => {
    const d = shouldDecompose("정리해줘:\n- 비용\n- 일정\n- 리스크");
    expect(d.decompose).toBe(true);
    expect(d.signals.enumeration).toBeGreaterThanOrEqual(3);
  });

  it("decomposes a multi-step sequence (2+ ordered markers)", () => {
    const d = shouldDecompose("먼저 회의록을 요약하고 그 다음 액션아이템을 추출해줘");
    expect(d.decompose).toBe(true);
    expect(d.signals.sequencing).toBeGreaterThanOrEqual(2);
  });

  it("decomposes English multi-step sequence", () => {
    const d = shouldDecompose("First, gather the notes. Then summarize each. After that, list the risks.");
    expect(d.decompose).toBe(true);
  });

  it("decomposes a broad-scope aggregation (scope quantifier + synthesis)", () => {
    const d = shouldDecompose("내 노트 전부 훑어서 분기별 보고서 만들어줘");
    expect(d.decompose).toBe(true);
    expect(d.signals.broadScope).toBe(true);
    expect(d.signals.synthesis).toBe(true);
  });

  it("does NOT decompose broad scope WITHOUT a synthesis ask", () => {
    const d = shouldDecompose("모든 노트 보여줘");
    expect(d.decompose).toBe(false);
    expect(d.signals.broadScope).toBe(true);
    expect(d.signals.synthesis).toBe(false);
  });
});

describe("decomposeRequest — structural split into independent sub-tasks", () => {
  it("splits a numbered list into one sub-task per item", () => {
    const subtasks = decomposeRequest("다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록");
    expect(subtasks.map((s) => s.text)).toEqual(["회의록 요약", "액션아이템 추출", "일정 등록"]);
    expect(subtasks.map((s) => s.id)).toEqual(["subtask_1", "subtask_2", "subtask_3"]);
  });

  it("splits a bulleted list", () => {
    const subtasks = decomposeRequest("정리해줘:\n- 비용\n- 일정\n- 리스크");
    expect(subtasks.map((s) => s.text)).toEqual(["비용", "일정", "리스크"]);
  });

  it("splits a Korean ordered sequence on its markers", () => {
    const subtasks = decomposeRequest("먼저 회의록을 요약하고 그 다음 액션아이템을 추출해줘");
    expect(subtasks.length).toBe(2);
    expect(subtasks[0].text).toContain("회의록");
    expect(subtasks[1].text).toContain("액션아이템");
  });

  it("splits an English ordered sequence", () => {
    const subtasks = decomposeRequest("First, gather the notes. Then summarize each. After that, list the risks.");
    expect(subtasks.length).toBeGreaterThanOrEqual(3);
  });

  it("returns ONE sub-task (the whole request) when there is no structure", () => {
    for (const q of ["지금 몇시야?", "내 노트 전부 훑어서 보고서 만들어줘", "이 문서 요약해줘"]) {
      const subtasks = decomposeRequest(q);
      expect(subtasks.length).toBe(1);
      expect(subtasks[0].id).toBe("subtask_1");
      expect(subtasks[0].text).toBe(q.trim());
    }
  });

  it("ignores a single numbered marker (needs 2+ to be a list)", () => {
    const subtasks = decomposeRequest("1. 회의록만 요약해줘");
    expect(subtasks.length).toBe(1);
  });
});
