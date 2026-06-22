import { describe, expect, it } from "vitest";

import { serializeObjective, type StandingObjective } from "../src/personal-objectives-store.js";

const base: StandingObjective = {
  createdAt: "2026-06-01T00:00:00Z",
  id: "o1",
  kind: "watch",
  spec: "watch the build until it goes green",
  status: "active",
  userId: "u"
};

describe("serializeObjective", () => {
  it("serializes exactly the six required fields when no optionals are set", () => {
    expect(Object.keys(serializeObjective(base)).sort()).toEqual([
      "createdAt", "id", "kind", "spec", "status", "userId"
    ]);
  });

  it("includes every optional field when present", () => {
    const out = serializeObjective({
      ...base,
      attempts: 3,
      lastEvaluatedAt: "2026-06-02T00:00:00Z",
      nextEvalAt: "2026-06-03T00:00:00Z",
      resolution: "done"
    });
    expect(out).toMatchObject({ attempts: 3, lastEvaluatedAt: "2026-06-02T00:00:00Z", nextEvalAt: "2026-06-03T00:00:00Z", resolution: "done" });
  });

  it("includes attempts:0 (the !== undefined guard), unlike the truthy-gated optionals", () => {
    // attempts uses `!== undefined`, so a real zero-attempt count must survive —
    // a mutant switching it to a truthy check would silently drop attempts:0,
    // corrupting the backoff state the re-evaluation loop reads back.
    const out = serializeObjective({ ...base, attempts: 0 });
    expect(out).toHaveProperty("attempts", 0);
  });

  it("drops empty-string optionals (resolution / nextEvalAt / lastEvaluatedAt use a truthy gate)", () => {
    const out = serializeObjective({ ...base, lastEvaluatedAt: "", nextEvalAt: "", resolution: "" });
    expect(out).not.toHaveProperty("resolution");
    expect(out).not.toHaveProperty("nextEvalAt");
    expect(out).not.toHaveProperty("lastEvaluatedAt");
  });
});
