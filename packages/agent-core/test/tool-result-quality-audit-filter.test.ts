import { describe, expect, it } from "vitest";

import { createToolResultQualityAuditFilter } from "../src/index.js";
import type { ResponseFilterContext, VerifiedSource } from "../src/types.js";

// The quality-audit filter rewrites a leading apology into a clean summary ONLY
// when a tool ran AND produced a verified source — otherwise a genuine "I can't
// find it" must survive untouched. The runtime-wired happy path is covered in
// agent-runtime.test.ts; here we pin the GATING clauses directly, which the
// integration path can't isolate (its tool path leaves toolsUsed/verifiedSources
// coupled).
const source: VerifiedSource = { title: "WS-1", url: "https://example.atlassian.net/browse/WS-1" };
const apology = "죄송합니다. Jira에서 계정을 확인할 수 없습니다.\n\n결과를 정리합니다.";
const res = (output: string) => ({ id: "r-1", model: "diagnostic/smoke", output });
const ctx = (over: Partial<ResponseFilterContext>): ResponseFilterContext => ({
  input: { messages: [{ content: "내 이슈", role: "user" }], model: "diagnostic/smoke" },
  response: res(""),
  runId: "run-1",
  toolsUsed: ["jira_my_open_issues"],
  verifiedSources: [source],
  ...over
});

describe("createToolResultQualityAuditFilter — apology rewrite is gated on a verified source", () => {
  const filter = createToolResultQualityAuditFilter();

  it("rewrites away the apology lead when a tool ran AND a source was verified", async () => {
    const out = await filter.apply(res(apology), ctx({}));
    expect(out.output).not.toContain("죄송합니다");
    expect(out.output.startsWith("조회한 결과를")).toBe(true);
  });

  it("PRESERVES the apology when NO source was verified (an honest 'can't find it' must not be mangled)", async () => {
    const out = await filter.apply(res(apology), ctx({ verifiedSources: [] }));
    expect(out.output).toContain("죄송합니다");
  });

  it("PRESERVES the apology when no tool ran at all", async () => {
    const out = await filter.apply(res(apology), ctx({ toolsUsed: [], verifiedSources: [source] }));
    expect(out.output).toContain("죄송합니다");
  });

  it("does NOT rewrite when the apology IS the whole answer (nothing follows it) — must not emit an empty '조회한 결과를…' header", async () => {
    // Single paragraph, no `\n\n` body after the apology → `rest` is empty, so
    // the filter must return the response untouched rather than prefix a
    // result-summary lead onto nothing.
    const apologyOnly = "죄송합니다. Jira에서 사용자님의 계정을 확인할 수 없습니다.";
    const out = await filter.apply(res(apologyOnly), ctx({}));
    expect(out.output).toBe(apologyOnly);
  });
});
