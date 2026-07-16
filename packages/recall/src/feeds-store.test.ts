import { promises as fsPromises } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FEEDS_STORE_SCHEMA_VERSION,
  FEED_BACKFILL_CAP,
  compareFeedEntriesNewestFirst,
  embedFeedEntries,
  feedDocEmbedText,
  feedQueryEmbedText,
  mergeFeedEntries,
  mutateFeedsStore,
  parseFeedBody,
  readFeedsStore,
  writeFeedsStore,
  type FeedEntry
} from "./feeds-store.js";

describe("parseFeedBody — RSS 2.0", () => {
  it("maps channel/item to uniform entries (guid > link > title for id)", () => {
    const body = `<?xml version="1.0"?><rss version="2.0"><channel>
      <title>Site</title>
      <item><title>First</title><link>https://x/1</link><guid>g-1</guid>
        <pubDate>Tue, 19 May 2026 09:00:00 GMT</pubDate><description>One</description></item>
      <item><title>Second</title><link>https://x/2</link><description>Two</description></item>
    </channel></rss>`;
    const entries = parseFeedBody(body);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: "g-1",
      link: "https://x/1",
      publishedAt: "Tue, 19 May 2026 09:00:00 GMT",
      summary: "One",
      title: "First"
    });
    // no guid ⇒ id falls back to link
    expect(entries[1]!.id).toBe("https://x/2");
  });

  it("drops items with neither title nor id", () => {
    const body = `<rss version="2.0"><channel><item><description>orphan</description></item></channel></rss>`;
    expect(parseFeedBody(body)).toEqual([]);
  });
});

describe("parseFeedBody — Atom link rel selection (RFC 4287 §4.2.7.2)", () => {
  it("picks the rel=alternate permalink even when rel=self is listed FIRST", () => {
    const body = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Post</title>
        <id>tag:x,2026:1</id>
        <link rel="self" href="https://x/feed.xml"/>
        <link rel="alternate" href="https://x/post/1"/>
        <link rel="edit" href="https://x/api/1"/>
        <updated>2026-05-19T09:00:00Z</updated>
        <summary>Body</summary>
      </entry>
    </feed>`;
    const [entry] = parseFeedBody(body);
    expect(entry!.link).toBe("https://x/post/1");
    expect(entry!.id).toBe("tag:x,2026:1");
    expect(entry!.publishedAt).toBe("2026-05-19T09:00:00Z");
  });

  it("treats a rel-less link as alternate (the RFC default)", () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>P</title><id>i1</id><link href="https://x/only"/><summary>s</summary></entry>
    </feed>`;
    expect(parseFeedBody(body)[0]!.link).toBe("https://x/only");
  });

  it("falls back to the first href when NO alternate exists (malformed feed, entry not dropped)", () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>P</title><id>i2</id>
        <link rel="self" href="https://x/self.xml"/>
        <link rel="edit" href="https://x/api/2"/>
        <summary>s</summary></entry>
    </feed>`;
    const [entry] = parseFeedBody(body);
    expect(entry!.link).toBe("https://x/self.xml");
  });

  it("prefers <updated> over <published>, and <summary> over <content>", () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>P</title><id>i3</id><link href="https://x/3"/>
        <published>2026-01-01T00:00:00Z</published>
        <updated>2026-05-19T10:00:00Z</updated>
        <summary>the summary</summary>
        <content>the content</content>
      </entry>
    </feed>`;
    const [entry] = parseFeedBody(body);
    expect(entry!.publishedAt).toBe("2026-05-19T10:00:00Z");
    expect(entry!.summary).toBe("the summary");
  });
});

describe("parseFeedBody — robustness", () => {
  it("returns [] for malformed XML, non-feed roots, and empty input", () => {
    expect(parseFeedBody("<rss><channel><item><title>x")).toEqual([]);
    expect(parseFeedBody("<html><body>not a feed</body></html>")).toEqual([]);
    expect(parseFeedBody("")).toEqual([]);
  });

  it("reads element text when fast-xml-parser yields {#text} (title with attributes)", () => {
    const body = `<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title type="html">Hello &amp; Co</title><id>i4</id><link href="https://x/4"/></entry>
    </feed>`;
    const [entry] = parseFeedBody(body);
    expect(entry!.title).toBe("Hello & Co");
  });
});

