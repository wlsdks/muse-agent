import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  browsingDocEmbedText,
  browsingQueryEmbedText,
  BROWSING_STORE_SCHEMA_VERSION,
  compareBrowsingVisitsNewestFirst,
  isoToWebkitTime,
  mergeBrowsingVisits,
  readBrowsingStore,
  roundVectorForStore,
  searchBrowsingVisits,
  webkitTimeToIso,
  writeBrowsingStore,
  type BrowsingStore,
  type BrowsingVisit
} from "./browsing-store.js";

const visit = (over: Partial<BrowsingVisit> = {}): BrowsingVisit => ({
  id: over.id ?? "1-abc",
  url: over.url ?? "https://example.com/a",
  title: over.title ?? "A",
  visitedAt: over.visitedAt ?? "2026-05-19T09:00:00.000Z",
  ...(over.embedding ? { embedding: over.embedding } : {})
});

const readTextOrDefault = async (path: string) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
};

describe("webkitTimeToIso — known answer", () => {
  it("converts WebKit-epoch µs to the correct ISO instant", () => {
    // 13390000000000000 µs since 1601 → hand-computed Unix instant.
    expect(webkitTimeToIso(13_390_000_000_000_000)).toBe("2025-04-24T20:26:40.000Z");
  });

  it("round-trips with isoToWebkitTime", () => {
    const micros = 13_390_000_000_000_000;
    expect(isoToWebkitTime(webkitTimeToIso(micros))).toBe(micros);
  });
});

describe("mergeBrowsingVisits", () => {
  it("dedups by id (incoming wins), newest-first, capped", () => {
    const previous = [
      visit({ id: "a", title: "old", visitedAt: "2026-05-18T00:00:00.000Z" }),
      visit({ id: "b", title: "keep", visitedAt: "2026-05-17T00:00:00.000Z" })
    ];
    const incoming = [
      visit({ id: "a", title: "new", visitedAt: "2026-05-18T00:00:00.000Z" }),
      visit({ id: "c", title: "newest", visitedAt: "2026-05-20T00:00:00.000Z" })
    ];
    const merged = mergeBrowsingVisits(previous, incoming, 10);
    expect(merged.map((v) => v.id)).toEqual(["c", "a", "b"]);
    expect(merged.find((v) => v.id === "a")!.title).toBe("new");
  });

  it("slices to the cap keeping the newest", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      visit({ id: `v${i.toString()}`, visitedAt: `2026-05-1${i.toString()}T00:00:00.000Z` })
    );
    const merged = mergeBrowsingVisits(many, [], 2);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.id).toBe("v4");
  });
});

describe("compareBrowsingVisitsNewestFirst", () => {
  it("is antisymmetric for two undated visits", () => {
    const a = visit({ id: "a", visitedAt: "nonsense" });
    const b = visit({ id: "b", visitedAt: "nonsense" });
    expect(Math.sign(compareBrowsingVisitsNewestFirst(a, b))).toBe(-Math.sign(compareBrowsingVisitsNewestFirst(b, a)));
  });
});

describe("searchBrowsingVisits", () => {
  const visits = [
    visit({ id: "1", title: "Rust ownership guide", url: "https://blog.example/rust", visitedAt: "2026-05-20T00:00:00.000Z" }),
    visit({ id: "2", title: "Cooking pasta", url: "https://food.example/pasta", visitedAt: "2026-05-19T00:00:00.000Z" }),
    visit({ id: "3", title: "unrelated", url: "https://x.example/RUST-in-url", visitedAt: "2026-05-18T00:00:00.000Z" })
  ];

  it("matches title OR url, case-insensitive, newest-first", () => {
    const hits = searchBrowsingVisits(visits, "rust", 10);
    expect(hits.map((v) => v.id)).toEqual(["1", "3"]);
  });

  it("returns [] for an empty query", () => {
    expect(searchBrowsingVisits(visits, "   ", 10)).toEqual([]);
  });

  it("respects the limit", () => {
    expect(searchBrowsingVisits(visits, "example", 1)).toHaveLength(1);
  });
});

