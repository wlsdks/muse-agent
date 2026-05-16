import { describe, expect, it } from "vitest";
import {
  MUSE_CACHE_BOUNDARY_MARKER,
  InMemoryPromptLayerRegistry,
  TODAY_BRIEF_SYSTEM_PROMPT,
  buildPlanningSystemPrompt,
  buildPromptContextPacket,
  buildTodayBriefUserMessage,
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

  it("strips ALL occurrences of the boundary marker, not just the first", () => {
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

  it("does not leave a triple-newline artifact when the marker sat between two section gaps", () => {
    // Production-case layout: `buildSystemPrompt({ includeCacheBoundary: true })`
    // joins sections with `\n\n`, so the marker is bounded by two
    // newlines on each side: `STABLE\n\n<marker>\n\nDYNAMIC`.
    //
    // Pre-iter-28, the single-newline replaceAll
    //   `\n<marker>\n` → `\n`
    // consumed exactly ONE newline from each side, yielding
    //   `STABLE\n` + `\n` + `\nDYNAMIC` = `STABLE\n\n\nDYNAMIC`
    // — a triple-newline whitespace leak landing in the model's
    // system prompt at the exact spot the marker used to sit.
    //
    // Iter 28 collapses any 3-or-more newline run that results from
    // marker stripping back to the canonical `\n\n` section gap.
    const prompt = `STABLE\n\n${MUSE_CACHE_BOUNDARY_MARKER}\n\nDYNAMIC`;
    expect(stripPromptCacheBoundary(prompt)).toBe("STABLE\n\nDYNAMIC");
  });

  it("preserves intentional triple-newlines that did not result from marker removal", () => {
    // Negative case for the iter-28 fix: stripping the marker must
    // not collapse `\n\n\n` runs elsewhere in the prompt. The
    // ordered-pattern fix (longest match first) only removes the
    // marker plus its immediate `\n` / `\n\n` border, so any
    // author-supplied multi-newline run stays exactly as written.
    const prompt = `head\n\n\nfoot${MUSE_CACHE_BOUNDARY_MARKER}`;
    expect(stripPromptCacheBoundary(prompt)).toBe("head\n\n\nfoot");
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

describe("today-brief prompt", () => {
  it("mentions every section currently shipped in the briefing JSON so the LLM has priority guidance", () => {
    // Smoke-tests the prompt covers all five sections the today
    // route + composeLocalBriefing emit. Followups joined reminders
    // / tasks / events / notes; this asserts the prompt was kept in
    // sync (a JSON-only addition without prompt awareness would
    // leave the LLM unsure how to weight followups vs reminders).
    const text = TODAY_BRIEF_SYSTEM_PROMPT.toLowerCase();
    expect(text).toContain("reminder");
    expect(text).toContain("followup");
    expect(text).toContain("event");
    expect(text).toContain("task");
    expect(text).toContain("note");
  });

  it("buildTodayBriefUserMessage round-trips the followups field through the JSON payload", () => {
    const briefing = {
      followups: [{ id: "fu_a", scheduledFor: "2026-05-13T09:00:00Z", summary: "Send Q3 memo" }],
      generatedAt: "2026-05-13T08:00:00Z",
      lookaheadHours: 24
    };
    const message = buildTodayBriefUserMessage(briefing);
    expect(message).toContain("\"followups\"");
    expect(message).toContain("Send Q3 memo");
    expect(message).toContain(TODAY_BRIEF_SYSTEM_PROMPT);
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

  it("renders a pinned exemplar that is ALSO a top scorer exactly once (no duplicate few-shot)", async () => {
    const retriever = new InMemoryExemplarRetriever(exemplarMarkdown, {
      pinnedIds: ["exemplar-1"], // pin the same one the query scores highest
      topK: 1
    });
    const rendered = await retriever.retrieveTopK("Compare search options before choosing", 1);

    expect(rendered).toContain("[Example 1 - Compare options]");
    expect(rendered.match(/\[Example 1 - Compare options\]/g)).toHaveLength(1);
  });

  it("disambiguates two exemplars that share a number (bilingual file) instead of collapsing them", async () => {
    const bilingual = `
[Example 1 - English compare]

<scenario>User asks: "Compare the search options"</scenario>

<example type="good">English answer body.</example>

[예시 1 - 한국어 비교]

<scenario>사용자 질문: "검색 옵션을 비교"</scenario>

<example type="good">한국어 답변 본문.</example>
`;
    const docs = parseExemplarMarkdown(bilingual);
    expect(docs).toHaveLength(2);
    // First keeps the stable `exemplar-1` contract; the collision
    // gets a unique id (not silently merged).
    expect(docs[0]?.id).toBe("exemplar-1");
    expect(docs[1]?.id).not.toBe(docs[0]?.id);
    expect(new Set(docs.map((d) => d.id)).size).toBe(2);

    // Both survive id-dedup in the retriever (pre-fix the second was
    // dropped as a duplicate id).
    const retriever = new InMemoryExemplarRetriever(bilingual, { topK: 5 });
    const rendered = await retriever.retrieveTopK("Compare the 검색 옵션을 비교 options", 5);
    expect(rendered).toContain("[Example 1 - English compare]");
    expect(rendered).toContain("[예시 1 - 한국어 비교]");
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
