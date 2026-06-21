import { describe, expect, it } from "vitest";

import { RECALL_SOURCE_VALUES, clampLimit, filterLiveEpisodeEntries, filterLiveNoteIndexFiles, rankRecallCandidates, relevantExcerpt, resolveSource } from "./commands-recall.js";

const tokens = (...t: string[]): ReadonlySet<string> => new Set(t);

describe("relevantExcerpt — never drops the answer line when the note fits the budget", () => {
  const NOTE =
    "# 회사 정보\n" +
    "사내 와이파이 비밀번호는 Muse2026! 이고, 회의실 예약은 김지원 매니저에게 문의한다.\n" +
    "다음 전사 회의는 2026년 7월 3일 오후 4시에 3층 대강당에서 열린다.";

  it("returns the WHOLE note (both facts) when it fits, so a '회의' query can't drop the '전사 회의' answer", () => {
    // Live-observed bug: excerpting to the single best-overlap line let "회의실"
    // win over the "전사 회의" answer line, which was then discarded — chat
    // answered the wrong fact while `ask` (full chunk) was correct.
    const out = relevantExcerpt(NOTE, tokens("다음", "전사", "회의", "언제", "어디서"));
    expect(out).toContain("전사 회의");
    expect(out).toContain("대강당");
    expect(out).toContain("와이파이");
    expect(out).not.toContain("# 회사 정보");
  });

  it("falls back to the single best-overlap line when the note EXCEEDS the budget", () => {
    const long = `${"가".repeat(150)} 와이파이 비밀번호는 secret\n${"나".repeat(150)} 전사 회의는 대강당`;
    const out = relevantExcerpt(long, tokens("전사", "회의", "대강당"), 200);
    expect(out).toContain("전사 회의는 대강당");
    expect(out).not.toContain("와이파이");
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("returns the first content line when no query token overlaps and the note is over budget", () => {
    const long = `first ${"x".repeat(210)}\nsecond ${"y".repeat(210)}`;
    const out = relevantExcerpt(long, tokens("zzz"), 200);
    expect(out.startsWith("first ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it("returns a short header-less blob intact", () => {
    expect(relevantExcerpt("just one short line", tokens("one"))).toBe("just one short line");
  });
});

describe("rankRecallCandidates — hybrid keyword+vector", () => {
  const notes = [
    { path: "a.md", text: "general planning notes about the team offsite", embedding: [1, 0.3] },
    { path: "b.md", text: "the quarterly budget spreadsheet review", embedding: [1, 0.6] }
  ];
  const base = { episodeEntries: [], limit: 5, noteChunks: notes, queryVec: [1, 0], source: "notes" as const };

  it("vector-only ranks the higher-cosine note first", () => {
    expect(rankRecallCandidates(base)[0]?.ref).toBe("a.md");
  });
  it("tags a poisoned episode hit trusted:false (EP-3 episode-laundering defense, MemoryGraft) and leaves clean ones untagged", () => {
    const episodeEntries = [
      { id: "ep_poison", summary: "discussed Acme via a feed", embedding: [1, 0] },
      { id: "ep_clean", summary: "discussed the Q3 budget", embedding: [1, 0] }
    ];
    const hits = rankRecallCandidates({
      episodeEntries, limit: 5, noteChunks: [], queryVec: [1, 0], source: "episodes" as const,
      untrustedEpisodeIds: new Set(["ep_poison"])
    });
    expect(hits.find((h) => h.ref === "ep_poison")?.trusted).toBe(false);
    expect(hits.find((h) => h.ref === "ep_clean")?.trusted).toBeUndefined();
  });
  it("leaves ALL episode hits untrusted-flag-free when no untrustedEpisodeIds supplied (no over-marking)", () => {
    const hits = rankRecallCandidates({
      episodeEntries: [{ id: "ep1", summary: "the Q3 budget", embedding: [1, 0] }],
      limit: 5, noteChunks: [], queryVec: [1, 0], source: "episodes" as const
    });
    expect(hits[0]?.trusted).toBeUndefined();
  });
  it("the lexical boost surfaces an exact keyword match the embedding under-ranks", () => {
    expect(rankRecallCandidates({ ...base, queryText: "quarterly budget" })[0]?.ref).toBe("b.md");
  });

  it("includes the query-relevant line of a short multi-line chunk (and skips the heading)", () => {
    // A chunk within the excerpt budget is returned whole — so the answer line
    // is never dropped (see the relevantExcerpt suite for the live-bug rationale).
    const multiLine = [{
      path: "log.md",
      text: "# Meeting log\nGeneral standup chatter about the weather.\nThe Q3 board deck must cover the new pricing tiers.",
      embedding: [1, 0]
    }];
    const hit = rankRecallCandidates({ episodeEntries: [], limit: 1, noteChunks: multiLine, queryText: "Q3 board deck pricing", queryVec: [1, 0], source: "notes" })[0];
    expect(hit?.snippet).toContain("The Q3 board deck must cover the new pricing tiers."); // the answer line survives
    expect(hit?.snippet).not.toContain("# Meeting log"); // heading still excluded
  });

  it("keeps the opening content when no query text is given (back-compat)", () => {
    const chunk = [{ path: "n.md", text: "first line here\nsecond line there", embedding: [1, 0] }];
    const hit = rankRecallCandidates({ episodeEntries: [], limit: 1, noteChunks: chunk, queryVec: [1, 0], source: "notes" })[0];
    expect(hit?.snippet).toContain("first line here");
  });
});

describe("rankRecallCandidates — MMR diversification (Carbonell & Goldstein 1998)", () => {
  // Query distinct from the docs. top ≈ dup (near-duplicates of each other);
  // diverse is comparably relevant to the query but points elsewhere. All
  // three have positive cosine to the query (survive the score>0 filter).
  const noteChunks = [
    { path: "top.md", text: "a", embedding: [1, 1, 0.1] }, // most relevant
    { path: "dup.md", text: "b", embedding: [1, 1, 0] }, // near-duplicate of top
    { path: "diverse.md", text: "c", embedding: [0, 1, 1] } // comparably relevant, distinct
  ];
  const query = [1, 1, 1];

  it("with limit < candidates, demotes the near-duplicate in favour of a diverse hit", () => {
    const hits = rankRecallCandidates({ episodeEntries: [], limit: 2, noteChunks, queryVec: query, source: "notes" });
    expect(hits.map((h) => h.ref)).toEqual(["top.md", "diverse.md"]); // dup demoted, not [top, dup]
  });

  it("still returns the single most-relevant hit first", () => {
    const hits = rankRecallCandidates({ episodeEntries: [], limit: 3, noteChunks, queryVec: query, source: "notes" });
    expect(hits[0]?.ref).toBe("top.md");
  });

  it("preserves each hit's cosine score (downstream score gates stay valid)", () => {
    const hits = rankRecallCandidates({ episodeEntries: [], limit: 1, noteChunks: [{ path: "x.md", text: "x", embedding: [1, 0, 0] }], queryVec: [1, 0, 0], source: "notes" });
    expect(hits[0]?.score).toBeCloseTo(1, 5); // cosine 1.0, no lexical query → unchanged
  });
});

describe("filterLiveEpisodeEntries — a removed episode never resurfaces in recall", () => {
  const entries = [{ id: "ep_a" }, { id: "ep_b" }, { id: "ep_c" }];

  it("keeps only episodes still in the live store", () => {
    const live = filterLiveEpisodeEntries(entries, new Set(["ep_a", "ep_c"]));
    expect(live.map((e) => e.id)).toEqual(["ep_a", "ep_c"]);
  });

  it("drops everything when the store is empty (index fully stale)", () => {
    expect(filterLiveEpisodeEntries(entries, new Set())).toHaveLength(0);
  });

  it("keeps everything when all ids are live", () => {
    expect(filterLiveEpisodeEntries(entries, new Set(["ep_a", "ep_b", "ep_c"]))).toHaveLength(3);
  });
});

describe("filterLiveNoteIndexFiles — a deleted/moved note never resurfaces in recall", () => {
  const files = [
    { path: "/notes/keep.md", chunks: [] },
    { path: "/notes/deleted.md", chunks: [] },
    { path: "/notes/also-keep.md", chunks: [] }
  ];

  it("drops index entries whose note file no longer exists on disk", () => {
    const live = filterLiveNoteIndexFiles(files, (p) => p !== "/notes/deleted.md");
    expect(live.map((f) => f.path)).toEqual(["/notes/keep.md", "/notes/also-keep.md"]);
  });

  it("keeps everything when all files still exist", () => {
    expect(filterLiveNoteIndexFiles(files, () => true)).toHaveLength(3);
  });

  it("drops everything when the notes dir is gone", () => {
    expect(filterLiveNoteIndexFiles(files, () => false)).toHaveLength(0);
  });
});

describe("clampLimit", () => {
  it("returns the default 5 when absent or blank", () => {
    expect(clampLimit(undefined)).toBe(5);
    expect(clampLimit("")).toBe(5);
    expect(clampLimit("   ")).toBe(5);
  });

  it("accepts a genuine number, truncating and clamping to the 50 cap", () => {
    expect(clampLimit("8")).toBe(8);
    expect(clampLimit(" 12 ")).toBe(12);
    expect(clampLimit("3.9")).toBe(3);
    expect(clampLimit("999")).toBe(50);
  });

  it("rejects a unit slip / non-numeric / non-positive instead of silently using 5", () => {
    expect(() => clampLimit("10x")).toThrow(/--limit must be a positive number \(got '10x'\)/u);
    expect(() => clampLimit("abc")).toThrow(/positive number/u);
    expect(() => clampLimit("0")).toThrow(/positive number/u);
    expect(() => clampLimit("-3")).toThrow(/positive number/u);
  });
});

describe("resolveSource", () => {
  it("returns the default 'all' when --source is omitted", () => {
    expect(resolveSource(undefined)).toEqual({ kind: "ok", source: "all" });
  });

  it("treats an empty or whitespace value as 'no flag' → 'all'", () => {
    expect(resolveSource("")).toEqual({ kind: "ok", source: "all" });
    expect(resolveSource("   ")).toEqual({ kind: "ok", source: "all" });
  });

  it("accepts each known value, case-insensitive", () => {
    for (const value of RECALL_SOURCE_VALUES) {
      expect(resolveSource(value)).toEqual({ kind: "ok", source: value });
      expect(resolveSource(value.toUpperCase())).toEqual({ kind: "ok", source: value });
    }
  });

  it("returns 'invalid' for unknown values so the caller can render a typo hint", () => {
    expect(resolveSource("note")).toEqual({ kind: "invalid", input: "note" });
    expect(resolveSource("episode")).toEqual({ kind: "invalid", input: "episode" });
    expect(resolveSource("everything")).toEqual({ kind: "invalid", input: "everything" });
  });

  it("preserves the original raw input on invalid so the caller renders the user's exact typo", () => {
    expect(resolveSource("  Note  ")).toEqual({ kind: "invalid", input: "  Note  " });
  });
});