describe("readBrowsingStore / writeBrowsingStore", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-browsing-"));
    file = join(dir, "browsing.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty store for a missing file", async () => {
    const store = await readBrowsingStore(file);
    expect(store).toEqual({ version: BROWSING_STORE_SCHEMA_VERSION, visits: [], lastVisitTimeCursor: 0 });
  });

  it("round-trips a store and writes mode 0o600", async () => {
    const store: BrowsingStore = {
      version: BROWSING_STORE_SCHEMA_VERSION,
      visits: [visit()],
      lastVisitTimeCursor: 13_390_000_000_000_000
    };
    await writeBrowsingStore(file, store);
    const back = await readBrowsingStore(file);
    expect(back).toEqual(store);
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform !== "win32") expect(mode).toBe(0o600);
  });

  it("drops malformed visits and defaults a missing cursor", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: BROWSING_STORE_SCHEMA_VERSION, visits: [{ id: "ok", url: "https://x", title: "t", visitedAt: "2026-05-19T00:00:00Z" }, { id: 5 }] }),
      "utf8"
    );
    const store = await readBrowsingStore(file);
    expect(store.visits).toHaveLength(1);
    expect(store.lastVisitTimeCursor).toBe(0);
  });

  it("backs up (does not silently discard) a version mismatch", async () => {
    await writeFile(file, JSON.stringify({ version: 999, visits: [visit()] }), "utf8");
    const store = await readBrowsingStore(file);
    expect(store.visits).toEqual([]);
    // The original content survives at a sibling .bak-* path.
    const backup = (await readTextOrDefault(file)) === "";
    expect(backup).toBe(true);
  });

  it("round-trips a visit WITH an embedding (additive, schema stays v1)", async () => {
    const store: BrowsingStore = {
      version: BROWSING_STORE_SCHEMA_VERSION,
      visits: [visit({ embedding: [0.12345, -0.6789, 0.0001] })],
      lastVisitTimeCursor: 0
    };
    await writeBrowsingStore(file, store);
    const back = await readBrowsingStore(file);
    expect(back.visits[0]!.embedding).toEqual([0.12345, -0.6789, 0.0001]);
  });

  it("reads a v1 entry WITHOUT an embedding fine (backward compat), and drops a malformed embedding but keeps the visit", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: BROWSING_STORE_SCHEMA_VERSION,
        visits: [
          { id: "no-embed", url: "https://x", title: "legacy", visitedAt: "2026-05-19T00:00:00Z" },
          { id: "bad-embed", url: "https://y", title: "t", visitedAt: "2026-05-19T00:00:00Z", embedding: [1, "nope", null] }
        ]
      }),
      "utf8"
    );
    const store = await readBrowsingStore(file);
    expect(store.visits).toHaveLength(2);
    expect(store.visits.find((v) => v.id === "no-embed")!.embedding).toBeUndefined();
    // malformed embedding is stripped, the rest of the visit survives (still lexically matchable)
    const bad = store.visits.find((v) => v.id === "bad-embed")!;
    expect(bad).toMatchObject({ id: "bad-embed", title: "t" });
    expect(bad.embedding).toBeUndefined();
  });
});

describe("embedding helpers", () => {
  it("browsingDocEmbedText / browsingQueryEmbedText apply the nomic-v2-moe task prefixes", () => {
    expect(browsingDocEmbedText({ title: "Announcing Rust 1.80" })).toBe("search_document: Announcing Rust 1.80");
    expect(browsingQueryEmbedText("지난주에 본 러스트 블로그")).toBe("search_query: 지난주에 본 러스트 블로그");
  });

  it("roundVectorForStore rounds each component to 5 significant digits", () => {
    expect(roundVectorForStore([0.123456789, -0.000987654, 12.34567])).toEqual([0.12346, -0.00098765, 12.346]);
  });
});
