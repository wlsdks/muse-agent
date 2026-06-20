import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Command } from "commander";
import { describe, expect, it } from "vitest";

import { DEFAULT_FEED_FETCH_TIMEOUT_MS, DEFAULT_FEED_MAX_BODY_BYTES, formatFeedEntryLines, loadFeedBody, parseFeedSearchLimit, registerFeedsCommand, searchFeedEntries, slugifyUrl, type FeedSearchHit } from "./commands-feeds.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

function hasTerminalControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c <= 0x08 || (c >= 0x0b && c <= 0x1f) || c === 0x7f) return true;
  }
  return false;
}

describe("formatFeedEntryLines (sibling — feeds)", () => {
  it("strips terminal control sequences from third-party feed fields", () => {
    const lines = formatFeedEntryLines({
      feedId: "news",
      title: `${ESC}[2J${ESC}]0;pwned${BEL}Breaking: hostile feed`,
      link: `https://x.example/${ESC}[31m`,
      publishedAt: "2026-05-18"
    });
    const joined = lines.join("\n");
    expect(hasTerminalControl(joined)).toBe(false);
    expect(joined).toContain("Breaking: hostile feed");
    expect(joined).toContain("[news]");
    expect(joined).toContain("2026-05-18");
  });

  it("collapses newlines and falls back to (no date)", () => {
    const lines = formatFeedEntryLines({
      feedId: "f1",
      title: "multi\nline\ntitle",
      link: "",
      publishedAt: "   "
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("[f1] multi line title — (no date)");
  });

  it("leaves a clean entry untouched (no regression)", () => {
    expect(formatFeedEntryLines({
      feedId: "hn",
      title: "Show HN: a thing",
      link: "https://news.example/1",
      publishedAt: "2026-05-18T09:00:00Z"
    })).toEqual([
      "[hn] Show HN: a thing — 2026-05-18T09:00:00Z",
      "  https://news.example/1"
    ]);
  });
});

describe("slugifyUrl", () => {
  it("strips the http(s) / file scheme prefix", () => {
    expect(slugifyUrl("https://example.com/feed.xml")).toBe("example.com-feed.xml");
    expect(slugifyUrl("http://example.com/rss")).toBe("example.com-rss");
    expect(slugifyUrl("file:///tmp/local.atom")).toBe("tmp-local.atom");
  });

  it("collapses runs of non [A-Za-z0-9._-] into a single dash", () => {
    expect(slugifyUrl("https://news.example.com/a//b???c")).toBe("news.example.com-a-b-c");
  });

  it("trims leading/trailing dashes left by sanitisation", () => {
    expect(slugifyUrl("https://example.com/?q=1")).toBe("example.com-q-1");
    expect(slugifyUrl("https://%%%/")).toBe("feed");
  });

  it("caps the slug at 60 chars", () => {
    const long = `https://example.com/${"path/".repeat(40)}`;
    expect(slugifyUrl(long).length).toBeLessThanOrEqual(60);
  });

  it("falls back to 'feed' when stripping leaves nothing", () => {
    expect(slugifyUrl("https://")).toBe("feed");
    expect(slugifyUrl("file://")).toBe("feed");
    expect(slugifyUrl("")).toBe("feed");
  });

  it("preserves a clean host+path verbatim (dots/dashes/underscores kept)", () => {
    expect(slugifyUrl("https://my-blog.example.org/feeds_main.rss"))
      .toBe("my-blog.example.org-feeds_main.rss");
  });
});

async function runFeedsCommand(
  args: readonly string[],
  feedsFile: string
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const io = {
    stdout: (msg: string) => stdoutChunks.push(msg),
    stderr: (msg: string) => stderrChunks.push(msg)
  };
  const previous = process.env.MUSE_FEEDS_FILE;
  const previousExit = process.exitCode;
  process.env.MUSE_FEEDS_FILE = feedsFile;
  process.exitCode = 0;
  try {
    const program = new Command();
    registerFeedsCommand(program, io);
    await program.parseAsync(["node", "muse", "feeds", ...args]);
  } finally {
    if (previous === undefined) delete process.env.MUSE_FEEDS_FILE;
    else process.env.MUSE_FEEDS_FILE = previous;
  }
  const exitCode = process.exitCode;
  process.exitCode = previousExit;
  return { exitCode, stderr: stderrChunks.join(""), stdout: stdoutChunks.join("") };
}

function seedFeeds(ids: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-feeds-typo-"));
  const file = join(dir, "feeds.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      feeds: ids.map((id) => ({
        id,
        url: `https://example.com/${id}.xml`,
        name: id,
        lastFetchedAt: "2026-05-15T00:00:00Z",
        entries: []
      }))
    }),
    "utf8"
  );
  return file;
}

