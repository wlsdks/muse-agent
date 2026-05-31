import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readActivityFeed } from "../src/personal-activity-feed.js";

// Drives the merge/sort/window/limit pipeline through the two readers with the
// simplest on-disk formats (pattern + episode). The existing mcp.test.ts cases
// only exercised single-source corrupt-byte robustness, not the cross-source
// composition.
describe("readActivityFeed — merge + instant sort + window + limit + kind", () => {
  let dir: string;
  let patternsFiredFile: string;
  let episodesFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "muse-activity-feed-"));
    patternsFiredFile = join(dir, "patterns.json");
    episodesFile = join(dir, "episodes.json");
    writeFileSync(patternsFiredFile, JSON.stringify({
      fired: [
        { firedAtMs: Date.parse("2026-06-01T10:00:00Z"), patternId: "patA", suggestion: "A" },
        { firedAtMs: Date.parse("2026-06-03T10:00:00Z"), patternId: "patB", suggestion: "B" }
      ]
    }));
    writeFileSync(episodesFile, JSON.stringify({
      episodes: [
        // 18:00+09:00 == 09:00Z — an instant BEFORE patB (10:00Z), but its raw
        // string sorts AFTER patB lexically; proves the sort parses the instant.
        { endedAt: "2026-06-03T18:00:00+09:00", id: "epX", summary: "X" },
        { endedAt: "2026-06-04T00:00:00Z", id: "epY", summary: "Y" }
      ]
    }));
  });
  afterEach(() => { rmSync(dir, { force: true, recursive: true }); });

  it("merges both sources and orders newest-first by PARSED instant, not raw string", () => {
    return readActivityFeed({ episodesFile, patternsFiredFile }).then((feed) => {
      expect(feed.map((e) => e.id)).toEqual(["epY", "patB", "epX", "patA"]);
    });
  });

  it("drops entries older than sinceMs (instant floor)", async () => {
    const feed = await readActivityFeed({ episodesFile, patternsFiredFile, sinceMs: Date.parse("2026-06-03T09:30:00Z") });
    expect(feed.map((e) => e.id)).toEqual(["epY", "patB"]); // epX (09:00Z) + patA dropped
  });

  it("caps the result at `limit` after sorting (the newest N)", async () => {
    const feed = await readActivityFeed({ episodesFile, limit: 2, patternsFiredFile });
    expect(feed.map((e) => e.id)).toEqual(["epY", "patB"]);
  });

  it("restricts to a single source when `kind` is set (other sources excluded)", async () => {
    const feed = await readActivityFeed({ episodesFile, kind: "pattern", patternsFiredFile });
    expect(feed.map((e) => e.id)).toEqual(["patB", "patA"]);
    expect(feed.every((e) => e.kind === "pattern")).toBe(true);
  });
});
