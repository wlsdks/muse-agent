import { describe, expect, it } from "vitest";

import {
  decomposeRequest,
  decomposeRequestWithKind,
  listHasBackReference,
  shouldDecompose,
  singleMarkerDependentSplit
} from "../src/index.js";

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

describe("decomposeRequestWithKind — back-reference detection upgrades list to sequenced=true (MAST reasoning-action mismatch)", () => {
  it("numbered list WITH English back-reference → sequenced=true and 3 subtasks", () => {
    const d = decomposeRequestWithKind("1. Fetch the sales data. 2. Summarize the result from step 1. 3. Email me that summary.");
    expect(d.sequenced).toBe(true);
    expect(d.subtasks.length).toBe(3);
  });

  it("numbered list WITH Korean back-reference → sequenced=true", () => {
    const d = decomposeRequestWithKind("1. 회의록 요약 2. 그 요약에서 액션아이템 추출 3. 일정 등록");
    expect(d.sequenced).toBe(true);
  });

  it("bulleted list WITH back-reference → sequenced=true", () => {
    const d = decomposeRequestWithKind("- pull the metrics\n- chart the result\n- email the above");
    expect(d.sequenced).toBe(true);
  });

  it("REGRESSION: plain independent Korean numbered list → sequenced=false (isolation preserved)", () => {
    const d = decomposeRequestWithKind("다음 3개 해줘: 1. 회의록 요약 2. 액션아이템 추출 3. 일정 등록");
    expect(d.sequenced).toBe(false);
  });

  it("REGRESSION: plain independent English numbered list → sequenced=false", () => {
    const d = decomposeRequestWithKind("1. List my notes. 2. List my tasks. 3. List my events.");
    expect(d.sequenced).toBe(false);
  });
});

describe("listHasBackReference — pure helper (direct unit tests)", () => {
  it("returns false when the ONLY back-reference token is in item 0 (items[1..] only count)", () => {
    expect(listHasBackReference(["use the result here", "do X", "do Y"])).toBe(false);
  });

  it("returns true when items[1] contains a back-reference token", () => {
    expect(listHasBackReference(["fetch data", "summarize the result"])).toBe(true);
  });

  it("returns false for an independent list with no back-reference tokens", () => {
    expect(listHasBackReference(["회의록 요약", "액션아이템 추출", "일정 등록"])).toBe(false);
  });

  it("returns true for a Korean back-reference in items[1]", () => {
    expect(listHasBackReference(["회의록 요약", "그 요약에서 액션아이템 추출"])).toBe(true);
  });
});

describe("shouldDecompose — single-marker DEPENDENT two-step now fans out (sequenced-threading no longer starved)", () => {
  it("decomposes a single-marker dependent two-step that the 2-marker threshold dropped (Korean)", () => {
    const d = shouldDecompose("노트를 검색한 뒤 그 결과를 요약해줘");
    expect(d.decompose).toBe(true);
    expect(d.signals.sequencing).toBe(1);
    expect(d.reason).toContain("back-reference");
  });

  it("decomposes a single-marker dependent two-step (English)", () => {
    const d = shouldDecompose("First search my notes, then summarize the result");
    expect(d.decompose).toBe(true);
    expect(d.signals.sequencing).toBe(1);
  });

  it("the admitted single-marker request also splits into a SEQUENCED 2-step downstream (gate↔split consistency)", () => {
    const request = "노트를 검색한 뒤 그 결과를 요약해줘";
    expect(shouldDecompose(request).decompose).toBe(true);
    const split = decomposeRequestWithKind(request);
    expect(split.subtasks.length).toBe(2);
    expect(split.sequenced).toBe(true);
  });

  // The fire-11 flat-scan over-fire class: a single ordered marker next to a
  // benign MENTION-of / ASK-ABOUT a step or result must STAY single-agent.
  it.each([
    "그 결과 먼저 보여줘",
    "그 요약 먼저 읽어줘",
    "먼저 위의 메뉴에서 골라줘",
    "First, what is the result of the game?",
    "First, what is the previous step in the recipe?",
    "Finally, what are those results used for?",
    "방금 뭐라고 했어?",
    "회의 끝난 후에 알려줘",
    "이 문서 요약해줘",
    "그 결과는 어땠어?"
  ])("does NOT decompose a benign single-marker / mention-of-a-step request: %s", (q) => {
    expect(shouldDecompose(q).decompose).toBe(false);
  });
});

describe("singleMarkerDependentSplit — pure helper (split-first, then back-reference in the TAIL)", () => {
  it("true: a single ordered marker splits and a tail clause acts on the prior output", () => {
    expect(singleMarkerDependentSplit("노트를 검색한 뒤 그 결과를 요약해줘")).toBe(true);
    expect(singleMarkerDependentSplit("First search my notes, then summarize the result")).toBe(true);
  });

  it("false: a single marker whose back-ref token sits in the LEADING clause (no tail dependency)", () => {
    // splits on 먼저 → ["그 결과", "보여줘"]; the back-ref is in item[0], tail is clean
    expect(singleMarkerDependentSplit("그 결과 먼저 보여줘")).toBe(false);
  });

  it("false: no ordered marker → no split → never fires", () => {
    expect(singleMarkerDependentSplit("이 문서 요약해줘")).toBe(false);
    expect(singleMarkerDependentSplit("회의 끝난 후에 알려줘")).toBe(false);
  });

  it("false: a single marker that splits but the tail merely MENTIONS a step (no act-on)", () => {
    expect(singleMarkerDependentSplit("First, what is the result of the game?")).toBe(false);
  });
});
