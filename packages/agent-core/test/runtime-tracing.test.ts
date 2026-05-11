import { describe, expect, it } from "vitest";

import {
  recordContextEngineeringSpanAttributes,
  recordContextWindowSpanAttributes,
  recordUsageSpanAttributes
} from "../src/runtime-helpers.js";

interface RecordedAttribute {
  readonly key: string;
  readonly value: unknown;
}

function fakeSpan(): { readonly recorded: readonly RecordedAttribute[]; setAttribute(key: string, value: unknown): void; end(): void; recordException(error: unknown): void; setStatus(status: { code: "ok" | "error"; description?: string }): void } {
  const recorded: RecordedAttribute[] = [];
  return {
    recorded,
    setAttribute(key, value) {
      recorded.push({ key, value });
    },
    end() {
      // no-op for fake
    },
    recordException() {
      // no-op for fake
    },
    setStatus() {
      // no-op for fake
    }
  };
}

describe("recordContextWindowSpanAttributes", () => {
  it("writes the four context.* attributes when a report is supplied", () => {
    const span = fakeSpan();
    recordContextWindowSpanAttributes(span, {
      budgetTokens: 8_000,
      estimatedTokens: 5_120,
      removedCount: 2,
      summaryInserted: true
    });
    expect(span.recorded).toEqual([
      { key: "context.budget_tokens", value: 8_000 },
      { key: "context.estimated_tokens", value: 5_120 },
      { key: "context.removed_count", value: 2 },
      { key: "context.summary_inserted", value: true }
    ]);
  });

  it("is a no-op when contextWindow is undefined", () => {
    const span = fakeSpan();
    recordContextWindowSpanAttributes(span, undefined);
    expect(span.recorded).toEqual([]);
  });

  it("stamps context.triggered_by when the report carries it (iter 8)", () => {
    const span = fakeSpan();
    recordContextWindowSpanAttributes(span, {
      budgetTokens: 8_000,
      estimatedTokens: 5_120,
      removedCount: 2,
      summaryInserted: true,
      triggeredBy: "working_budget"
    });
    const keys = span.recorded.map((entry) => entry.key);
    expect(keys).toContain("context.triggered_by");
    const triggered = span.recorded.find((entry) => entry.key === "context.triggered_by");
    expect(triggered?.value).toBe("working_budget");
  });
});

describe("recordContextEngineeringSpanAttributes (iter 8)", () => {
  it("surfaces every Phase 1-7 metadata flag the runtime stamps", () => {
    const span = fakeSpan();
    recordContextEngineeringSpanAttributes(span, {
      activeContextApplied: true,
      activeContextInWorkingHours: false,
      attachmentContextApplied: true,
      attachmentContextCount: 3,
      episodicRecallApplied: true,
      episodicRecallMatchCount: 2,
      inboxContextApplied: true,
      inboxContextMessageCount: 5,
      skillsCatalogApplied: true,
      skillsCatalogCount: 4
    });
    const byKey = new Map(span.recorded.map((entry) => [entry.key, entry.value]));
    expect(byKey.get("ctx.active_context_applied")).toBe(true);
    expect(byKey.get("ctx.active_context_in_working_hours")).toBe(false);
    expect(byKey.get("ctx.inbox_context_applied")).toBe(true);
    expect(byKey.get("ctx.inbox_message_count")).toBe(5);
    expect(byKey.get("ctx.episodic_recall_applied")).toBe(true);
    expect(byKey.get("ctx.episodic_match_count")).toBe(2);
    expect(byKey.get("ctx.attachment_context_applied")).toBe(true);
    expect(byKey.get("ctx.attachment_count")).toBe(3);
    expect(byKey.get("ctx.skills_catalog_applied")).toBe(true);
    expect(byKey.get("ctx.skills_catalog_count")).toBe(4);
  });

  it("skips attributes whose underlying flag is missing or wrong-typed", () => {
    const span = fakeSpan();
    recordContextEngineeringSpanAttributes(span, {
      activeContextApplied: true,
      // inboxContextMessageCount missing → no attr
      skillsCatalogCount: "not a number" // wrong type → no attr
    });
    const keys = span.recorded.map((entry) => entry.key);
    expect(keys).toContain("ctx.active_context_applied");
    expect(keys).not.toContain("ctx.inbox_message_count");
    expect(keys).not.toContain("ctx.skills_catalog_count");
  });

  it("is a no-op when metadata is undefined", () => {
    const span = fakeSpan();
    recordContextEngineeringSpanAttributes(span, undefined);
    expect(span.recorded).toEqual([]);
  });

  it("surfaces every transform failure flag (iter 19)", () => {
    const span = fakeSpan();
    recordContextEngineeringSpanAttributes(span, {
      episodicRecallFailed: true,
      inboxContextFailed: true,
      skillsCatalogFailed: true,
      userMemoryFailed: true
    });
    const byKey = new Map(span.recorded.map((entry) => [entry.key, entry.value]));
    expect(byKey.get("ctx.inbox_context_failed")).toBe(true);
    expect(byKey.get("ctx.episodic_recall_failed")).toBe(true);
    expect(byKey.get("ctx.user_memory_failed")).toBe(true);
    expect(byKey.get("ctx.skills_catalog_failed")).toBe(true);
  });

  it("leaves failure attributes absent on a healthy turn (iter 19)", () => {
    const span = fakeSpan();
    recordContextEngineeringSpanAttributes(span, {
      activeContextApplied: true,
      inboxContextApplied: true
    });
    const keys = span.recorded.map((entry) => entry.key);
    expect(keys).not.toContain("ctx.inbox_context_failed");
    expect(keys).not.toContain("ctx.episodic_recall_failed");
    expect(keys).not.toContain("ctx.user_memory_failed");
    expect(keys).not.toContain("ctx.skills_catalog_failed");
  });
});

describe("recordUsageSpanAttributes", () => {
  it("stamps every usage.* attribute the response provides", () => {
    const span = fakeSpan();
    recordUsageSpanAttributes(span, {
      id: "r-1",
      model: "diagnostic/smoke",
      output: "ok",
      usage: { inputTokens: 100, outputTokens: 25, reasoningTokens: 7 }
    });
    expect(span.recorded).toEqual([
      { key: "usage.input_tokens", value: 100 },
      { key: "usage.output_tokens", value: 25 },
      { key: "usage.reasoning_tokens", value: 7 }
    ]);
  });

  it("only stamps the fields the adapter populates", () => {
    const span = fakeSpan();
    recordUsageSpanAttributes(span, {
      id: "r-2",
      model: "diagnostic/smoke",
      output: "ok",
      usage: { outputTokens: 25 }
    });
    expect(span.recorded).toEqual([{ key: "usage.output_tokens", value: 25 }]);
  });

  it("is a no-op when the response carries no usage block", () => {
    const span = fakeSpan();
    recordUsageSpanAttributes(span, { id: "r-3", model: "diagnostic/smoke", output: "ok" });
    expect(span.recorded).toEqual([]);
  });
});
