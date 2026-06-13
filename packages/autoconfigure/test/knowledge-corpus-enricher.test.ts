import type { KnowledgeMatch } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { selectEnricherLine } from "../src/knowledge-corpus.js";

const m = (source: string, cosine: number, text = "some related fact"): KnowledgeMatch => ({ cosine, score: cosine, source, text });

describe("selectEnricherLine — CRAG confidence gate sees the FULL candidate list (margin guard intact)", () => {
  // confidentAt=0.55, soft band → borderline < 0.60, min margin 0.08.
  it("suppresses a near-tie AMBIGUOUS recall (borderline top + flat distribution) — the bug the [top]-only call hid", () => {
    // top 0.57 (borderline, <0.60) with a runner-up 0.56 (margin 0.01 < 0.08) → ambiguous.
    const matches = [m("notes/a.md", 0.57), m("notes/b.md", 0.56)];
    expect(selectEnricherLine(matches, [])).toBeUndefined();
  });

  it("surfaces a CONFIDENT recall with a clear lead (top 0.70 vs runner-up 0.40)", () => {
    const matches = [m("notes/a.md", 0.70, "the office VPN MTU is 1380"), m("notes/b.md", 0.40)];
    expect(selectEnricherLine(matches, [])).toBe("[notes/a.md] the office VPN MTU is 1380");
  });

  it("surfaces a single strong match (no runner-up to be ambiguous against)", () => {
    expect(selectEnricherLine([m("notes/a.md", 0.72, "wifi pw is muse2026")], [])).toBe("[notes/a.md] wifi pw is muse2026");
  });

  it("returns undefined when the top match is below the confident floor", () => {
    expect(selectEnricherLine([m("notes/a.md", 0.50), m("notes/b.md", 0.20)], [])).toBeUndefined();
  });

  it("skips excluded sources and classifies on the remaining candidates", () => {
    // The excluded top would have been a clear lead; after exclusion the real
    // candidates are a near-tie → ambiguous → suppressed.
    const matches = [m("inbox/telegram", 0.9), m("notes/a.md", 0.57), m("notes/b.md", 0.56)];
    expect(selectEnricherLine(matches, ["inbox/"])).toBeUndefined();
  });

  it("returns undefined when every candidate is excluded", () => {
    expect(selectEnricherLine([m("inbox/telegram", 0.9)], ["inbox/"])).toBeUndefined();
  });
});
