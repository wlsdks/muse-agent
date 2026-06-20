import { describe, expect, it } from "vitest";

import { buildFactTimeline } from "../src/commands-memory.js";

const facts = { home_city: "Seoul", role: "engineer" };
const history = [
  { key: "home_city", previousValue: "Busan", replacedAt: new Date("2026-01-01T00:00:00.000Z") },
  { key: "home_city", previousValue: "Daegu", replacedAt: new Date("2026-03-01T00:00:00.000Z") }
];

describe("buildFactTimeline", () => {
  it("traces a changed fact: current value + since + prior values newest-first", () => {
    const [entry] = buildFactTimeline(facts, history, "home_city");
    expect(entry?.key).toBe("home_city");
    expect(entry?.current).toBe("Seoul");
    expect(entry?.since).toBe("2026-03-01T00:00:00.000Z");
    expect(entry?.previous).toEqual([
      { value: "Daegu", until: "2026-03-01T00:00:00.000Z" },
      { value: "Busan", until: "2026-01-01T00:00:00.000Z" }
    ]);
  });

  it("without a key, returns only facts that actually changed", () => {
    const all = buildFactTimeline(facts, history);
    expect(all.map((e) => e.key)).toEqual(["home_city"]);
  });

  it("returns a never-changed key (current only, no history) when explicitly filtered", () => {
    const [entry] = buildFactTimeline(facts, history, "role");
    expect(entry?.current).toBe("engineer");
    expect(entry?.since).toBeUndefined();
    expect(entry?.previous).toEqual([]);
  });

  it("normalises the key filter to match stored keys", () => {
    const [entry] = buildFactTimeline(facts, history, "Home City");
    expect(entry?.key).toBe("home_city");
    expect(entry?.previous).toHaveLength(2);
  });

  it("includes a forgotten fact (history but no current value)", () => {
    const [entry] = buildFactTimeline({}, history, "home_city");
    expect(entry?.current).toBeUndefined();
    expect(entry?.previous).toHaveLength(2);
  });

  it("returns [] when there is no history and no key filter", () => {
    expect(buildFactTimeline(facts, undefined)).toEqual([]);
  });

  it("carries each supersession's kind (refine vs contradict) into previous[]", () => {
    const kinded = [
      { key: "home_city", previousValue: "Seoul", replacedAt: new Date("2026-01-01T00:00:00.000Z"), kind: "refine" as const },
      { key: "home_city", previousValue: "Seoul, Gangnam-gu", replacedAt: new Date("2026-03-01T00:00:00.000Z"), kind: "contradict" as const }
    ];
    const [entry] = buildFactTimeline({ home_city: "Busan" }, kinded, "home_city");
    expect(entry?.previous).toEqual([
      { value: "Seoul, Gangnam-gu", until: "2026-03-01T00:00:00.000Z", kind: "contradict" },
      { value: "Seoul", until: "2026-01-01T00:00:00.000Z", kind: "refine" }
    ]);
  });

  it("leaves kind absent for a legacy (unlabelled) supersession", () => {
    const [entry] = buildFactTimeline(facts, history, "home_city");
    expect(entry?.previous.every((p) => !("kind" in p) || p.kind === undefined)).toBe(true);
  });
});
