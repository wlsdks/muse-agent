import { describe, expect, it } from "vitest";

import {
  createConfidenceGatedInvestigator,
  decideProactiveRecall,
  FindingResurfaceSuppressor
} from "./proactive-recall-gate.js";
import type { KnowledgeChunk, KnowledgeMatch } from "./knowledge-recall.js";

const match = (over: Partial<KnowledgeMatch>): KnowledgeMatch => ({
  cosine: 0.8,
  score: 0.8,
  source: "notes/q3.md",
  text: "Q3 budget review is on the 18th; bring the revised forecast.",
  ...over
});

describe("decideProactiveRecall — the CRAG gate for proactive surfacing", () => {
  it("surfaces a cited finding only when confident", () => {
    const d = decideProactiveRecall([match({ cosine: 0.72 })]);
    expect(d.surface).toBe(true);
    expect(d.confidence).toBe("confident");
    expect(d.finding).toContain("[notes/q3.md]");
    expect(d.finding).toContain("Q3 budget review");
  });

  it("relabels + cues a confident finding whose top source is UNTRUSTED (NP-proactive — never launders a poisoned ingested note as 'your notes')", () => {
    const d = decideProactiveRecall([match({ cosine: 0.72, source: "web/evil.md", text: "Acme acquired Beta for $1B.", trusted: false })]);
    expect(d.surface).toBe(true);
    expect(d.finding).toContain("[web/evil.md]");
    expect(d.finding).toContain("external source you saved"); // not "in your notes"
    expect(d.finding).toContain("⚠️"); // scrutiny cue
    expect(d.finding).not.toContain("Related in your notes");
    expect(d.reason).toContain("untrusted");
  });

  it("a confident TRUSTED finding keeps the plain 'in your notes' label (no over-cue)", () => {
    const d = decideProactiveRecall([match({ cosine: 0.72 })]);
    expect(d.finding).toContain("Related in your notes");
    expect(d.finding).not.toContain("⚠️");
    expect(d.finding).not.toContain("external source");
  });

  it("stays SILENT on a weak (ambiguous) recall — never a low-confidence guess", () => {
    const d = decideProactiveRecall([match({ cosine: 0.4 })]);
    expect(d.surface).toBe(false);
    expect(d.confidence).toBe("ambiguous");
    expect(d.finding).toBeUndefined();
    // The reason distinguishes a WEAK recall from no recall at all — a diagnostic
    // the proactive loop logs; the two must not collapse to the same string.
    expect(d.reason).toBe("recall too weak to surface unasked — stay silent");
  });

  it("stays silent on an empty recall", () => {
    const d = decideProactiveRecall([]);
    expect(d).toMatchObject({ confidence: "none", surface: false });
    expect(d.finding).toBeUndefined();
    expect(d.reason).toBe("no matching passages — stay silent"); // distinct from the ambiguous reason
  });

  it("quotes the STRONGEST match and truncates long passages", () => {
    const long = "x".repeat(400);
    const d = decideProactiveRecall(
      [match({ cosine: 0.62, source: "a.md", text: "weaker" }), match({ cosine: 0.9, source: "b.md", text: long })],
      { maxChars: 50 }
    );
    expect(d.finding).toContain("[b.md]");
    expect(d.finding).toContain("…");
    expect(d.finding!.length).toBeLessThan(120);
  });

  it("honours a custom confidence threshold", () => {
    expect(decideProactiveRecall([match({ cosine: 0.5 })], { confidentAt: 0.45 }).surface).toBe(true);
    expect(decideProactiveRecall([match({ cosine: 0.5 })], { confidentAt: 0.6 }).surface).toBe(false);
  });

  it("collapses interior whitespace (newlines/tabs/runs) in the surfaced snippet", () => {
    const d = decideProactiveRecall([match({ text: "a\n\n  b\t\tc" })]);
    expect(d.finding).toBe("📎 Related in your notes — [notes/q3.md] a b c");
  });

  it("honours a custom maxChars; a non-positive maxChars falls back to the default 160", () => {
    const long = "word ".repeat(50); // 250 chars pre-collapse
    const small = decideProactiveRecall([match({ text: long })], { maxChars: 10 });
    expect(small.finding!.endsWith("…")).toBe(true);
    expect(small.finding).toContain("word word"); // truncated near the 10-char bound
    // prefix "📎 Related in your notes — [notes/q3.md] " (~41) + 10-char snippet + "…"
    expect(small.finding!.length).toBeLessThan(60);
    // maxChars 0 / negative is ignored → default 160 (so the finding is much longer)
    expect(decideProactiveRecall([match({ text: long })], { maxChars: 0 }).finding!.length).toBeGreaterThan(150);
    expect(decideProactiveRecall([match({ text: long })], { maxChars: -5 }).finding!.length).toBeGreaterThan(150);
  });

  it("ranks by score when cosine is absent (the strongest score wins the snippet)", () => {
    const d = decideProactiveRecall([
      { score: 0.85, source: "lo.md", text: "LOW" },
      { score: 0.92, source: "hi.md", text: "HIGH" },
    ]);
    expect(d.surface).toBe(true);
    expect(d.finding).toContain("[hi.md]");
    expect(d.finding).toContain("HIGH");
  });
});