describe("parseFeedBody — HTML-entity decoding", () => {
  it("decodes HTML named + numeric entities in an RSS title", () => {
    const [entry] = parseFeedBody(
      `<rss version="2.0"><channel><item><title>Apple&#8217;s plan &amp; Google&rsquo;s reply &mdash; news&hellip;</title><guid>g1</guid><link>https://x/a</link></item></channel></rss>`
    );
    expect(entry!.title).toBe("Apple’s plan & Google’s reply — news…");
  });

  it("decodes entities in an Atom title and an &amp;-escaped link query", () => {
    const [entry] = parseFeedBody(
      `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>R&amp;D &mdash; go</title><id>i1</id><link rel="alternate" href="https://x/b?a=1&amp;b=2"/><updated>2026-05-20T00:00:00Z</updated></entry></feed>`
    );
    expect(entry!.title).toBe("R&D — go");
    expect(entry!.link).toBe("https://x/b?a=1&b=2");
  });

  it("still strips a control char a decoded numeric entity introduces (terminal-safety boundary holds)", () => {
    const [entry] = parseFeedBody(
      `<rss version="2.0"><channel><item><title>Safe&#27;&#0;Title</title><guid>g3</guid></item></channel></rss>`
    );
    expect(entry!.title).toBe("SafeTitle");
  });
});

describe("readFeedsStore — tolerant-read normalises each feed's `entries` to an array so `muse feeds list` can't crash on `feed.entries.length` when the on-disk record omits / corrupts the field (older schema, hand-edit, partial-write recovery)", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-feeds-store-test-"));
    file = join(dir, "feeds.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults `entries` to [] when the on-disk feed record has no `entries` field at all (hand-registered feed before the first fetch)", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: FEEDS_STORE_SCHEMA_VERSION, feeds: [{ id: "x", url: "https://x/rss", name: "X" }] })
    );
    const store = await readFeedsStore(file);
    expect(store.feeds).toHaveLength(1);
    expect(store.feeds[0]!.entries).toEqual([]);
    expect(() => store.feeds[0]!.entries.length).not.toThrow();
  });

  it("defaults `entries` to [] when the field is present but not an array (corrupt / migrated record)", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: FEEDS_STORE_SCHEMA_VERSION,
        feeds: [
          { id: "a", url: "https://a/rss", name: "A", entries: null },
          { id: "b", url: "https://b/rss", name: "B", entries: "not-an-array" },
          { id: "c", url: "https://c/rss", name: "C", entries: 42 }
        ]
      })
    );
    const store = await readFeedsStore(file);
    expect(store.feeds.map((f) => f.entries)).toEqual([[], [], []]);
  });

  it("treats a non-array feeds field as an empty store", async () => {
    await writeFile(file, JSON.stringify({ version: FEEDS_STORE_SCHEMA_VERSION, feeds: { corrupt: true } }));
    await expect(readFeedsStore(file)).resolves.toMatchObject({ feeds: [] });
  });

  it("defaults `name` to the feed id when the on-disk record has no `name` field, so `muse feeds list` doesn't print the literal 'undefined'", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: FEEDS_STORE_SCHEMA_VERSION, feeds: [{ id: "namelessfeed", url: "https://n/rss" }] })
    );
    const store = await readFeedsStore(file);
    expect(store.feeds[0]!.name).toBe("namelessfeed");
  });

  it("preserves a well-formed feed verbatim — the normaliser is a no-op when the record is already valid", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: FEEDS_STORE_SCHEMA_VERSION,
        feeds: [{
          id: "ok",
          url: "https://ok/rss",
          name: "Already named",
          lastFetchedAt: "2026-05-21T10:00:00Z",
          entries: [{ id: "e1", title: "T", link: "L", publishedAt: "2026-05-21T09:00:00Z", summary: "S" }]
        }]
      })
    );
    const store = await readFeedsStore(file);
    expect(store.feeds[0]).toEqual({
      id: "ok",
      url: "https://ok/rss",
      name: "Already named",
      lastFetchedAt: "2026-05-21T10:00:00Z",
      entries: [{ id: "e1", title: "T", link: "L", publishedAt: "2026-05-21T09:00:00Z", summary: "S" }]
    });
  });
});

