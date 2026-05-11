import { describe, expect, it } from "vitest";
import {
  MUSE_CACHE_BOUNDARY_MARKER,
  InMemoryPromptLayerRegistry,
  buildPlanningSystemPrompt,
  buildPromptContextPacket,
  FullExemplarRetriever,
  InMemoryExemplarRetriever,
  buildLayeredSystemPrompt,
  buildSystemPrompt,
  mergePromptContext,
  parseExemplarMarkdown,
  renderExemplarContext,
  renderJsonInstruction,
  renderRetrievedContext,
  renderToolResults,
  renderYamlInstruction,
  splitPromptCacheBoundary,
  stripPromptCacheBoundary
} from "../src/index.js";

describe("prompt instruction rendering", () => {
  it("renders response format instructions with optional schemas", () => {
    const json = renderJsonInstruction('{"type":"object"}');
    const yaml = renderYamlInstruction();

    expect(json).toContain("[Response Format]");
    expect(json).toContain("valid JSON only");
    expect(json).toContain("Expected JSON schema:");
    expect(yaml).toContain("valid YAML only");
    expect(yaml).not.toContain("Expected YAML structure:");
  });

  it("keeps retrieved context distinct from tool results", () => {
    const retrieved = renderRetrievedContext("Source A: product fact");
    const toolResults = renderToolResults("Tool A: live fact");

    expect(retrieved).toContain("[Retrieved Context]");
    expect(retrieved).toContain("knowledge source");
    expect(retrieved).toContain("Source A: product fact");
    expect(toolResults).toContain("[Tool Results]");
    expect(toolResults).toContain("executed tools");
    expect(toolResults).toContain("Tool A: live fact");
  });

  it("merges context blocks without blank placeholders", () => {
    expect(mergePromptContext(" primary ", " secondary ")).toBe("primary\n\nsecondary");
    expect(mergePromptContext(undefined, " ")).toBeUndefined();
  });
});

describe("system prompt building", () => {
  it("resolves scoped prompt layers deterministically into stable and dynamic sections", () => {
    const registry = new InMemoryPromptLayerRegistry([
      {
        content: "Persona: compare options before choosing.",
        id: "persona-decision",
        personaIds: ["decision-maker"],
        priority: 20,
        section: "stable"
      },
      {
        content: "Template: include tradeoffs and recommendation.",
        id: "template-tradeoffs",
        priority: 10,
        promptTemplateIds: ["tradeoff-template"],
        section: "stable"
      },
      {
        content: "Provider: avoid provider-specific tool assumptions.",
        id: "provider-openai-compatible",
        priority: 5,
        providerIds: ["openai-compatible"],
        section: "dynamic"
      },
      {
        content: "Unrelated",
        id: "persona-unrelated",
        personaIds: ["other"],
        section: "stable"
      }
    ]);
    const layers = registry.resolve({
      personaId: "decision-maker",
      promptTemplateId: "tradeoff-template",
      providerId: "openai-compatible"
    });
    const prompt = buildLayeredSystemPrompt({ includeCacheBoundary: true }, layers);
    const split = splitPromptCacheBoundary(prompt);

    expect(layers.map((layer) => layer.id)).toEqual([
      "provider-openai-compatible",
      "template-tradeoffs",
      "persona-decision"
    ]);
    expect(split?.stablePrefix).toContain("Template: include tradeoffs");
    expect(split?.stablePrefix).toContain("Persona: compare options");
    expect(split?.dynamicSuffix).toContain("Provider: avoid provider-specific");
    expect(prompt).not.toContain("Unrelated");
  });

  it("places stable sections above the cache boundary and dynamic sections below it", () => {
    const prompt = buildSystemPrompt({
      includeCacheBoundary: true,
      providerDynamicSuffix: "provider dynamic",
      providerStablePrefix: "provider stable",
      retrievedContext: "retrieved fact",
      responseFormat: "json"
    });
    const split = splitPromptCacheBoundary(prompt);

    expect(prompt).toContain(MUSE_CACHE_BOUNDARY_MARKER);
    expect(split?.stablePrefix).toContain("provider stable");
    expect(split?.stablePrefix).toContain("[Response Format]");
    expect(split?.dynamicSuffix).toContain("[Retrieved Context]");
    expect(split?.dynamicSuffix).toContain("provider dynamic");
  });

  it("strips cache boundary markers without deleting prompt content", () => {
    const prompt = `stable\n${MUSE_CACHE_BOUNDARY_MARKER}\ndynamic`;

    expect(stripPromptCacheBoundary(prompt)).toBe("stable\ndynamic");
  });

  it("strips ALL occurrences of the boundary marker, not just the first (iter 21)", () => {
    // A buggy producer or a future code path that emits two markers
    // — accidental or otherwise — must not leak the second one to
    // the model. `replaceAll` defends against that.
    const prompt = [
      "stable",
      MUSE_CACHE_BOUNDARY_MARKER,
      "mid",
      MUSE_CACHE_BOUNDARY_MARKER,
      "dynamic"
    ].join("\n");
    expect(stripPromptCacheBoundary(prompt)).not.toContain(MUSE_CACHE_BOUNDARY_MARKER);
  });

  it("builds sanitized context packet values for audit metadata", () => {
    expect(
      buildPromptContextPacket({
        requesterContext: " requester ",
        retrievedContext: " ",
        toolResults: " tool "
      })
    ).toEqual({
      delegatedAgent: undefined,
      requesterContext: "requester",
      retrievedContext: undefined,
      sessionMemoryContext: undefined,
      taskMemoryContext: undefined,
      toolResults: "tool",
      userMemoryContext: undefined
    });
  });
});

