import { lexicalTokens } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { allUserMemoryFacts, renderMemoryFact, selectMemoryFacts } from "./commands-ask.js";

const memory = {
  facts: { allergy_penicillin: "yes", favorite_color: "blue", apartment_number: "4B" },
  preferences: { language: "en", "veto:tone": "formal", "goal:fitness": "run a 5k" }
};

describe("allUserMemoryFacts — every askable remembered fact (facts + plain prefs, no internal slots)", () => {
  it("includes facts and plain preferences, but NOT the internal veto:/goal: slots", () => {
    const keys = allUserMemoryFacts(memory).map((f) => f.key);
    expect(keys).toContain("allergy_penicillin");
    expect(keys).toContain("favorite_color");
    expect(keys).toContain("language"); // a plain preference is askable
    expect(keys).not.toContain("veto:tone"); // persona machinery, not a fact
    expect(keys).not.toContain("goal:fitness");
  });
});

describe("renderMemoryFact — natural phrasing so the model + judge can read a machine-keyed fact", () => {
  it("underscore-joins the key and DROPS a bare yes/true value (the topic IS the fact)", () => {
    expect(renderMemoryFact({ key: "allergy_penicillin", value: "yes" })).toBe("allergy penicillin");
    expect(renderMemoryFact({ key: "vegetarian", value: "true" })).toBe("vegetarian");
  });
  it("keeps a real value", () => {
    expect(renderMemoryFact({ key: "favorite_color", value: "blue" })).toBe("favorite color: blue");
    expect(renderMemoryFact({ key: "apartment_number", value: "4B" })).toBe("apartment number: 4B");
  });
});

describe("selectMemoryFacts — emphasise the query-relevant remembered facts", () => {
  it("surfaces the fact whose key/value overlaps the question", () => {
    const picked = selectMemoryFacts(memory, lexicalTokens("what is my favorite color"));
    expect(picked.map((f) => f.key)).toContain("favorite_color");
  });
  it("returns nothing for an empty query (no spurious grounding)", () => {
    expect(selectMemoryFacts(memory, new Set())).toEqual([]);
  });
  it("a question that overlaps no remembered fact grounds on nothing", () => {
    expect(selectMemoryFacts(memory, lexicalTokens("what is the capital of france"))).toEqual([]);
  });
});