describe("createConfidenceGatedInvestigator — investigate seam", () => {
  // A fake embedder: query/chunk map to fixed vectors so cosine is deterministic.
  const vectors: Record<string, readonly number[]> = {
    "Q3 budget review": [1, 0, 0],
    "Q3 budget review is on the 18th; bring the revised forecast.": [1, 0, 0],
    "Dentist appointment": [0, 1, 0],
    "My cat's vaccination schedule for next spring.": [0, 0, 1]
  };
  const embed = async (text: string): Promise<readonly number[]> => vectors[text] ?? [0, 0, 0];
  const chunks: KnowledgeChunk[] = [
    { source: "q3.md", text: "Q3 budget review is on the 18th; bring the revised forecast." },
    { source: "cat.md", text: "My cat's vaccination schedule for next spring." }
  ];

  it("returns a cited finding when the trigger topic IS in the corpus", async () => {
    const investigate = createConfidenceGatedInvestigator({ chunks, embed });
    const finding = await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" });
    expect(finding).toBeDefined();
    expect(finding).toContain("[q3.md]");
  });

  it("returns undefined (silent) when the trigger is off-topic for the corpus", async () => {
    const investigate = createConfidenceGatedInvestigator({ chunks, embed });
    const finding = await investigate({ factSheet: "", kind: "calendar", title: "Dentist appointment" });
    expect(finding).toBeUndefined();
  });

  it("fail-open: empty title / empty corpus / throwing embed → undefined", async () => {
    expect(await createConfidenceGatedInvestigator({ chunks, embed })({ factSheet: "", kind: "task", title: "  " })).toBeUndefined();
    expect(await createConfidenceGatedInvestigator({ chunks: [], embed })({ factSheet: "", kind: "task", title: "x" })).toBeUndefined();
    const boom = createConfidenceGatedInvestigator({ chunks, embed: async () => { throw new Error("down"); } });
    expect(await boom({ factSheet: "", kind: "task", title: "Q3 budget review" })).toBeUndefined();
  });

  it("accepts a LAZY chunks provider (re-read per tick) and surfaces from it", async () => {
    const investigate = createConfidenceGatedInvestigator({ chunks: async () => chunks, embed });
    expect(await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" })).toContain("[q3.md]");
  });

  it("fail-open when the lazy chunks provider THROWS (corpus unreadable → silent, base notice still fires)", async () => {
    const investigate = createConfidenceGatedInvestigator({ chunks: async () => { throw new Error("index locked"); }, embed });
    expect(await investigate({ factSheet: "", kind: "task", title: "Q3 budget review" })).toBeUndefined();
  });
});

describe("FindingResurfaceSuppressor — cooldown + bounded working set", () => {
  const COOLDOWN = 10_000;

  it("suppresses an identical finding within the cooldown window, re-allows it after", () => {
    const s = new FindingResurfaceSuppressor(COOLDOWN);
    expect(s.shouldSurface("📎 same finding", 0)).toBe(true);
    expect(s.shouldSurface("📎 same finding", COOLDOWN - 1)).toBe(false); // within window
    expect(s.shouldSurface("📎 same finding", COOLDOWN + 1)).toBe(true); // window elapsed
  });

  it("bounds the working set: the OLDEST finding is evicted past the cap (long-lived daemon can't leak)", () => {
    // cap=3, a large cooldown so nothing expires by time — only eviction can drop a key.
    const s = new FindingResurfaceSuppressor(1_000_000, 3);
    expect(s.shouldSurface("f1", 0)).toBe(true);
    expect(s.shouldSurface("f2", 1)).toBe(true);
    expect(s.shouldSurface("f3", 2)).toBe(true);
    expect(s.shouldSurface("f4", 3)).toBe(true); // size 4 > cap 3 → evicts oldest (f1)

    // f2/f3/f4 are still retained → suppressed within cooldown (these false calls don't mutate the map).
    expect(s.shouldSurface("f2", 4)).toBe(false);
    expect(s.shouldSurface("f3", 5)).toBe(false);
    expect(s.shouldSurface("f4", 6)).toBe(false);
    // f1 was evicted → treated as never-seen → re-surfaces (the bound's observable effect).
    expect(s.shouldSurface("f1", 7)).toBe(true);
  });

  it("a non-finite / non-positive cap falls back to the default (stays bounded, never unbounded)", () => {
    // NaN cap would make `size > cap` always false → unbounded; the guard prevents that.
    const s = new FindingResurfaceSuppressor(COOLDOWN, Number.NaN);
    expect(s.shouldSurface("x", 0)).toBe(true);
    expect(s.shouldSurface("x", 1)).toBe(false); // still functions as a normal suppressor
  });
});
