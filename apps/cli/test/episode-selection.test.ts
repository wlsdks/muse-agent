import { describe, expect, it } from "vitest";

import type { PersistedEpisode } from "@muse/stores";

import { selectPersonaEpisodes } from "../src/episode-selection.js";

function ep(id: string, endedAt: string, importance?: number): PersistedEpisode {
  return {
    id,
    userId: "u1",
    startedAt: endedAt,
    endedAt,
    summary: `summary ${id}`,
    ...(importance !== undefined ? { importance } : {})
  };
}

describe("selectPersonaEpisodes", () => {
  it("returns everything newest-first when under the cap", () => {
    const all = [ep("a", "2026-05-01"), ep("c", "2026-05-03"), ep("b", "2026-05-02")];
    expect(selectPersonaEpisodes(all, 20).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("selects purely by recency when no episode carries importance", () => {
    const all = [ep("old", "2026-05-01"), ep("mid", "2026-05-02"), ep("new", "2026-05-03")];
    expect(selectPersonaEpisodes(all, 2).map((e) => e.id)).toEqual(["new", "mid"]);
  });

  it("rescues a pivotal old episode from a pure-recency cap", () => {
    const all = [
      ep("new1", "2026-05-10", 2),
      ep("new2", "2026-05-09", 1),
      ep("pivotal-old", "2026-05-01", 10)
    ];
    const kept = selectPersonaEpisodes(all, 2).map((e) => e.id);
    expect(kept).toContain("pivotal-old");
    // still displayed newest-first
    expect(kept[0]).toBe("new1");
  });

  it("returns [] for a non-positive cap", () => {
    expect(selectPersonaEpisodes([ep("a", "2026-05-01")], 0)).toEqual([]);
  });

  it("clamps out-of-range importance without throwing", () => {
    const all = [ep("a", "2026-05-03", 999), ep("b", "2026-05-02", -5), ep("c", "2026-05-01", 7)];
    expect(selectPersonaEpisodes(all, 2)).toHaveLength(2);
  });
});