const RSS_FIXTURE = `<?xml version="1.0"?><rss version="2.0"><channel><title>Fix</title>
<item><title>Hello</title><link>https://x.example/1</link><guid>g1</guid><pubDate>2026-05-20T00:00:00Z</pubDate></item>
</channel></rss>`;

/**
 * Seed feeds whose URLs are deterministic `file://` paths — a real
 * fixture for `good: true`, a non-existent path for `good: false` (so
 * loadFeedBody's readFile rejects and refreshSingleFeed reports a
 * failure). Offline + deterministic: no network, unlike the
 * https://example.com seed above.
 */
function seedFileFeeds(specs: readonly { readonly id: string; readonly good: boolean }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-feeds-refresh-"));
  const fixture = join(dir, "fixture.xml");
  writeFileSync(fixture, RSS_FIXTURE, "utf8");
  const file = join(dir, "feeds.json");
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      feeds: specs.map(({ id, good }) => ({
        id,
        url: good ? `file://${fixture}` : `file://${join(dir, "does-not-exist.xml")}`,
        name: id,
        lastFetchedAt: "2026-05-15T00:00:00Z",
        entries: []
      }))
    }),
    "utf8"
  );
  return file;
}

describe("muse feeds remove typo hint", () => {
  it("fuzzy-suggests the closest known id when the input mistypes", async () => {
    const file = seedFeeds(["tech_news", "weather", "hn-front"]);
    const { stdout, stderr, exitCode } = await runFeedsCommand(["remove", "tech-news"], file);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("no feed with id 'tech-news'");
    expect(stderr).toContain("did you mean 'tech_news'");
    expect(stderr).toContain("muse feeds list");
  });

  it("omits the 'did you mean' clause when no candidate is close enough", async () => {
    const file = seedFeeds(["tech_news", "weather"]);
    const { stderr, exitCode } = await runFeedsCommand(["remove", "zzzzz"], file);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no feed with id 'zzzzz'");
    expect(stderr).not.toContain("did you mean");
  });

  it("removes the feed cleanly on an exact match (no hint path)", async () => {
    const file = seedFeeds(["tech_news", "weather"]);
    const { stdout, stderr, exitCode } = await runFeedsCommand(["remove", "weather"], file);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Removed feed 'weather'");
  });
});

describe("muse feeds refresh --id typo hint", () => {
  it("fuzzy-suggests the closest known id when --id mistypes", async () => {
    const file = seedFeeds(["tech_news", "weather"]);
    const { stderr, exitCode } = await runFeedsCommand(["refresh", "--id", "weater"], file);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no feed with id 'weater'");
    expect(stderr).toContain("did you mean 'weather'");
  });

  it("--id with whitespace padding routes through the trimmed match (no silent '(no feeds to refresh)' after passing the exists-check)", async () => {
    // file:// fixture → deterministic offline success (the old
    // https://example.com seed made a real network call that could hang
    // past the test timeout — the known flake).
    const file = seedFileFeeds([{ good: true, id: "weather" }]);
    const { stdout } = await runFeedsCommand(["refresh", "--id", "  weather  "], file);
    expect(stdout, "padded --id must reach refreshSingleFeed and produce a real refresh output, not the empty-target silent no-op").not.toContain("(no feeds to refresh)");
    expect(stdout).toContain("Refreshed 1 feed(s)");
  });
});

