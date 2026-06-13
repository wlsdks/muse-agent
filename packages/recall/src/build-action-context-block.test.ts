import { describe, expect, it } from "vitest";

import { buildActionContextBlock } from "./present.js";

describe("buildActionContextBlock — <<action N>> grounding block", () => {
  it("empty → placeholder", () => {
    expect(buildActionContextBlock([])).toBe("(no matching actions)");
  });

  it("wraps each action with the YYYY-MM-DD date (when.slice(0,10)), what — result, no detail", () => {
    const block = buildActionContextBlock([
      { when: "2026-06-13T17:30:00.000Z", what: "sent reminder", result: "performed" }
    ]);
    expect(block).toBe("<<action 1 — 2026-06-13>>\nsent reminder — performed\n<<end>>");
    // full date, not month-only
    expect(block).not.toContain("2026-06>>");
  });

  it("appends ` (detail)` only when detail is present", () => {
    const withDetail = buildActionContextBlock([
      { when: "2026-06-13T00:00:00.000Z", what: "booked", result: "refused", detail: "no consent" }
    ]);
    expect(withDetail).toContain("booked — refused (no consent)");
    const noDetail = buildActionContextBlock([
      { when: "2026-06-13T00:00:00.000Z", what: "booked", result: "refused" }
    ]);
    expect(noDetail).toContain("booked — refused\n<<end>>");
    expect(noDetail).not.toContain("(");
  });

  it("separates multiple actions with a blank line", () => {
    const block = buildActionContextBlock([
      { when: "2026-06-13T00:00:00.000Z", what: "a", result: "ok" },
      { when: "2026-06-14T00:00:00.000Z", what: "b", result: "ok" }
    ]);
    expect(block).toContain("<<end>>\n\n<<action 2");
  });
});
