import { describe, expect, it } from "vitest";

import { buildPlanningSystemPrompt } from "../src/index.js";

// Snapshot of the BEHAVIOR-CRITICAL planner system prompt (agent-eval / backlog
// P5). This exact text shapes how the local Qwen emits its tool-call plan, so an
// accidental edit silently changes agent behavior — CLAUDE.md: "Snapshot-test
// prompt text and tool protocols when behavior matters." The snapshot pins the
// full rendered prompt; an intentional change must update it (visible in review),
// an accidental one fails. Paired with structural invariants that MUST hold.
describe("buildPlanningSystemPrompt — behavior-critical prompt snapshot", () => {
  const FIXED = {
    toolDescriptions: "- time_now: current time\n- web_search: search the web",
    userPrompt: "what time is it in Tokyo?",
  };

  it("renders the exact planner prompt for a fixed input", () => {
    expect(buildPlanningSystemPrompt(FIXED)).toMatchInlineSnapshot(`
      "[Role]
      당신은 도구 호출 계획을 세우는 플래너입니다.
      사용자의 요청을 분석하고, 필요한 도구 호출 순서를 JSON으로 출력하세요.
      절대 도구를 직접 실행하지 마세요. 계획만 출력합니다.

      [Available Tools]
      아래 도구만 계획에 포함할 수 있습니다.
      목록에 없는 도구는 사용할 수 없습니다.

      - time_now: current time
      - web_search: search the web

      [Output Format]
      반드시 JSON 배열만 출력하세요. 다른 텍스트, 설명, 마크다운은 금지합니다.
      각 단계는 다음 필드를 포함합니다:
      - tool: 도구 이름 (Available Tools에 있는 것만)
      - args: 도구에 전달할 인자 (객체)
      - description: 이 단계의 목적 (간단한 한국어 설명)

      예시:
      [{"tool":"jira_get_issue","args":{"issueKey":"EXAMPLE-1"},"description":"이슈 상세 조회"},
       {"tool":"confluence_search_by_text","args":{"keyword":"온보딩 가이드"},"description":"관련 문서 검색"}]

      [Constraints]
      1. 도구가 필요 없으면 빈 배열 []을 반환하세요.
      2. 단계 순서는 실행 순서입니다. 의존 관계를 고려하세요.
      3. 동일 도구를 다른 인자로 여러 번 호출할 수 있습니다.
      4. 각 단계의 args는 해당 도구의 입력 스키마에 맞춰야 합니다.
      5. 응답은 [ 로 시작하고 ] 로 끝나야 합니다.

      [User Request]
      what time is it in Tokyo?"
    `);
  });

  it("holds the structural contract the planner depends on", () => {
    const out = buildPlanningSystemPrompt(FIXED);
    expect(out.startsWith("[Role]")).toBe(true);
    expect(out).toContain("[Available Tools]");
    expect(out).toContain("- time_now: current time");
    expect(out).toContain("[Output Format]");
    expect(out).toContain("[Constraints]");
    // the user request is appended verbatim at the end
    expect(out.trimEnd().endsWith("what time is it in Tokyo?")).toBe(true);
  });

  it("appends an optional base prompt before the planner sections", () => {
    const out = buildPlanningSystemPrompt({ ...FIXED, basePrompt: "You are Muse." });
    expect(out.startsWith("You are Muse.")).toBe(true);
    expect(out).toContain("[Role]");
  });
});