describe("readFeedsStore — version-mismatch backup (DS-20: a schema bump must never silently discard the user's feed list)", () => {
  let dir: string;
  let file: string;

  const mismatchedPayload = {
    version: 999,
    feeds: [{ id: "x", url: "https://x/rss", name: "X", entries: [] }]
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-feeds-store-version-test-"));
    file = join(dir, "feeds.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("still returns the empty default on a version mismatch (existing behavior preserved)", async () => {
    await writeFile(file, JSON.stringify(mismatchedPayload));
    const store = await readFeedsStore(file);
    expect(store).toEqual({ version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] });
  });

  it("preserves the original file's content at a backup path before falling back to empty", async () => {
    const raw = JSON.stringify(mismatchedPayload);
    await writeFile(file, raw);
    await readFeedsStore(file);
    const entries = await readdir(dir);
    const backupName = entries.find((name) => name.startsWith("feeds.json.bak-v999-"));
    expect(backupName).toBeDefined();
    const backedUp = await readFile(join(dir, backupName!), "utf8");
    expect(backedUp).toBe(raw);
    // renamed away, not left mismatched at the canonical path
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("does NOT create a backup when the version matches (regression guard — no behavior change on the healthy path)", async () => {
    await writeFile(file, JSON.stringify({ version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] }));
    await readFeedsStore(file);
    const entries = await readdir(dir);
    expect(entries.some((name) => name.includes(".bak-"))).toBe(false);
    // original file untouched at the canonical path
    await expect(readFile(file, "utf8")).resolves.toContain(FEEDS_STORE_SCHEMA_VERSION.toString());
  });

  it("a backup-rename failure is fail-soft — the read still returns the empty default without throwing", async () => {
    await writeFile(file, JSON.stringify(mismatchedPayload));
    const renameSpy = vi.spyOn(fsPromises, "rename").mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(readFeedsStore(file)).resolves.toEqual({ version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] });
    expect(renameSpy).toHaveBeenCalled();
  });
});

