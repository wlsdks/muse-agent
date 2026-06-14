import { describe, expect, it } from "vitest";

import { sufficiencyAdvisory } from "@muse/recall";

const e0 = [1, 0, 0] as const;
const e1 = [0, 1, 0] as const;
const e2 = [0, 0, 1] as const;

const base = {
  answer: "Your meeting is at 3pm [from notes.md].",
  json: false,
  subQueries: ["when is my meeting", "where is my meeting"],
  subQueryVecs: [e0, e1] as readonly (readonly number[])[],
  evidenceVecs: [e0, e2] as readonly (readonly number[])[] // covers "when", not "where"
};

describe("sufficiencyAdvisory (moved into @muse/recall)", () => {
  it("names the uncovered sub-query when evidence covers only the first", () => {
    const line = sufficiencyAdvisory(base);
    expect(line).toBeDefined();
    expect(line).toContain("where is my meeting");
    expect(line).toContain("may be unverified");
  });

  it("stays silent when every part is covered", () => {
    expect(sufficiencyAdvisory({ ...base, evidenceVecs: [e0, e1] })).toBeUndefined();
  });

  it("stays silent on the json / refusal / single-intent gates", () => {
    expect(sufficiencyAdvisory({ ...base, json: true })).toBeUndefined();
    expect(sufficiencyAdvisory({ ...base, answer: "I'm not sure — I couldn't find that in your notes." })).toBeUndefined();
    expect(sufficiencyAdvisory({ ...base, subQueries: ["when is my meeting"], subQueryVecs: [e0] })).toBeUndefined();
  });

  it("fail-opens on a clause/embedding length mismatch (no advisory)", () => {
    expect(sufficiencyAdvisory({ ...base, subQueryVecs: [e0] })).toBeUndefined();
  });
});
