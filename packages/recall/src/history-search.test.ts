import { describe, expect, it } from "vitest";

import { searchHistory, type HistoryRecord } from "./history-search.js";

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

  it("preserves the per-record source label on each hit", () => {
    const corpus = [
      rec("n1", "the vpn mtu note content", "notes"),
      rec("e1", "the vpn session episode content", "episodes")
    ];
    const hits = searchHistory("vpn mtu", corpus);
    const bySource = new Map(hits.map((h) => [h.ref, h.source]));
    expect(bySource.get("n1")).toBe("notes");
    expect(bySource.get("e1")).toBe("episodes");
  });
});
