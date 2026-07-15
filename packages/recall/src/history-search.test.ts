import { describe, expect, it } from "vitest";

import { searchHistory, searchHistoryHybrid, type HistoryRecord } from "./history-search.js";

const rec = (ref: string, text: string, source: HistoryRecord["source"] = "episodes", timestampMs?: number): HistoryRecord => ({
  ref,
  source,
  text,
  ...(timestampMs === undefined ? {} : { timestampMs })
});

describe("searchHistory — deterministic lexical history search (Gap1-S1)", () => {
  it("returns the record that shares the query's content terms, ranked first", () => {
    const corpus = [
      rec("s1", "We talked about the VPN MTU setting and dropped packets on the office wifi."),
      rec("s2", "Lunch plans for Friday with the team at the new ramen place."),
      rec("s3", "Reviewed the quarterly budget report and the marketing spend.")
    ];
    const hits = searchHistory("vpn mtu packets", corpus);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.ref).toBe("s1");
    expect(hits[0]!.source).toBe("episodes");
    expect(hits[0]!.score).toBeGreaterThan(0);
  });

  it("returns NO hits when the query shares no content term with any record (precision)", () => {
    const corpus = [
      rec("s1", "Lunch plans for Friday."),
      rec("s2", "The budget report is due Monday.")
    ];
    const hits = searchHistory("submarine telescope", corpus);
    expect(hits).toHaveLength(0);
  });

  it("matches a Korean (CJK) query against a Korean record — CJK tokenization", () => {
    const corpus = [
      rec("k1", "지난주에 분기 보고서 마감 일정에 대해 이야기했어요."),
      rec("k2", "점심은 새로 생긴 라멘 가게에서 먹기로 했습니다."),
      rec("e1", "We discussed the VPN configuration last week.")
    ];
    const hits = searchHistory("분기 보고서", corpus);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.ref).toBe("k1");
  });

  it("builds a snippet centered on the matched terms, not the record start", () => {
    const longText = [
      "Opening unrelated chatter that fills the first window.",
      "More filler about the weather and weekend plans and coffee.",
      "Eventually we got to the IMPORTANT detail: the deploy rollback key is rollback-7788.",
      "Then some closing remarks and goodbyes."
    ].join(" ");
    const hits = searchHistory("rollback key", [rec("s1", longText)], { snippetChars: 80 });
    expect(hits).toHaveLength(1);
    const snippet = hits[0]!.snippet;
    expect(snippet.toLowerCase()).toContain("rollback");
    expect(snippet.length).toBeLessThanOrEqual(120);
    expect(snippet).not.toContain("Opening unrelated chatter");
  });

  it("caps results to topK, keeping the highest-scoring records", () => {
    const corpus = [
      rec("a", "alpha report alpha report alpha"),
      rec("b", "alpha report once"),
      rec("c", "alpha"),
      rec("d", "totally unrelated text here")
    ];
    const hits = searchHistory("alpha report", corpus, { topK: 2 });
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.ref)).toContain("a");
    expect(hits.every((h) => h.ref !== "d")).toBe(true);
  });

  it("breaks score ties by most-recent timestamp (recency tiebreak)", () => {
    const corpus = [
      rec("old", "alpha report", "episodes", 1_000),
      rec("new", "alpha report", "episodes", 9_000)
    ];
    const hits = searchHistory("alpha report", corpus);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.ref).toBe("new");
  });

  it("returns an empty array for an empty query or empty corpus (no crash)", () => {
    expect(searchHistory("", [rec("s1", "anything")])).toHaveLength(0);
    expect(searchHistory("anything", [])).toHaveLength(0);
    expect(searchHistory("   ", [rec("s1", "anything")])).toHaveLength(0);
  });

  it("preserves the per-record source label on each hit, including conversations", () => {
    const corpus = [
      rec("n1", "the vpn mtu note content", "notes"),
      rec("e1", "the vpn session episode content", "episodes"),
      rec("c1", "the vpn mtu conversation turn content", "conversations")
    ];
    const hits = searchHistory("vpn mtu", corpus);
    const bySource = new Map(hits.map((h) => [h.ref, h.source]));
    expect(bySource.get("n1")).toBe("notes");
    expect(bySource.get("e1")).toBe("episodes");
    expect(bySource.get("c1")).toBe("conversations");
  });
});

const erec = (
  ref: string,
  text: string,
  embedding: readonly number[],
  source: HistoryRecord["source"] = "episodes",
  timestampMs?: number
): HistoryRecord => ({ ref, source, text, embedding, ...(timestampMs === undefined ? {} : { timestampMs }) });

