import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFeedKnowledgeEntries } from "../src/feeds-knowledge-source.js";

describe("readFeedKnowledgeEntries — flatten the persisted feeds store for the corpus", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "muse-feeds-know-")); file = join(dir, "feeds.json"); });
  afterEach(async () => { await rm(dir, { force: true, recursive: true }); });

  const STORE = {
    feeds: [
      {
        entries: [
          { id: "a1", link: "http://x/1", publishedAt: "2026-05-20T08:00:00Z", summary: "old item", title: "Older" },
          { id: "a2", link: "http://x/2", publishedAt: "2026-05-23T08:00:00Z", summary: "fresh item", title: "Newer" }
        ],
        id: "tech",
        name: "Tech News",
        url: "http://x/rss"
      }
    ],
    version: 1
  };

  it("flattens entries with the feed name, newest first", async () => {
    await writeFile(file, JSON.stringify(STORE), "utf8");
    const out = await readFeedKnowledgeEntries(file, 10);
    expect(out.map((e) => e.id)).toEqual(["a2", "a1"]);
    expect(out[0]).toMatchObject({ feedName: "Tech News", summary: "fresh item", title: "Newer" });
  });

  it("honours the limit (keeps the newest)", async () => {
    await writeFile(file, JSON.stringify(STORE), "utf8");
    const out = await readFeedKnowledgeEntries(file, 1);
    expect(out.map((e) => e.id)).toEqual(["a2"]);
  });

  it("is fail-open: a missing file yields [] (never throws into the search path)", async () => {
    expect(await readFeedKnowledgeEntries(join(dir, "nope.json"), 10)).toEqual([]);
  });

  it("is fail-open: malformed JSON / wrong shape yields []", async () => {
    await writeFile(file, "{ not json", "utf8");
    expect(await readFeedKnowledgeEntries(file, 10)).toEqual([]);
    await writeFile(file, JSON.stringify({ feeds: "nope" }), "utf8");
    expect(await readFeedKnowledgeEntries(file, 10)).toEqual([]);
  });
});
