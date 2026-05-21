import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FEEDS_STORE_SCHEMA_VERSION,
  compareFeedEntriesNewestFirst,
  parseFeedBody,
  readFeedsStore
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