describe("searchHistoryHybrid — lexical+cosine RRF fusion (Gap1-S3)", () => {
  it("surfaces a semantically-close record the lexical pass MISSES (the fusion payoff)", () => {
    // The query shares NO content term with p1's wording, but p1's embedding is
    // aligned with the query vector — pure lexical returns nothing, hybrid surfaces it.
    const corpus = [
      erec("p1", "We covered the reimbursement workflow for travel costs.", [1, 0, 0]),
      erec("d1", "Notes about the office plants and the new coffee machine.", [0, 1, 0])
    ];
    const query = "expense claim process";
    const queryVector = [1, 0, 0];

    const lexicalOnly = searchHistory(query, corpus);
    expect(lexicalOnly).toHaveLength(0); // lexical genuinely misses

    const hybrid = searchHistoryHybrid(query, corpus, { queryVector });
    expect(hybrid.length).toBeGreaterThanOrEqual(1);
    expect(hybrid[0]!.ref).toBe("p1");
    expect(hybrid[0]!.score).toBeGreaterThan(0);
  });

  it("does NOT surface a record far in both lexical AND embedding space (precision invariant)", () => {
    const corpus = [
      erec("near", "alpha report budget", [1, 0, 0]),
      erec("far", "totally unrelated kitchen sink", [0, 0, 1])
    ];
    const hybrid = searchHistoryHybrid("alpha report", corpus, { queryVector: [1, 0, 0] });
    expect(hybrid.map((h) => h.ref)).toContain("near");
    expect(hybrid.every((h) => h.ref !== "far")).toBe(true);
  });

  it("respects the minCosine floor — a weakly-similar record below the floor is dropped", () => {
    // weak's cosine to the query is ~0.196 (just under 0.2); it shares no lexical term.
    const corpus = [erec("weak", "unrelated wording entirely", [5, 1, 0])];
    const queryVector = [1, 0, 0]; // cos = 5/sqrt(26) ≈ 0.9806 -> well above; build a real sub-floor case below
    expect(searchHistoryHybrid("zzz", corpus, { queryVector, minCosine: 0.99 })).toHaveLength(0);
    // Above the floor it surfaces:
    expect(searchHistoryHybrid("zzz", corpus, { queryVector, minCosine: 0.9 }).length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to byte-identical lexical search when no queryVector is given", () => {
    const corpus = [
      erec("s1", "vpn mtu packets dropped on wifi", [1, 0, 0]),
      erec("s2", "lunch plans friday", [0, 1, 0])
    ];
    const hybrid = searchHistoryHybrid("vpn mtu", corpus); // no queryVector
    const lexical = searchHistory("vpn mtu", corpus);
    expect(hybrid).toEqual(lexical);
  });

  it("falls back to lexical when the query vector is present but NO record carries an embedding", () => {
    const corpus = [rec("s1", "vpn mtu packets"), rec("s2", "lunch friday")];
    const hybrid = searchHistoryHybrid("vpn mtu", corpus, { queryVector: [1, 0, 0] });
    expect(hybrid).toEqual(searchHistory("vpn mtu", corpus));
  });

  it("fuses BOTH signals — a record strong in lexical AND cosine outranks a single-signal record", () => {
    const corpus = [
      erec("both", "alpha report alpha report alpha", [1, 0, 0]), // top lexical + top cosine
      erec("lexOnly", "alpha report once", [0, 1, 0]), // lexical only
      erec("cosOnly", "unrelated wording", [1, 0, 0]) // cosine only (no shared term)
    ];
    const hits = searchHistoryHybrid("alpha report", corpus, { queryVector: [1, 0, 0] });
    expect(hits[0]!.ref).toBe("both");
  });

  it("caps to topK keeping the highest-fused records", () => {
    const corpus = [
      erec("strong", "alpha report alpha report", [1, 0, 0], "episodes", 1_000),
      erec("mid", "alpha once", [1, 0, 0], "episodes", 9_000),
      erec("weak", "beta note", [0, 1, 0], "episodes", 5_000)
    ];
    const hits = searchHistoryHybrid("alpha report", corpus, { queryVector: [1, 0, 0], topK: 2 });
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.ref !== "weak")).toBe(true);
  });

  it("breaks a genuine fused-score tie toward the more recent record (recency tiebreak)", () => {
    // lexOnly ranks #1 in lexRanking; cosOnly ranks #1 in cosRanking; they share no
    // list, so both get identical RRF score 1/(k+1) — the recency tiebreak decides.
    const corpus = [
      erec("lexOnly", "alpha report", [0, 1, 0], "episodes", 1_000), // top lexical, off-axis embed
      erec("cosOnly", "unrelated wording", [1, 0, 0], "episodes", 9_000) // off-lexical, top cosine
    ];
    const hits = searchHistoryHybrid("alpha report", corpus, { queryVector: [1, 0, 0] });
    expect(hits).toHaveLength(2);
    expect(hits[0]!.score).toBeCloseTo(hits[1]!.score, 12); // genuinely tied fused score
    expect(hits[0]!.ref).toBe("cosOnly"); // newer (9000) wins the tie
  });

  it("returns an empty array when nothing matches either signal", () => {
    const corpus = [erec("s1", "kitchen sink", [0, 0, 1])];
    expect(searchHistoryHybrid("alpha report", corpus, { queryVector: [1, 0, 0] })).toHaveLength(0);
  });
});
