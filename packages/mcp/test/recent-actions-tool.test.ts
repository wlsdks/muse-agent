import { describe, expect, it } from "vitest";

import { createRecentActionsTool, type ActionLogEntry } from "../src/index.js";

// Append-ordered (oldest first), as the action log is written.
const ENTRIES: ActionLogEntry[] = [
  { detail: "HTTP 201", id: "a1", result: "performed", userId: "u", what: "Posted a comment on the forum", when: "2026-06-10T10:00:00Z", why: "you asked me to reply YES" },
  { detail: "no recorded consent", id: "a2", result: "refused", userId: "u", what: "Did NOT email the bank", when: "2026-06-11T09:00:00Z", why: "fail-closed: absent consent" },
  { id: "a3", result: "performed", userId: "u", what: "Turned off the living room light", when: "2026-06-12T08:00:00Z", why: "your good-night routine" }
];

function tool(entries: ActionLogEntry[] = ENTRIES) {
  return createRecentActionsTool({ actions: () => entries });
}

describe("createRecentActionsTool — what Muse did on your behalf", () => {
  it("is risk:read and lists actions MOST-RECENT-FIRST with what/why/result/when (value flows)", async () => {
    const t = tool();
    expect(t.definition.risk).toBe("read");
    const out = await t.execute({}) as { count: number; actions: { what: string; result: string; when: string }[] };
    expect(out.count).toBe(3);
    expect(out.actions.map((a) => a.when)).toEqual(["2026-06-12T08:00:00Z", "2026-06-11T09:00:00Z", "2026-06-10T10:00:00Z"]);
    expect(out.actions[0]).toMatchObject({ result: "performed", what: "Turned off the living room light" });
    // Transparency includes what was NOT done — a refusal is surfaced.
    expect(out.actions.some((a) => a.result === "refused")).toBe(true);
  });

  it("respects limit and never leaks internal fields (userId / id / prevHash)", async () => {
    const out = await tool().execute({ limit: 1 }) as { actions: Record<string, unknown>[] };
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]).not.toHaveProperty("userId");
    expect(out.actions[0]).not.toHaveProperty("id");
    expect(out.actions[0]).not.toHaveProperty("prevHash");
  });

  it("an empty action log → count 0", async () => {
    const out = await tool([]).execute({}) as { count: number; actions: unknown[] };
    expect(out.count).toBe(0);
    expect(out.actions).toEqual([]);
  });
});
