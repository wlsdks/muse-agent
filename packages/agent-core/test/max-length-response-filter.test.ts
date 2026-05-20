import type { ModelResponse } from "@muse/model";
import { describe, expect, it } from "vitest";

import { createMaxLengthResponseFilter } from "../src/response-filters.js";

function res(output: string): ModelResponse {
  return { id: "r", model: "m", output, raw: {} } satisfies ModelResponse;
}

describe("createMaxLengthResponseFilter — astral-safe truncation", () => {
  it("returns the response unchanged when output fits the cap", () => {
    const filter = createMaxLengthResponseFilter({ maxLength: 10 });
    expect(filter.apply(res("hi")).output).toBe("hi");
  });

  it("is a no-op when maxLength is unset or 0", () => {
    const off = createMaxLengthResponseFilter();
    expect(off.apply(res("hi")).output).toBe("hi");
    const zero = createMaxLengthResponseFilter({ maxLength: 0 });
    expect(zero.apply(res("hi")).output).toBe("hi");
  });

  it("truncates plain ASCII at the documented boundary + appends the [Response truncated] tail", () => {
    const filter = createMaxLengthResponseFilter({ maxLength: 3 });
    expect(filter.apply(res("abcdef")).output).toBe("abc\n\n[Response truncated]");
  });

  it("drops a lone high surrogate when the cap lands inside a surrogate pair (goal-451 sibling)", () => {
    // "😀" is U+1F600, a surrogate pair: high \uD83D, low \uDE00.
    // With maxLength=3 over "ab😀cd", slice(0, 3) = "ab\uD83D"
    // (a stray high surrogate). The filter must drop it so the
    // emitted body is "ab\n\n[Response truncated]", not
    // "ab\uD83D\n\n[Response truncated]" (invalid UTF-8 downstream).
    const filter = createMaxLengthResponseFilter({ maxLength: 3 });
    const out = filter.apply(res("ab😀cd")).output;
    // No lone high surrogate at the head/tail boundary.
    expect(out.charCodeAt(2)).not.toSatisfy((c: number) => c >= 0xd800 && c <= 0xdbff);
    // The surrogate-stripped head is "ab"; the tail is the marker.
    expect(out).toBe("ab\n\n[Response truncated]");
  });

  it("preserves an emoji fully inside the head (not over-trimmed)", () => {
    // "😀xxxxx" with maxLength=4 → slice(0,4)="😀xx" (the pair is at
    // indices 0+1; index 3 is 'x'). No surrogate at the boundary.
    const filter = createMaxLengthResponseFilter({ maxLength: 4 });
    expect(filter.apply(res("😀xxxxx")).output).toBe("😀xx\n\n[Response truncated]");
  });
});
