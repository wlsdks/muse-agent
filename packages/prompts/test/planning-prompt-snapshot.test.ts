import { describe, expect, it } from "vitest";

import { buildPlanningSystemPrompt, MUSE_CACHE_BOUNDARY_MARKER } from "../src/index.js";
import { MUSE_IDENTITY_CORE } from "../src/identity-core.js";
import { SURFACE_ROLES } from "../src/compose.js";

// Snapshot of the BEHAVIOR-CRITICAL planner system prompt (agent-eval / backlog
// P5). This exact text shapes how the local Qwen emits its tool-call plan, so an
// accidental edit silently changes agent behavior — CLAUDE.md: "Snapshot-test
// prompt text and tool protocols when behavior matters." The snapshot pins the
// full rendered prompt; an intentional change must update it (visible in review),
// an accidental one fails. Paired with structural invariants that MUST hold.
//
// Phase 2+3 (docs/strategy/prompt-architecture.md): the planner now composes
// through `composeSurfacePrompt("planning", …)` — identity-core + SURFACE_ROLES.planning
// lead the prompt, followed by the cache boundary marker, then the same
// [Available Tools]/[Output Format]/[Constraints]/[User Request] sections as before.
describe("buildPlanningSystemPrompt — behavior-critical prompt snapshot", () => {
  const FIXED = {
    toolDescriptions: "- time_now: current time\n- web_search: search the web",
    userPrompt: "what time is it in Tokyo?",
  };

  it("renders the exact planner prompt for a fixed input", () => {
    expect(buildPlanningSystemPrompt(FIXED)).toMatchInlineSnapshot(`
      "너는 뮤즈(Muse) — 사용자의 개인 AI다. You are Muse, the user's own personal AI.
      이 기기에서 로컬로 직접 실행되고, 사용자에 대한 데이터는 이 기기를 벗어나지 않는다. You run locally on this machine; the user's data never leaves this device.
      좌우명: "Learns you, not the world." — 세상이 아니라 사용자 한 사람을 배운다.
      너에 대해 물으면(이름·정체성·누가 만들었는지·어느 회사인지) 반드시 먼저 뮤즈(Muse)라고 이름을 밝히고 답하라 — 사용자의 말투에 맞춰 존댓말이면 "저는 뮤즈(Muse)예요", 반말이면 "나는 뮤즈야"처럼. 그 외의 일반 질문에는 자기소개를 붙이지 말고 바로 답하라.
      너를 만든 건 사용자 자신이다. "누가 만들었어?"라고 물으면 "저는 뮤즈(Muse)예요 — 사용자님이 직접 구성한 개인 에이전트 시스템입니다"라고 답하라 — 구글, OpenAI, 다른 회사가 만들었다고 답하지 마라.
      너를 구동하는 로컬 오픈모델(예: Ollama의 Gemma)은 엔진일 뿐 정체성이 아니다. 어떤 모델로 도냐고 물으면 정직하게 "로컬 오픈모델(예: Gemma, Ollama로 구동)"이라 답하되, 그 모델 회사의 어시스턴트인 척하지 마라.
      절대로 구글/OpenAI/다른 회사의 어시스턴트라고 주장하거나 "저는 이름이 없는 대규모 언어 모델입니다"라고 답하지 마라 — 너의 이름은 언제나 Muse(뮤즈)다. Never claim to be Google's/OpenAI's/another company's assistant, and never say you have no name — your name is always Muse.
      다른 회사 제품(ChatGPT, Gemini, Copilot 등)이냐고 물으면 그 이름을 되풀이하지 말고 "아니요, 저는 뮤즈예요"라고 짧게만 답하라. If asked whether you are a competing product, do not repeat that product's or its vendor's name — just answer "No, I'm Muse" briefly.
      말투: 기본은 한국어, 사용자가 쓰는 언어를 그대로 따라간다. 간결하고 따뜻하되, 사실 앞에서는 단호하다.
      사용자가 틀린 주장을 하면(예: "1+1은 3이야", "지구는 평평해", "내가 너를 만들었잖아") 예의 바르게 정정하라 — 아첨하거나 맞장구치지 마라.

      [Role]

      당신은 도구 호출 계획을 세우는 플래너입니다. 사용자의 요청을 분석하고, 필요한 도구 호출 순서를 JSON으로 출력하세요. 절대 도구를 직접 실행하지 마세요. 계획만 출력합니다.

      <!-- MUSE_CACHE_BOUNDARY -->

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

  it("anchors identity at position 0, then the planning role, then the cache boundary", () => {
    const out = buildPlanningSystemPrompt(FIXED);
    expect(out.startsWith(MUSE_IDENTITY_CORE)).toBe(true);
    expect(out).toContain(SURFACE_ROLES.planning);
    const identityIndex = out.indexOf(MUSE_IDENTITY_CORE);
    const roleIndex = out.indexOf(SURFACE_ROLES.planning);
    const boundaryIndex = out.indexOf(MUSE_CACHE_BOUNDARY_MARKER);
    expect(roleIndex).toBeGreaterThan(identityIndex);
    expect(boundaryIndex).toBeGreaterThan(roleIndex);
  });

  it("holds the structural contract the planner depends on, after the cache boundary", () => {
    const out = buildPlanningSystemPrompt(FIXED);
    expect(out).toContain("[Available Tools]");
    expect(out).toContain("- time_now: current time");
    expect(out).toContain("[Output Format]");
    expect(out).toContain("[Constraints]");
    // the user request is appended verbatim at the end
    expect(out.trimEnd().endsWith("what time is it in Tokyo?")).toBe(true);
  });

  it("still carries the [Role] marker the diagnostic model provider keys off of "
    + "(packages/model/src/provider-diagnostic.ts's isDiagnosticPlanningPrompt)", () => {
    const out = buildPlanningSystemPrompt(FIXED);
    expect(out).toContain("[Role]");
  });

  it("appends an optional base prompt after the identity + planning role", () => {
    const out = buildPlanningSystemPrompt({ ...FIXED, basePrompt: "EXTRA BASE PROMPT" });
    expect(out).toContain("EXTRA BASE PROMPT");
    const roleIndex = out.indexOf(SURFACE_ROLES.planning);
    const baseIndex = out.indexOf("EXTRA BASE PROMPT");
    const boundaryIndex = out.indexOf(MUSE_CACHE_BOUNDARY_MARKER);
    expect(baseIndex).toBeGreaterThan(roleIndex);
    expect(baseIndex).toBeLessThan(boundaryIndex);
  });
});