describe("muse feeds refresh — the summary count reflects feeds actually re-fetched, not attempted", () => {
  it("a fully-failed refresh reports 0-of-N + exits non-zero (not a misleading 'Refreshed N feed(s)')", async () => {
    const file = seedFileFeeds([{ good: false, id: "down" }]);
    const { stdout, stderr, exitCode } = await runFeedsCommand(["refresh"], file);
    expect(stdout).toContain("Refreshed 0 of 1 feed(s) (1 failed");
    expect(stdout).not.toContain("Refreshed 1 feed(s)");
    expect(stderr).toContain("down:"); // the per-feed failure line
    expect(exitCode).toBe(1);
  });

  it("a partial failure reports the honest count and stays exit 0 (fail-soft)", async () => {
    const file = seedFileFeeds([
      { good: true, id: "ok-feed" },
      { good: false, id: "down-feed" }
    ]);
    const { stdout, exitCode } = await runFeedsCommand(["refresh"], file);
    expect(stdout).toContain("Refreshed 1 of 2 feed(s) (1 failed");
    expect(exitCode).toBe(0);
  });

  it("an all-success refresh keeps the plain 'Refreshed N feed(s)' message", async () => {
    const file = seedFileFeeds([
      { good: true, id: "a" },
      { good: true, id: "b" }
    ]);
    const { stdout, exitCode } = await runFeedsCommand(["refresh"], file);
    expect(stdout).toContain("Refreshed 2 feed(s)");
    expect(stdout).not.toContain("of 2");
    expect(exitCode).toBe(0);
  });
});

describe("muse feeds add --id empty / whitespace fallback", () => {
  function seedEmptyStore(): string {
    const dir = mkdtempSync(join(tmpdir(), "muse-feeds-add-"));
    const file = join(dir, "feeds.json");
    writeFileSync(file, JSON.stringify({ version: 1, feeds: [] }), "utf8");
    return file;
  }

  function writeFeedXml(): string {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><item><title>t</title><link>http://example.com/x</link></item></channel></rss>`;
    const dir = mkdtempSync(join(tmpdir(), "muse-feed-body-"));
    const path = join(dir, "feed.xml");
    writeFileSync(path, xml, "utf8");
    return path;
  }

  it("falls back to the slugified URL when --id is whitespace-only (no empty-id feeds in the store)", async () => {
    const store = seedEmptyStore();
    const body = writeFeedXml();
    const url = `file://${body}`;
    const { exitCode } = await runFeedsCommand(["add", url, "--id", "   "], store);
    expect(exitCode).toBe(0);
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).not.toMatch(/^\s\t/u);
    expect(stdout).toContain(slugifyUrl(url));
  });

  it("uses --id verbatim (trimmed) when non-empty", async () => {
    const store = seedEmptyStore();
    const body = writeFeedXml();
    const { exitCode } = await runFeedsCommand(["add", `file://${body}`, "--id", "  custom-alias  "], store);
    expect(exitCode).toBe(0);
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).toContain("custom-alias");
  });

  it("rejects a whitespace-only URL with an actionable error instead of a confusing fetch failure", async () => {
    const store = seedEmptyStore();
    const { stderr, exitCode } = await runFeedsCommand(["add", "   "], store);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("muse feeds add: feed URL must be non-empty");
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).toContain("(no feeds");
  });

  it("rejects a URL with no valid scheme upfront — surfaces the contract (http(s):// or file://) instead of fetch()'s generic Invalid URL", async () => {
    const store = seedEmptyStore();
    // `not-a-url` — pre-fix this fell through to `loadFeedBody` and
    // tripped `fetch()`'s internals with `initial fetch failed:
    // Invalid URL`. Post-fix the upfront scheme gate names the
    // actual problem.
    const { stderr, exitCode } = await runFeedsCommand(["add", "not-a-url"], store);
    expect(exitCode).toBe(1);
    expect(
      stderr,
      "the error must name the http:// / file:// contract, not the downstream fetch failure"
    ).toContain("URL must start with http://, https://, or file://");
    expect(stderr).toContain("'not-a-url'");
    expect(stderr, "fetch's generic error must not leak through anymore").not.toContain("initial fetch failed");

    // Sibling: `ftp://` is also rejected — only the documented
    // three schemes are supported.
    const ftp = await runFeedsCommand(["add", "ftp://example.com/feed"], store);
    expect(ftp.exitCode).toBe(1);
    expect(ftp.stderr).toContain("URL must start with http://, https://, or file://");

    // Store stays empty — the rejected URL doesn't get persisted.
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).toContain("(no feeds");
  });

  it("trims a padded URL before fetching + persisting so the store doesn't keep extra whitespace", async () => {
    const store = seedEmptyStore();
    const body = writeFeedXml();
    const { exitCode } = await runFeedsCommand(["add", `  file://${body}  `, "--id", "padded"], store);
    expect(exitCode).toBe(0);
    const { stdout } = await runFeedsCommand(["list"], store);
    expect(stdout).toContain("padded");
    expect(stdout).toContain(`file://${body}`);
    expect(stdout).not.toContain(`  file://`);
  });
});

