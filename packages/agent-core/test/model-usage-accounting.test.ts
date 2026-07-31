import { describe, expect, it } from "vitest";

import {
  createTerminalModelUsageAccounting,
  observeTerminalModelUsage,
  terminalModelUsage
} from "../src/model-usage-accounting.js";

describe("terminal model usage accounting", () => {
  it("starts unobserved instead of fabricating a recorded zero response", () => {
    const accounting = createTerminalModelUsageAccounting();

    expect(accounting).toEqual({ state: "unobserved" });
    expect(terminalModelUsage(accounting)).toBeUndefined();
  });

  it("sums every supported counter across observed turns", () => {
    const first = observeTerminalModelUsage(createTerminalModelUsageAccounting(), {
      cachedInputTokens: 3,
      inputTokens: 10,
      outputTokens: 4
    });
    const second = observeTerminalModelUsage(first, {
      inputTokens: 6,
      outputTokens: 2,
      reasoningTokens: 5
    });

    expect(terminalModelUsage(second)).toEqual({
      cachedInputTokens: 3,
      inputTokens: 16,
      outputTokens: 6,
      reasoningTokens: 5
    });
  });

  it.each([
    undefined,
    {},
    { inputTokens: -1 },
    { outputTokens: Number.NaN },
    { reasoningTokens: 1.5 }
  ])("marks missing or invalid usage unknown without fabricating zero: %j", (usage) => {
    const accounting = observeTerminalModelUsage(
      createTerminalModelUsageAccounting(),
      usage
    );

    expect(accounting).toEqual({ state: "unknown" });
    expect(terminalModelUsage(accounting)).toBeUndefined();
  });

  it("saturates counters instead of overflowing unsafe integers", () => {
    const first = observeTerminalModelUsage(createTerminalModelUsageAccounting(), {
      inputTokens: Number.MAX_SAFE_INTEGER
    });
    const second = observeTerminalModelUsage(first, { inputTokens: 1 });

    expect(terminalModelUsage(second)?.inputTokens).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("keeps an unknown aggregate unknown after later valid observations", () => {
    const unknown = observeTerminalModelUsage(
      createTerminalModelUsageAccounting(),
      undefined
    );

    expect(observeTerminalModelUsage(unknown, { inputTokens: 10 }))
      .toEqual({ state: "unknown" });
  });
});
