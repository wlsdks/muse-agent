import { describe, expect, it } from "vitest";

import { createRecentActionsTool } from "../src/index.js";
import { type ActionLogEntry } from "@muse/mcp";

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

  it("result filter surfaces a matching action even when it is OLDER than the limit window (filter before limit)", async () => {
    // The only refusal is the OLDEST entry — it falls outside a small most-recent limit.
    const entries: ActionLogEntry[] = [
      { id: "old", result: "refused", userId: "u", what: "Declined to email the bank", when: "2026-06-01T00:00:00Z", why: "fail-closed: no consent" },
      { id: "n1", result: "performed", userId: "u", what: "Posted comment A", when: "2026-06-10T00:00:00Z", why: "you asked" },
      { id: "n2", result: "performed", userId: "u", what: "Posted comment B", when: "2026-06-11T00:00:00Z", why: "you asked" },
      { id: "n3", result: "performed", userId: "u", what: "Posted comment C", when: "2026-06-12T00:00:00Z", why: "you asked" }
    ];
    const t = tool(entries);
    // Without a filter, a small limit shows only the recent performed actions — the refusal is missed.
    const noFilter = await t.execute({ limit: 2 }) as { actions: { result: string }[] };
    expect(noFilter.actions.every((a) => a.result === "performed")).toBe(true);
    // Filtering by 'refused' surfaces the OLD refusal despite the same small limit (filter, THEN limit).
    const refused = await t.execute({ limit: 2, result: "refused" }) as { count: number; actions: { what: string; result: string }[] };
    expect(refused.count).toBe(1);
    expect(refused.actions[0]).toMatchObject({ result: "refused", what: "Declined to email the bank" });
  });

  it("an unknown result filter value matches nothing (no silent fall-through to all)", async () => {
    const out = await tool().execute({ result: "bogus" }) as { count: number };
    expect(out.count).toBe(0);
  });
});
