import { describe, expect, it } from "vitest";

import type { KnowledgeMatch } from "../src/knowledge-recall.js";
import { createConfidenceGatedInvestigator, decideProactiveRecall, DEFAULT_FINDING_COOLDOWN_MS, FindingResurfaceSuppressor } from "../src/proactive-recall-gate.js";

const match = (source: string, text: string, cosine: number, score = cosine): KnowledgeMatch => ({
  cosine,
  score,
  source,
  text
});

describe("decideProactiveRecall — the confidence gate that earns proactivity (north star)", () => {
  it("SURFACES a cited finding from the top match when recall is confident", () => {
    const d = decideProactiveRecall([match("standup.md", "Sync with the platform team on the migration plan", 0.7)]);
    expect(d.surface).toBe(true);
    expect(d.confidence).toBe("confident");
    expect(d.reason).toBe("confident recall");
    expect(d.finding).toBe("📎 Related in your notes — [standup.md] Sync with the platform team on the migration plan");
  });

  it("cites the HIGHEST-cosine match, not merely the first in the list", () => {
    const d = decideProactiveRecall([
      match("weak.md", "barely related note", 0.56),
      match("best.md", "the most relevant passage", 0.92),
      match("mid.md", "middling note", 0.6)
    ]);
    expect(d.surface).toBe(true);
    expect(d.finding).toContain("[best.md]");
    expect(d.finding).toContain("the most relevant passage");
  });

  it("stays SILENT (ambiguous) when the top match is below the confidence bar", () => {
    const d = decideProactiveRecall([match("x.md", "tangential", 0.54)]);
    expect(d).toMatchObject({
      surface: false,
      confidence: "ambiguous",
      reason: "recall too weak to surface unasked — stay silent"
    });
    expect(d.finding).toBeUndefined();
  });

  it("stays SILENT (none) when there are no matches at all", () => {
    const d = decideProactiveRecall([]);
    expect(d).toEqual({
      surface: false,
      confidence: "none",
      reason: "no matching passages — stay silent"
    });
  });

  it("honours a custom confidentAt: a 0.6 top match is ambiguous under a 0.9 bar", () => {
    expect(decideProactiveRecall([match("a.md", "note", 0.6)], { confidentAt: 0.9 }).surface).toBe(false);
    expect(decideProactiveRecall([match("a.md", "note", 0.6)], { confidentAt: 0.5 }).surface).toBe(true);
  });

  it("falls back to `score` when a match carries no absolute cosine", () => {
    const noCosine: KnowledgeMatch = { source: "s.md", text: "scored only", score: 0.8 };
    expect(decideProactiveRecall([noCosine]).surface).toBe(true);
  });

  it("centres the snippet on the line that matches the query, not the chunk OPENING", () => {
    // A long chunk matched the item as a whole, but the relevant line sits at the
    // end — quoting the opening would surface a non-sequitur ("Project kickoff…").
    const chunk = "Project kickoff went well and the team aligned on goals. Budget was approved at 40k after finance review. The summer timeline is tight but doable. By the way, Mom's birthday is on June 12th and she loves orchids.";
    const d = decideProactiveRecall([match("journal.md", chunk, 0.78)], { maxChars: 80, query: "Mom birthday" });
    expect(d.finding).toContain("Mom's birthday is on June 12th");
    expect(d.finding).not.toContain("Project kickoff");
  });

  it("falls back to the OPENING when the query has no lexical overlap (purely semantic match)", () => {
    const chunk = "Project kickoff went well and the team aligned on goals. Budget was approved at 40k after finance review. The summer timeline is tight but doable here.";
    const d = decideProactiveRecall([match("journal.md", chunk, 0.78)], { maxChars: 40, query: "xyzzy nonsense" });
    expect(d.finding).toBe("📎 Related in your notes — [journal.md] Project kickoff went well and the team a…");
  });

  it("a short chunk is quoted whole regardless of query (no spurious sentence-splitting)", () => {
    const d = decideProactiveRecall([match("n.md", "Mom loves orchids.", 0.7)], { maxChars: 160, query: "Mom birthday" });
    expect(d.finding).toBe("📎 Related in your notes — [n.md] Mom loves orchids.");
  });

  it("truncates the chosen relevant sentence when it alone exceeds maxChars", () => {
    const chunk = "An opening sentence with no relevance at all to the topic here. " +
      "The dentist cleaning appointment is confirmed for next Tuesday at the downtown clinic on Main Street near the park.";
    const d = decideProactiveRecall([match("h.md", chunk, 0.7)], { maxChars: 40, query: "dentist cleaning appointment" });
    expect(d.finding).toContain("The dentist cleaning appointment");
    expect(d.finding).toContain("…");
    expect(d.finding).not.toContain("opening sentence");
  });

  it("collapses whitespace and truncates the snippet to maxChars with an ellipsis", () => {
    const d = decideProactiveRecall([match("n.md", "alpha   beta\n\n\tgamma delta epsilon", 0.7)], { maxChars: 10 });
    // whitespace collapsed first, then sliced to 10 chars + …
    expect(d.finding).toBe("📎 Related in your notes — [n.md] alpha beta…");
  });

  it("does not truncate when the collapsed snippet is within maxChars (no stray ellipsis)", () => {
    const d = decideProactiveRecall([match("n.md", "short", 0.7)], { maxChars: 100 });
    expect(d.finding).toBe("📎 Related in your notes — [n.md] short");
    expect(d.finding).not.toContain("…");
  });

  it("treats a zero maxChars as the 160-char default (never an empty snippet)", () => {
    const long = "x".repeat(200);
    const d = decideProactiveRecall([match("n.md", long, 0.7)], { maxChars: 0 });
    expect(d.finding).toBe(`📎 Related in your notes — [n.md] ${"x".repeat(160)}…`);
  });

  it("treats a NEGATIVE maxChars as the default too — not a negative-index slice that drops the tail", () => {
    // `maxChars && maxChars > 0` must reject -5; otherwise slice(0, -5) would
    // silently lop the last 5 chars off every proactive snippet.
    const long = "y".repeat(200);
    const d = decideProactiveRecall([match("n.md", long, 0.7)], { maxChars: -5 });
    expect(d.finding).toBe(`📎 Related in your notes — [n.md] ${"y".repeat(160)}…`);
  });

  it("does NOT append an ellipsis when the snippet length exactly equals maxChars (boundary is `>`)", () => {
    const d = decideProactiveRecall([match("n.md", "12345", 0.7)], { maxChars: 5 });
    expect(d.finding).toBe("📎 Related in your notes — [n.md] 12345");
  });
});