describe("buildPlanningSystemPrompt", () => {
  it("includes role, available tools, output format, constraints, and user request sections", () => {
    const result = buildPlanningSystemPrompt({
      toolDescriptions: "- jira_get_issue: Fetch issue\n- confluence_search_by_text: Search docs",
      userPrompt: "Fix the onboarding bug"
    });

    expect(result).toContain("[Role]");
    expect(result).toContain("도구 호출 계획을 세우는 플래너");
    expect(result).toContain("[Available Tools]");
    expect(result).toContain("- jira_get_issue: Fetch issue");
    expect(result).toContain("[Output Format]");
    expect(result).toContain("반드시 JSON 배열만 출력하세요");
    expect(result).toContain("[Constraints]");
    expect(result).toContain("도구가 필요 없으면 빈 배열 []");
    expect(result).toContain("[User Request]");
    expect(result).toContain("Fix the onboarding bug");
  });

  it("orders sections deterministically: Role → Available Tools → Output Format → Constraints → User Request", () => {
    const result = buildPlanningSystemPrompt({
      toolDescriptions: "- a",
      userPrompt: "do thing"
    });
    const expectedOrder = [
      "[Role]",
      "[Available Tools]",
      "[Output Format]",
      "[Constraints]",
      "[User Request]"
    ];
    const positions = expectedOrder.map((section) => result.indexOf(section));
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1] ?? -1);
    }
  });

  it("prepends an optional base prompt before the planning sections", () => {
    const result = buildPlanningSystemPrompt({
      basePrompt: "You are a careful assistant.",
      toolDescriptions: "- a",
      userPrompt: "do thing"
    });
    const baseIndex = result.indexOf("You are a careful assistant.");
    const roleIndex = result.indexOf("[Role]");
    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(baseIndex).toBeLessThan(roleIndex);
  });

  it("omits the base prompt section when an empty string is supplied", () => {
    const result = buildPlanningSystemPrompt({
      basePrompt: "   ",
      toolDescriptions: "- a",
      userPrompt: "do thing"
    });
    expect(result.startsWith("[Role]")).toBe(true);
  });
});

describe("exemplar retrieval", () => {
  const exemplarMarkdown = `
[Answer quality examples]

[Example 1 - Compare options]

<scenario>User asks: "Should we choose hosted search or Postgres search?"</scenario>

<example type="good">
Compare latency, cost, operations, and migration risk before recommending one path.
</example>

[Example 2 - Missing evidence]

<scenario>User asks: "Who approved the private roadmap?"</scenario>

<example type="good">
Say the available sources do not identify an approver, then ask for a source or owner.
</example>

[Example 3 - Tool failure recovery]

<scenario>User asks: "Check the linked pull request status"</scenario>

<example type="good">
Report the successful issue lookup, state the pull request lookup failed, and offer the next retry path.
</example>
`;

  it("parses markdown exemplar blocks with scenario search keys", () => {
    const documents = parseExemplarMarkdown(exemplarMarkdown);

    expect(documents).toHaveLength(3);
    expect(documents[0]).toMatchObject({
      id: "exemplar-1",
      index: 1,
      scenario: 'User asks: "Should we choose hosted search or Postgres search?"',
      title: "[Example 1 - Compare options]"
    });
    expect(documents[0]?.body).toContain("<example type=\"good\">");
  });

  it("retrieves relevant exemplars with pinned examples and deduplication", async () => {
    const retriever = new InMemoryExemplarRetriever(exemplarMarkdown, {
      pinnedIds: ["exemplar-2"],
      topK: 1
    });
    const rendered = await retriever.retrieveTopK("Compare search options before choosing", 1);

    expect(rendered).toContain("[Answer Quality Examples]");
    expect(rendered).toContain("[Example 1 - Compare options]");
    expect(rendered).toContain("[Example 2 - Missing evidence]");
    expect(rendered).not.toContain("[Example 3 - Tool failure recovery]");
    expect(rendered.match(/\[Example 2 - Missing evidence\]/g)).toHaveLength(1);
  });

  it("falls back to full exemplar content when retrieval has no usable match", async () => {
    const fallback = new FullExemplarRetriever("full fallback examples");
    const retriever = new InMemoryExemplarRetriever(exemplarMarkdown, {
      fallback,
      minScore: 3
    });

    await expect(retriever.retrieveTopK("unrelated request", 2)).resolves.toBe("full fallback examples");
  });

  it("renders exemplar context into system prompts without leaking blank sections", () => {
    const prompt = buildSystemPrompt({
      exemplarContext: "Prefer evidence-first comparisons."
    });

    expect(renderExemplarContext(" Prefer evidence-first comparisons. ")).toContain("[Answer Quality Examples]");
    expect(prompt).toContain("[Answer Quality Examples]");
    expect(buildSystemPrompt({ exemplarContext: " " })).not.toContain("[Answer Quality Examples]");
  });
});
