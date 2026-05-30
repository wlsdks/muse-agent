import { describe, expect, it } from "vitest";

import { reflectionsToStore, renderReflections } from "./commands-reflections.js";
import type { StoredReflection } from "@muse/mcp";

describe("renderReflections", () => {
  it("shows the empty state with a refresh hint", () => {
    expect(renderReflections([])).toContain("muse reflections refresh");
  });

  it("lists insights with their grounding sources, newest first", () => {
    const entries: StoredReflection[] = [
      { createdAtMs: 1_000, id: "a", insight: "You wrestle with home networking", sourceIds: ["ep-1", "ep-2"], supportCount: 2 },
      { createdAtMs: 3_000, id: "b", insight: "You prefer concise replies", sourceIds: ["ep-3", "ep-4"], supportCount: 2 }
    ];
    const out = renderReflections(entries);
    expect(out).toContain("You prefer concise replies"); // newest first
    expect(out.indexOf("concise")).toBeLessThan(out.indexOf("home networking"));
    expect(out).toContain("from ep-1, ep-2");
  });
});

describe("reflectionsToStore", () => {
  it("stamps a clock + id and carries the grounding through", () => {
    let n = 0;
    const rows = reflectionsToStore(
      [{ insight: "X", sourceIds: ["e1", "e2"], supportCount: 2 }],
      5_000,
      () => `id-${(++n).toString()}`
    );
    expect(rows).toEqual([{ createdAtMs: 5_000, id: "id-1", insight: "X", sourceIds: ["e1", "e2"], supportCount: 2 }]);
  });
});
