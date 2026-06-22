import { describe, expect, it } from "vitest";

import type { ActionLogEntry } from "@muse/stores";

import { selectGroundingActions } from "./commands-ask.js";

const entry = (id: string, what: string, when: string): ActionLogEntry => ({
  id, userId: "u1", when, what, why: "test", result: "performed"
});

const log: ActionLogEntry[] = [
  entry("a1", "email to sarah@x.io: Q3 budget", "2026-06-01T09:00:00Z"),
  entry("a2", "telegram message to @team: standup moved", "2026-06-02T09:00:00Z"),
  entry("a3", "email to sarah@x.io: Q3 budget", "2026-06-03T09:00:00Z") // a later duplicate-ish
];

describe("selectGroundingActions — transparency grounding ('did you send that?')", () => {
  it("matches actions overlapping the question, newest-first", () => {
    const out = selectGroundingActions(log, "did you email sarah about the budget");
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.every((e) => e.what.includes("sarah"))).toBe(true);
    expect(out[0]?.id).toBe("a3"); // newest matching first
  });

  it("returns [] when nothing overlaps (→ honest refusal) and for an empty query", () => {
    expect(selectGroundingActions(log, "what is the weather tomorrow")).toEqual([]);
    expect(selectGroundingActions(log, "")).toEqual([]);
  });

  it("caps the result to max", () => {
    const many = Array.from({ length: 10 }, (_u, i) => entry(`m${i.toString()}`, `deploy service ${i.toString()}`, `2026-06-0${(i % 9 + 1).toString()}T00:00:00Z`));
    expect(selectGroundingActions(many, "deploy", 3)).toHaveLength(3);
  });
});
