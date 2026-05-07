import { describe, expect, it } from "vitest";

import {
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