describe("mutateFeedsStore — latest-snapshot commit", () => {
  it("serializes competing read-modify-write callbacks so neither feed is lost", async () => {
    const dir = await mkdtemp(join(tmpdir(), "muse-feeds-mutate-test-"));
    const file = join(dir, "feeds.json");
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    try {
      await writeFeedsStore(file, { version: FEEDS_STORE_SCHEMA_VERSION, feeds: [] });
      const first = mutateFeedsStore(file, async (store) => {
        firstEntered.resolve();
        await releaseFirst.promise;
        return {
          version: store.version,
          feeds: [...store.feeds, { id: "first", url: "https://first/rss", name: "First", entries: [] }]
        };
      });
      await firstEntered.promise;
      const second = mutateFeedsStore(file, (store) => ({
        version: store.version,
        feeds: [...store.feeds, { id: "second", url: "https://second/rss", name: "Second", entries: [] }]
      }));
      releaseFirst.resolve();
      await Promise.all([first, second]);

      expect((await readFeedsStore(file)).feeds.map((feed) => feed.id)).toEqual(["first", "second"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeFeedEntries — embedding carry-forward across refresh (the critical feeds delta)", () => {
  const entry = (id: string, title: string, embedding?: readonly number[]): FeedEntry => ({
    id, title, link: `https://x/${id}`, publishedAt: "2026-05-20T00:00:00Z", summary: `s-${id}`,
    ...(embedding ? { embedding } : {})
  });

  it("PRESERVES the stored embedding when a refresh re-fetches the SAME id with an UNCHANGED title (incoming has none)", () => {
    const prev = [entry("e1", "Rust 2.0 released", [0.1, 0.2, 0.3])];
    const incoming = [entry("e1", "Rust 2.0 released")]; // fresh parse — never carries an embedding
    const merged = mergeFeedEntries(prev, incoming);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.embedding, "carried forward, not wiped by the republish").toEqual([0.1, 0.2, 0.3]);
  });

  it("DROPS the stale embedding when the republished title CHANGED (so backfill re-embeds the new title)", () => {
    const prev = [entry("e1", "Old title", [0.1, 0.2, 0.3])];
    const incoming = [entry("e1", "New corrected title")];
    const merged = mergeFeedEntries(prev, incoming);
    expect(merged[0]!.title, "incoming content wins").toBe("New corrected title");
    expect(merged[0]!.embedding, "title changed ⇒ old title-embedding is stale, dropped").toBeUndefined();
  });

  it("incoming's OWN embedding wins when present (a pre-embedded republish)", () => {
    const prev = [entry("e1", "T", [0.1, 0.2, 0.3])];
    const incoming = [entry("e1", "T", [0.9, 0.9, 0.9])];
    expect(mergeFeedEntries(prev, incoming)[0]!.embedding).toEqual([0.9, 0.9, 0.9]);
  });

  it("a brand-new incoming entry with no embedding is stored unembedded (no false carry-forward)", () => {
    expect(mergeFeedEntries([], [entry("new", "fresh")])[0]!.embedding).toBeUndefined();
  });

  it("repeated same-id/same-title refreshes keep the embedding stable (regression: not wiped on EVERY refresh)", () => {
    let carried: readonly FeedEntry[] = [entry("e1", "Stable headline", [0.5, 0.6, 0.7])];
    for (let i = 0; i < 5; i += 1) {
      carried = mergeFeedEntries(carried, [entry("e1", "Stable headline")]);
    }
    expect(carried[0]!.embedding).toEqual([0.5, 0.6, 0.7]);
  });
});

describe("embedFeedEntries — bounded, fail-soft embed pass", () => {
  const mk = (id: string, embedding?: readonly number[]): FeedEntry => ({
    id, title: `t-${id}`, link: `https://x/${id}`, publishedAt: "2026-05-19T00:00:00Z", summary: "",
    ...(embedding ? { embedding } : {})
  });
  const embed = async (): Promise<readonly number[]> => [1, 2, 3];

  it("embeds all NEW (incoming) entries, and bounds backfill of old ones at the cap", async () => {
    const entries = [mk("new1"), mk("old1"), mk("old2"), mk("old3")];
    const out = await embedFeedEntries(entries, embed, { incomingIds: new Set(["new1"]), backfillCap: 1 });
    expect(out.find((e) => e.id === "new1")!.embedding).toEqual([1, 2, 3]);
    const backfilled = out.filter((e) => e.id.startsWith("old") && e.embedding !== undefined);
    expect(backfilled).toHaveLength(1);
  });

  it("passes the search_document-prefixed TITLE to the embedder", async () => {
    const seen: string[] = [];
    const capture = async (text: string): Promise<readonly number[]> => { seen.push(text); return [0.1]; };
    await embedFeedEntries([mk("a")], capture, { incomingIds: new Set(["a"]) });
    expect(seen).toEqual(["search_document: t-a"]);
  });

  it("rounds each embedding component to 5 significant digits on store", async () => {
    const precise = async (): Promise<readonly number[]> => [0.123456789, 0.987654321];
    const out = await embedFeedEntries([mk("a")], precise, { incomingIds: new Set(["a"]) });
    expect(out[0]!.embedding).toEqual([0.12346, 0.98765]);
  });

  it("skips an entry that already has an embedding (no re-embed)", async () => {
    let calls = 0;
    const counting = async (): Promise<readonly number[]> => { calls += 1; return [9]; };
    const out = await embedFeedEntries([mk("has", [0.5])], counting, { incomingIds: new Set() });
    expect(calls).toBe(0);
    expect(out[0]!.embedding).toEqual([0.5]);
  });

  it("is fail-soft per entry: an embed error keeps the entry without an embedding", async () => {
    const throwing = async (): Promise<readonly number[]> => { throw new Error("boom"); };
    const out = await embedFeedEntries([mk("a")], throwing, { incomingIds: new Set(["a"]) });
    expect(out).toHaveLength(1);
    expect(out[0]!.embedding).toBeUndefined();
  });

  it("defaults backfillCap to FEED_BACKFILL_CAP", () => {
    expect(FEED_BACKFILL_CAP).toBe(200);
  });
});

describe("feed embed prefixes — task-prefixed nomic-embed-text-v2-moe convention", () => {
  it("doc side is search_document:-prefixed on the TITLE", () => {
    expect(feedDocEmbedText({ title: "Rust 2.0 released" })).toBe("search_document: Rust 2.0 released");
  });
  it("query side is search_query:-prefixed (identical string to browsing's, so ONE embed is shared)", () => {
    expect(feedQueryEmbedText("지난주 러스트 소식")).toBe("search_query: 지난주 러스트 소식");
  });
});

describe("readFeedsStore — embedding round-trip + tolerant embedding read", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-feeds-embed-test-"));
    file = join(dir, "feeds.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a valid entry embedding through write → read", async () => {
    await writeFeedsStore(file, {
      version: FEEDS_STORE_SCHEMA_VERSION,
      feeds: [{ id: "f", url: "https://f/rss", name: "F", entries: [
        { id: "e1", title: "T", link: "L", publishedAt: "2026-05-21T09:00:00Z", summary: "S", embedding: [0.1, 0.2, 0.3] }
      ] }]
    });
    const store = await readFeedsStore(file);
    expect(store.feeds[0]!.entries[0]!.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it("strips a MALFORMED embedding without dropping the entry", async () => {
    await writeFile(file, JSON.stringify({
      version: FEEDS_STORE_SCHEMA_VERSION,
      feeds: [{ id: "f", url: "https://f/rss", name: "F", entries: [
        { id: "bad-type", title: "T1", link: "L", publishedAt: "d", summary: "s", embedding: "not-an-array" },
        { id: "empty", title: "T2", link: "L", publishedAt: "d", summary: "s", embedding: [] },
        { id: "nan", title: "T3", link: "L", publishedAt: "d", summary: "s", embedding: [0.1, null] }
      ] }]
    }));
    const store = await readFeedsStore(file);
    const entries = store.feeds[0]!.entries;
    expect(entries).toHaveLength(3); // entries kept
    expect(entries.every((e) => e.embedding === undefined)).toBe(true); // malformed embeddings stripped
    expect(entries.map((e) => e.title)).toEqual(["T1", "T2", "T3"]);
  });
});

describe("compareFeedEntriesNewestFirst — id tiebreaker for entries sharing publishedAt", () => {
  it("ties on publishedAt resolve by id desc — deterministic regardless of input order", () => {
    const sameTime = "2026-05-21T10:00:00Z";
    const entries = [
      { id: "z_first_in_array_but_lex_last", publishedAt: sameTime },
      { id: "a_last_in_array_but_lex_first", publishedAt: sameTime },
      { id: "m_middle", publishedAt: sameTime }
    ];
    const sorted = [...entries].sort(compareFeedEntriesNewestFirst);
    expect(sorted.map((e) => e.id), "id desc puts lexicographically-larger first").toEqual([
      "z_first_in_array_but_lex_last",
      "m_middle",
      "a_last_in_array_but_lex_first"
    ]);
  });

  it("clean distinct timestamps sort newest-first as before (regression pin)", () => {
    const entries = [
      { id: "older", publishedAt: "2026-05-20T08:00:00Z" },
      { id: "newer", publishedAt: "2026-05-20T09:00:00Z" }
    ];
    const sorted = [...entries].sort(compareFeedEntriesNewestFirst);
    expect(sorted.map((e) => e.id)).toEqual(["newer", "older"]);
  });

  it("undated entries sink AFTER dated ones (regression pin); two undated resolve by id desc", () => {
    const entries = [
      { id: "a-undated", publishedAt: "not-a-date" },
      { id: "c-dated", publishedAt: "2026-05-20T10:00:00Z" },
      { id: "b-undated", publishedAt: "garbled" }
    ];
    const sorted = [...entries].sort(compareFeedEntriesNewestFirst);
    expect(sorted.map((e) => e.id), "dated first, then two undated by id desc (b > a)").toEqual(["c-dated", "b-undated", "a-undated"]);
  });
});
