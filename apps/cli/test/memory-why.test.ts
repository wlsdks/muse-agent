import { describe, expect, it } from "vitest";

import { formatBeliefWhy } from "../src/commands-memory.js";

describe("formatBeliefWhy", () => {
  it("renders the latest record with evidence + session", () => {
    const out = formatBeliefWhy([
      { kind: "fact", key: "home_city", value: "Seoul", learnedAt: "2026-05-27T00:00:00.000Z", evidenceExcerpt: "I just moved to Seoul", sessionId: "sess-9" }
    ], "home_city");
    expect(out).toContain("fact home_city = Seoul — learned 2026-05-27T00:00:00.000Z");
    expect(out).toContain(`from your message: "I just moved to Seoul"`);
    expect(out).toContain("session sess-9");
  });

  it("uses the newest record (records[0]) and omits optional lines when absent", () => {
    const out = formatBeliefWhy([
      { kind: "preference", key: "tone", value: "concise", learnedAt: "2026-05-27T10:00:00.000Z" },
      { kind: "preference", key: "tone", value: "verbose", learnedAt: "2026-05-01T00:00:00.000Z" }
    ], "tone");
    expect(out).toContain("preference tone = concise");
    expect(out).not.toContain("from your message");
    expect(out).not.toContain("session");
  });

  it("returns a friendly note when there is no provenance", () => {
    const out = formatBeliefWhy([], "mystery");
    expect(out).toContain("no recorded provenance for \"mystery\"");
  });
});