describe("createConfidenceGatedInvestigator — wires the gate into the proactive loop (fail-open)", () => {
  // Contract-faithful fake embed: a 2D space where the "meeting" axis is
  // orthogonal to everything else, so a matching chunk scores cosine 1.0
  // (confident) and an unrelated chunk scores 0.0 (silent).
  const embed = async (text: string): Promise<readonly number[]> => (text.includes("meeting") ? [1, 0] : [0, 1]);
  const item = { factSheet: "", kind: "task", title: "team meeting" };

  it("returns the cited finding when recall over the corpus is confident", async () => {
    const inv = createConfidenceGatedInvestigator({
      chunks: [{ source: "notes.md", text: "the team meeting agenda was finalized today" }],
      embed
    });
    const out = await inv(item);
    expect(out).toContain("📎 Related in your notes — [notes.md]");
    expect(out).toContain("the team meeting agenda");
  });

  it("returns undefined (stays silent) when the corpus is only weakly related", async () => {
    const inv = createConfidenceGatedInvestigator({
      chunks: [{ source: "x.md", text: "grocery shopping list for the week" }],
      embed
    });
    expect(await inv(item)).toBeUndefined();
  });

  it("returns undefined for a blank item title (nothing to recall on)", async () => {
    const inv = createConfidenceGatedInvestigator({ chunks: [{ source: "n.md", text: "team meeting notes" }], embed });
    expect(await inv({ factSheet: "", kind: "task", title: "   " })).toBeUndefined();
  });

  it("returns undefined for an empty corpus", async () => {
    expect(await createConfidenceGatedInvestigator({ chunks: [], embed })(item)).toBeUndefined();
  });

  it("blank-query guard prevents a spurious surface even when a chunk WOULD match the empty-query embedding", async () => {
    // Without the early `query.length === 0` return, an empty title would still
    // embed and could score a confident cosine against an unrelated chunk —
    // surfacing a proactive finding for a recall the user never triggered. The
    // grocery chunk shares the empty-query embedding here, so only the guard
    // keeps it silent.
    const inv = createConfidenceGatedInvestigator({ chunks: [{ source: "g.md", text: "grocery shopping list" }], embed });
    expect(await inv({ factSheet: "", kind: "task", title: "   " })).toBeUndefined();
  });

  it("forwards deps.maxChars to truncate the surfaced snippet (not the 160-char default)", async () => {
    const long = `team meeting ${"z".repeat(200)}`;
    const inv = createConfidenceGatedInvestigator({ chunks: [{ source: "n.md", text: long }], embed, maxChars: 20 });
    const out = await inv(item);
    expect(out).toBe(`📎 Related in your notes — [n.md] ${long.replace(/\s+/gu, " ").trim().slice(0, 20)}…`);
  });

  it("re-reads a LAZY chunk provider each tick", async () => {
    let calls = 0;
    const inv = createConfidenceGatedInvestigator({
      chunks: async () => {
        calls += 1;
        return [{ source: "lazy.md", text: "team meeting recap and action items" }];
      },
      embed
    });
    expect(await inv(item)).toContain("[lazy.md]");
    expect(calls).toBe(1);
  });

  it("fail-open: a throwing chunk provider yields undefined (base notice still fires)", async () => {
    const inv = createConfidenceGatedInvestigator({
      chunks: async () => { throw new Error("index unreadable"); },
      embed
    });
    expect(await inv(item)).toBeUndefined();
  });

  it("fail-open: a throwing embed yields undefined", async () => {
    const inv = createConfidenceGatedInvestigator({
      chunks: [{ source: "n.md", text: "team meeting notes" }],
      embed: async () => { throw new Error("embedder down"); }
    });
    expect(await inv(item)).toBeUndefined();
  });

  it("forwards confidentAt so a high bar suppresses a finding that would otherwise surface", async () => {
    const chunks = [{ source: "n.md", text: "the team meeting agenda" }];
    expect(await createConfidenceGatedInvestigator({ chunks, embed, confidentAt: 0.5 })(item)).toContain("[n.md]");
    // cosine 1.0 can't be beaten, so push the bar above 1 to prove the option is wired.
    expect(await createConfidenceGatedInvestigator({ chunks, embed, confidentAt: 1.01 })(item)).toBeUndefined();
  });
});

