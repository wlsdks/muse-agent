import { DefaultToolFilter } from "@muse/agent-core";
import { createWebActionTool } from "@muse/domain-tools";
import { describe, expect, it } from "vitest";

// The REAL web_action tool through the REAL relevance filter. web_action
// is the ONLY agentic web actuator; before this it surfaced for
// submit/book/form but MISSED the equally-common post/rsvp/reserve/apply/
// register verbs, so the local model could never select it for those
// one-shot. Payment verbs (buy/order/checkout/pay) are deliberately NOT
// keywords — payments are out of scope per outbound-safety.
const filter = new DefaultToolFilter();
const tool = createWebActionTool({
  actionLogFile: "/tmp/x",
  approvalGate: () => ({ approved: false }),
  fetchImpl: globalThis.fetch,
  userId: "u"
});

function surfaces(userMessage: string): boolean {
  return filter.filter([tool], { userMessage }).some((t) => t.definition.name === "web_action");
}

describe("web_action surfaces for NATURAL state-changing-web prompts (one-shot selection)", () => {
  it("the previously-covered submit / book / form prompts still surface it", () => {
    expect(surfaces("submit the contact form")).toBe(true);
    expect(surfaces("book a table at 7pm")).toBe(true);
  });

  it("post / rsvp / reserve / apply / register now surface it", () => {
    expect(surfaces("post a comment on the issue")).toBe(true);
    expect(surfaces("rsvp yes to the party invite")).toBe(true);
    expect(surfaces("reserve a table for two")).toBe(true);
    expect(surfaces("apply to the job posting")).toBe(true);
    expect(surfaces("register for the conference")).toBe(true);
  });

  it("an unrelated prompt does NOT surface it (small exposed set per tool-calling.md)", () => {
    expect(surfaces("what is 2 + 2?")).toBe(false);
    expect(surfaces("summarize this article about economics")).toBe(false);
  });
});
