import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createEpisodesMcpServer } from "../src/loopback-episodes.js";
import { writeEpisodes, type PersistedEpisode } from "@muse/stores";

const ep = (id: string, endedAt: string): PersistedEpisode => ({ endedAt, id, startedAt: endedAt, summary: `s-${id}`, topics: [], userId: "stark" });

function tool(file: string, name: string) {
  const found = createEpisodesMcpServer({ file }).tools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), "muse-ep-")), "episodes.json");
}

describe("muse.episode#list — total reflects the real store size, not the post-limit slice", () => {
  it("reports total = the full scoped count and shown = the returned count", async () => {
    const file = freshFile();
    await writeEpisodes(file, [ep("a", "2026-06-01T00:00:00Z"), ep("b", "2026-06-02T00:00:00Z"), ep("c", "2026-06-03T00:00:00Z")]);
    const out = await tool(file, "list").execute({ limit: 2 }) as { episodes: unknown[]; shown: number; total: number };
    expect(out.episodes).toHaveLength(2); // the limit is honored
    expect(out.shown).toBe(2); // the post-slice (returned) count
    expect(out.total).toBe(3); // the REAL store size — was 2 (the slice length) before the fix
  });

  it("substring search total reflects the full match count, not the post-limit slice", async () => {
    const file = freshFile();
    await writeEpisodes(file, [
      ep("a", "2026-06-01T00:00:00Z"),
      ep("b", "2026-06-02T00:00:00Z"),
      ep("c", "2026-06-03T00:00:00Z")
    ]);
    // every episode's summary contains "s-" → all 3 match the query
    const out = await tool(file, "search").execute({ limit: 2, query: "s-" }) as { episodes: unknown[]; shown: number; total: number };
    expect(out.episodes).toHaveLength(2);
    expect(out.shown).toBe(2);
    expect(out.total).toBe(3); // all 3 matched; total is the pre-slice match count
  });
});
