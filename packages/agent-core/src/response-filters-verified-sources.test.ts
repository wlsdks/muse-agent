import { describe, expect, it } from "vitest";

import { createVerifiedSourcesResponseFilter } from "./response-filters-verified-sources.js";
import type { ResponseFilterContext } from "./types.js";

const filter = createVerifiedSourcesResponseFilter();

const contextFor = (question: string): ResponseFilterContext => ({
  input: { messages: [{ content: question, role: "user" }], model: "diagnostic" },
  verifiedSources: [{ title: "Example Doc", toolName: "web_search", url: "https://example.com/doc" }]
} as unknown as ResponseFilterContext);

const response = { id: "r1", model: "diagnostic", output: "프로젝트 마감은 다음 주입니다.", raw: {} };

describe("verified-sources block carries untrusted provenance (source-trust segregation)", () => {
  it("KO: the sources heading names the block as tool-fetched external data, not the user's notes", async () => {
    const result = await filter.apply(response, contextFor("마감일 웹에서 찾아줘"));
    expect(result.output).toContain("https://example.com/doc");
    expect(result.output).toContain("출처 (외부 — 도구가 가져온 정보, 내 노트 아님)");
  });

  it("EN: same marker in English", async () => {
    const result = await filter.apply({ ...response, output: "The deadline is next week." }, contextFor("find the deadline on the web"));
    expect(result.output).toContain("Sources (external — tool-fetched, not your own notes)");
  });
});