describe("loadFeedBody — fetch timeout so a slow-loris / dead RSS server can't hang `muse feeds refresh` forever", () => {
  it("rejects with a 'timed out after Nms' error when the upstream fetch never resolves before the configured timeout", async () => {
    const neverResolves: typeof globalThis.fetch = (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    await expect(
      loadFeedBody("https://slow.example.com/feed.xml", { fetchImpl: neverResolves, timeoutMs: 10 })
    ).rejects.toThrow(/timed out after 10ms/u);
  });

  it("passes the AbortSignal through to the fetch impl so the upstream connection is actively cancelled, not just abandoned", async () => {
    let receivedSignal: AbortSignal | undefined;
    const captureSignal: typeof globalThis.fetch = (_input, init) => {
      receivedSignal = (init as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise<Response>((_resolve, reject) => {
        receivedSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    await expect(
      loadFeedBody("https://slow.example.com/feed.xml", { fetchImpl: captureSignal, timeoutMs: 5 })
    ).rejects.toThrow(/timed out/u);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns the body and clears the timer on a successful fetch — no leaked timer keeping the event loop alive", async () => {
    const okFetch: typeof globalThis.fetch = () =>
      Promise.resolve(new Response("<rss><channel><item><title>x</title></item></channel></rss>", { status: 200 }));
    const result = await loadFeedBody("https://ok.example.com/feed.xml", { fetchImpl: okFetch, timeoutMs: 5_000 });
    expect(result).toContain("<rss>");
  });

  it("exports a sensible 30-second default so callers that don't pass timeoutMs still inherit the cap", () => {
    expect(DEFAULT_FEED_FETCH_TIMEOUT_MS).toBe(30_000);
  });

  it("retries a transient 503 then succeeds (a feed-server hiccup self-heals within the run)", async () => {
    let calls = 0;
    const flaky: typeof globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(calls === 1
        ? new Response("err", { status: 503 })
        : new Response("<rss><channel><item><title>ok</title></item></channel></rss>", { status: 200 }));
    };
    const result = await loadFeedBody("https://flaky.example.com/feed.xml", { fetchImpl: flaky, sleep: async () => {} });
    expect(calls).toBe(2);
    expect(result).toContain("<rss>");
  });

  it("a persistent 503 throws after exhausting retries; a 404 fails fast (no retry)", async () => {
    let five = 0;
    const always503: typeof globalThis.fetch = () => { five += 1; return Promise.resolve(new Response("e", { status: 503 })); };
    await expect(loadFeedBody("https://down.example.com/feed.xml", { fetchImpl: always503, retries: 2, sleep: async () => {} }))
      .rejects.toThrow("returned 503");
    expect(five).toBe(3); // first + 2 retries

    let four = 0;
    const fourOhFour: typeof globalThis.fetch = () => { four += 1; return Promise.resolve(new Response("nope", { status: 404 })); };
    await expect(loadFeedBody("https://gone.example.com/feed.xml", { fetchImpl: fourOhFour, sleep: async () => {} }))
      .rejects.toThrow("returned 404");
    expect(four).toBe(1); // 4xx is permanent — no retry
  });
});

describe("loadFeedBody — body size cap so a hostile / runaway RSS server can't stream gigabytes into memory before `muse feeds refresh` notices", () => {
  it("rejects upfront when the upstream content-length header advertises a body over the cap — saves the streaming read entirely", async () => {
    const contentLengthLies: typeof globalThis.fetch = () => Promise.resolve(
      new Response(new ReadableStream({ pull(c) { c.close(); } }), {
        status: 200,
        headers: { "content-length": "999999999" }
      })
    );
    await expect(
      loadFeedBody("https://huge.example.com/feed.xml", { fetchImpl: contentLengthLies, maxBodyBytes: 1024 })
    ).rejects.toThrow(/declared 999999999 bytes; cap is 1024/u);
  });

  it("rejects mid-stream when an unknown-length (chunked) body actually exceeds the cap — the per-chunk byte tally aborts the read", async () => {
    const oversizedFetch: typeof globalThis.fetch = () => Promise.resolve(
      new Response(new ReadableStream({
        pull(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(2_000)));
          c.close();
        }
      }), { status: 200 })
    );
    await expect(
      loadFeedBody("https://chunked.example.com/feed.xml", { fetchImpl: oversizedFetch, maxBodyBytes: 100 })
    ).rejects.toThrow(/exceeded 100 bytes/u);
  });

  it("exports a sensible 5-MB default so callers that don't pass maxBodyBytes still inherit the cap", () => {
    expect(DEFAULT_FEED_MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
  });
});

function feedWith(id: string, entries: ReadonlyArray<{ id: string; title: string; summary?: string; publishedAt?: string }>) {
  return {
    id,
    url: `https://example.com/${id}.xml`,
    name: id,
    lastFetchedAt: "2026-05-15T00:00:00Z",
    entries: entries.map((e) => ({
      id: e.id,
      title: e.title,
      link: `https://x.example/${e.id}`,
      publishedAt: e.publishedAt ?? "2026-05-20T00:00:00Z",
      summary: e.summary ?? ""
    }))
  };
}

function seedArchive(feeds: ReturnType<typeof feedWith>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-feeds-search-"));
  const file = join(dir, "feeds.json");
  writeFileSync(file, JSON.stringify({ version: 1, feeds }), "utf8");
  return file;
}

describe("searchFeedEntries — substring search across the cached archive, newest-first", () => {
  const FEEDS = [
    feedWith("tech", [
      { id: "t1", title: "Rust 2.0 released", publishedAt: "2026-05-21T00:00:00Z" },
      { id: "t2", title: "GPU prices fall", summary: "great deal on a graphics card", publishedAt: "2026-05-19T00:00:00Z" }
    ]),
    feedWith("news", [
      { id: "n1", title: "Local election results", publishedAt: "2026-05-22T00:00:00Z" },
      { id: "n2", title: "Weather warning", summary: "RUST belt storms incoming", publishedAt: "2026-05-18T00:00:00Z" }
    ])
  ];

  it("matches title OR summary, case-insensitively, across all feeds", () => {
    const hits = searchFeedEntries(FEEDS, "rust", 20);
    const ids = hits.map((h) => h.id);
    expect(ids).toContain("t1"); // title "Rust 2.0"
    expect(ids).toContain("n2"); // summary "RUST belt"
    expect(ids).not.toContain("t2");
  });

  it("orders newest-first by publishedAt", () => {
    const hits = searchFeedEntries(FEEDS, "e", 20); // broad match
    const dates = hits.map((h) => h.publishedAt);
    const sorted = [...dates].sort((a, b) => b.localeCompare(a));
    expect(dates).toEqual(sorted);
  });

  it("clamps to the limit and returns [] for an empty query", () => {
    expect(searchFeedEntries(FEEDS, "e", 1)).toHaveLength(1);
    expect(searchFeedEntries(FEEDS, "   ", 20)).toEqual([]);
  });

  it("returns a FeedSearchHit carrying feedId + feedName for the listing", () => {
    const hits = searchFeedEntries(FEEDS, "Rust 2.0", 20);
    const hit = hits[0] as FeedSearchHit;
    expect(hit.feedId).toBe("tech");
    expect(hit.feedName).toBe("tech");
  });
});

describe("parseFeedSearchLimit", () => {
  it("defaults when absent, clamps to cap, rejects a unit-slip / non-positive", () => {
    expect(parseFeedSearchLimit(undefined, 20, 100)).toBe(20);
    expect(parseFeedSearchLimit("500", 20, 100)).toBe(100);
    expect(parseFeedSearchLimit("3", 20, 100)).toBe(3);
    expect(() => parseFeedSearchLimit("20x", 20, 100)).toThrow(/positive number/u);
    expect(() => parseFeedSearchLimit("0", 20, 100)).toThrow(/positive number/u);
  });
});

describe("muse feeds search — end-to-end over a seeded archive", () => {
  it("lists matching entries (the archive search `today` can't do), newest-first", async () => {
    const file = seedArchive([
      feedWith("tech", [{ id: "t1", title: "Rust 2.0 released", publishedAt: "2026-05-21T00:00:00Z" }]),
      feedWith("news", [{ id: "n2", title: "Weather", summary: "RUST belt storms", publishedAt: "2026-05-18T00:00:00Z" }])
    ]);
    const { stdout, exitCode } = await runFeedsCommand(["search", "rust"], file);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Rust 2.0 released");
    expect(stdout).toContain("[news]");
    // newest first: tech (05-21) before news (05-18)
    expect(stdout.indexOf("Rust 2.0")).toBeLessThan(stdout.indexOf("[news]"));
  });

  it("prints a clear empty-state when nothing matches", async () => {
    const file = seedArchive([feedWith("tech", [{ id: "t1", title: "Rust 2.0" }])]);
    const { stdout } = await runFeedsCommand(["search", "nonexistentterm"], file);
    expect(stdout).toContain('no cached feed entries match "nonexistentterm"');
  });

  it("--json emits a structured payload", async () => {
    const file = seedArchive([feedWith("tech", [{ id: "t1", title: "Rust 2.0" }])]);
    const { stdout } = await runFeedsCommand(["search", "rust", "--json"], file);
    const payload = JSON.parse(stdout) as { query: string; total: number; entries: FeedSearchHit[] };
    expect(payload.query).toBe("rust");
    expect(payload.total).toBe(1);
    expect(payload.entries[0]!.feedId).toBe("tech");
  });

  it("requires a query and rejects a bad --limit", async () => {
    const file = seedArchive([feedWith("tech", [{ id: "t1", title: "Rust 2.0" }])]);
    const empty = await runFeedsCommand(["search", "   "], file);
    expect(empty.exitCode).toBe(1);
    expect(empty.stderr).toContain("query is required");
    await expect(runFeedsCommand(["search", "rust", "--limit", "5x"], file)).rejects.toThrow(/positive number/u);
  });
});

describe("feeds list — singular entry count", () => {
  function seedOneFeedWithEntries(count: number): string {
    const dir = mkdtempSync(join(tmpdir(), "muse-feeds-plural-"));
    const file = join(dir, "feeds.json");
    const entries = Array.from({ length: count }, (_, i) => ({
      id: `e${i.toString()}`,
      title: `Entry ${i.toString()}`,
      link: `https://example.com/${i.toString()}`,
      publishedAt: "2026-05-15T00:00:00Z",
      summary: ""
    }));
    writeFileSync(
      file,
      JSON.stringify({ version: 1, feeds: [{ id: "solo", url: "https://example.com/solo.xml", name: "solo", entries }] }),
      "utf8"
    );
    return file;
  }

  it("renders '1 entry' (not '1 entries') when a feed has exactly one entry", async () => {
    const { stdout } = await runFeedsCommand(["list"], seedOneFeedWithEntries(1));
    expect(stdout).toContain("1 entry\t");
    expect(stdout).not.toContain("1 entries");
  });

  it("still pluralizes a feed with several entries", async () => {
    const { stdout } = await runFeedsCommand(["list"], seedOneFeedWithEntries(3));
    expect(stdout).toContain("3 entries\t");
  });
});