describe("FindingResurfaceSuppressor — anti-nag re-surface gate (arXiv:2410.12361)", () => {
  const F = "📎 Related in your notes — [q3.md] Q3 budget review prep";

  it("surfaces first, suppresses an identical finding within the cooldown, re-surfaces after", () => {
    const s = new FindingResurfaceSuppressor(1000);
    expect(s.shouldSurface(F, 0)).toBe(true); // first time
    expect(s.shouldSurface(F, 500)).toBe(false); // within cooldown → suppress
    expect(s.shouldSurface(F, 999)).toBe(false); // still within
    expect(s.shouldSurface(F, 1000)).toBe(true); // cooldown elapsed → re-surface (reversible)
  });

  it("tracks each distinct finding independently", () => {
    const s = new FindingResurfaceSuppressor(1000);
    expect(s.shouldSurface("finding A", 0)).toBe(true);
    expect(s.shouldSurface("finding B", 0)).toBe(true); // different finding, not suppressed by A
    expect(s.shouldSurface("finding A", 100)).toBe(false); // A still cooling
  });

  it("a blank finding is never suppressed (defensive)", () => {
    const s = new FindingResurfaceSuppressor(1000);
    expect(s.shouldSurface("   ", 0)).toBe(true);
    expect(s.shouldSurface("   ", 1)).toBe(true);
  });

  it("recording is gated on shouldSurface returning true (a suppressed call does not slide the window)", () => {
    const s = new FindingResurfaceSuppressor(1000);
    expect(s.shouldSurface(F, 0)).toBe(true); // recorded at 0
    expect(s.shouldSurface(F, 800)).toBe(false); // suppressed, must NOT re-record at 800
    expect(s.shouldSurface(F, 1000)).toBe(true); // 1000-0 >= 1000 → re-surface (proves 800 wasn't recorded)
  });

  it("exports a sane positive default cooldown", () => {
    expect(DEFAULT_FINDING_COOLDOWN_MS).toBeGreaterThan(0);
  });
});
