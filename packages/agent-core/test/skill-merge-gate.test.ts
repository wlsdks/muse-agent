import { describe, expect, it } from "vitest";

import { validateMergeCoverage, validateUmbrellaCoverage } from "../src/skill-merge-gate.js";

// Deterministic fake embedder: maps each text to a 2-D unit vector at a chosen
// angle, so pairwise cosine is exactly cos(Δangle) — no Ollama needed. The
// umbrella sits at 0°; a "covered" skill is near it, a "lost" skill is far.
function fakeEmbed(text: string): Promise<readonly number[]> {
  let deg: number;
  if (text.includes("lost")) deg = 85; // cos 85° ≈ 0.09  → below floor
  else if (text.includes("near")) deg = 40; // cos 40° ≈ 0.77 → above default floor, below 0.8
  else if (text.includes("cov")) deg = 12; // cos 12° ≈ 0.98 → well covered
  else deg = 0; // the umbrella
  const r = (deg * Math.PI) / 180;
  return Promise.resolve([Math.cos(r), Math.sin(r)]);
}

const opt = { embed: fakeEmbed };

describe("validateUmbrellaCoverage (semantic)", () => {
  const umbrella = { name: "umbrella-skill", description: "Use when handling the cluster", body: "steps" };

  it("accepts an umbrella that semantically covers every clustered skill", async () => {
    const cluster = [
      { name: "cov-a", description: "Use when doing A", body: "x" },
      { name: "cov-b", description: "Use when doing B", body: "y" },
      { name: "cov-c", description: "Use when doing C", body: "z" }
    ];
    const verdict = await validateUmbrellaCoverage(cluster, umbrella, opt);
    expect(verdict.accept).toBe(true);
    expect(verdict.lost).toEqual([]);
    expect(verdict.score).toBe(1);
  });

  it("REJECTS an umbrella that drops one skill's purpose (semantic miss)", async () => {
    const cluster = [
      { name: "cov-a", description: "Use when doing A", body: "x" },
      { name: "cov-b", description: "Use when doing B", body: "y" },
      { name: "lost-c", description: "Use when doing an unrelated thing", body: "z" }
    ];
    const verdict = await validateUmbrellaCoverage(cluster, umbrella, opt);
    expect(verdict.accept).toBe(false);
    expect(verdict.lost).toEqual(["lost-c"]);
    expect(verdict.score).toBeCloseTo(2 / 3);
    expect(verdict.reason).toContain("lost-c");
  });

  it("accepts a loosely-generalised umbrella above the floor (40° ≈ 0.77 ≥ 0.65)", async () => {
    const cluster = [{ name: "near-a", description: "Use when doing A", body: "x" }];
    const verdict = await validateUmbrellaCoverage(cluster, umbrella, opt);
    expect(verdict.accept).toBe(true);
    expect(verdict.covered).toEqual(["near-a"]);
  });

  it("a higher floor can reject the same loose generalisation", async () => {
    const cluster = [{ name: "near-a", description: "Use when doing A", body: "x" }];
    const verdict = await validateUmbrellaCoverage(cluster, umbrella, { embed: fakeEmbed, floor: 0.85 });
    expect(verdict.accept).toBe(false);
    expect(verdict.lost).toEqual(["near-a"]);
  });

  it("requireAllCovered=false accepts a partial merge above minScore", async () => {
    const cluster = [
      { name: "cov-a", description: "Use when doing A", body: "x" },
      { name: "cov-b", description: "Use when doing B", body: "y" },
      { name: "lost-c", description: "Use when doing an unrelated thing", body: "z" }
    ];
    const verdict = await validateUmbrellaCoverage(cluster, umbrella, {
      embed: fakeEmbed,
      minScore: 0.6,
      requireAllCovered: false
    });
    expect(verdict.accept).toBe(true); // 2/3 ≥ 0.6
    expect(verdict.lost).toEqual(["lost-c"]);
  });

  it("requireAllCovered=false gates COMBINED trigger∧body coverage against minScore (asymmetric loss fail-open)", async () => {
    // A lost on TRIGGER only, B lost on BODY only, C covered on both. Each surface
    // sees just one loss (2/3 ≥ 0.6 → accepts), but the COMBINED coverage (covered
    // on BOTH) is only C = 1/3, below minScore. The whole-answer gate must reject.
    const embed = (t: string): Promise<readonly number[]> =>
      Promise.resolve(/loseTrig|loseBody/u.test(t) ? [0, 1] : [1, 0]);
    const cluster = [
      { name: "A-loseTrig", description: "loseTrig", body: "good body A" },
      { name: "B-fine", description: "Use when B", body: "loseBody bad body B" },
      { name: "C-fine", description: "Use when C", body: "good body C" }
    ];
    const merged = { name: "u", description: "Use when B or C", body: "good merged body" };
    const verdict = await validateUmbrellaCoverage(cluster, merged, { embed, minScore: 0.6, requireAllCovered: false });
    expect(verdict.accept).toBe(false); // combined 1/3 < 0.6 — was WRONGLY true (fail-open)
    expect([...verdict.lost].sort()).toEqual(["A-loseTrig", "B-fine"]);
    expect(verdict.score).toBeCloseTo(1 / 3);
  });

  it("is FAIL-CLOSED: an embedder error rejects (cannot verify ⇒ do not commit)", async () => {
    const cluster = [{ name: "cov-a", description: "Use when doing A", body: "x" }];
    const verdict = await validateUmbrellaCoverage(cluster, umbrella, {
      embed: () => Promise.reject(new Error("ollama down"))
    });
    expect(verdict.accept).toBe(false);
    expect(verdict.lost).toEqual(["cov-a"]);
    expect(verdict.reason).toContain("embedder unavailable");
  });

  it("an empty cluster never accepts", async () => {
    const verdict = await validateUmbrellaCoverage([], umbrella, opt);
    expect(verdict.accept).toBe(false);
    expect(verdict.score).toBe(0);
  });

  describe("body coverage (the gutted-body hole)", () => {
    // Body-discriminating embedder: "TODO" → gutted axis, "bullet" → body axis,
    // anything else (the triggers) → trigger axis. So triggers always cover, and
    // the BODY surface is what decides a gutted vs real body.
    const bodyEmbed = (t: string): Promise<readonly number[]> =>
      Promise.resolve(/todo/iu.test(t) ? [0, 0, 1] : /bullet/u.test(t) ? [0, 1, 0] : [1, 0, 0]);
    const cluster = [
      { name: "summarise-email", description: "Use when summarising an email", body: "read the thread and emit bullets" },
      { name: "summarise-doc", description: "Use when summarising a document", body: "skim headings and emit bullets" }
    ];

    it("REJECTS an umbrella whose trigger covers the cluster but whose body is gutted (TODO)", async () => {
      const gutted = { name: "summarise-content", description: "Use when summarising emails or documents", body: "TODO" };
      const verdict = await validateUmbrellaCoverage(cluster, gutted, { embed: bodyEmbed });
      expect(verdict.accept).toBe(false); // trigger covers, but body coverage fails
      expect(verdict.lost.length).toBeGreaterThan(0);
    });

    it("ACCEPTS an umbrella that covers the cluster on BOTH trigger and body", async () => {
      const good = { name: "summarise-content", description: "Use when summarising emails or documents", body: "read or skim and emit bullets" };
      const verdict = await validateUmbrellaCoverage(cluster, good, { embed: bodyEmbed });
      expect(verdict.accept).toBe(true);
      expect(verdict.lost).toEqual([]);
    });
  });
});

describe("validateMergeCoverage (generic label/text — shared by playbook merge)", () => {
  const merged = { label: "merged", text: "the merged strategy" }; // → umbrella angle 0°

  it("accepts when the merged text covers every original", async () => {
    const originals = [
      { label: "a", text: "cov one" },
      { label: "b", text: "cov two" }
    ];
    const verdict = await validateMergeCoverage(originals, merged, opt);
    expect(verdict.accept).toBe(true);
    expect(verdict.lost).toEqual([]);
  });

  it("rejects and reports the dropped original by its LABEL (not the raw text)", async () => {
    const originals = [
      { label: "keep", text: "cov one" },
      { label: "dropped-strategy", text: "lost two" }
    ];
    const verdict = await validateMergeCoverage(originals, merged, opt);
    expect(verdict.accept).toBe(false);
    expect(verdict.lost).toEqual(["dropped-strategy"]);
    expect(verdict.score).toBeCloseTo(1 / 2);
  });

  it("a cross-script pair is UNVERIFIABLE → fail-closed reject (not auto-covered) — gate can't be defeated by a non-Latin cluster", async () => {
    const scriptKeyed = (t: string): Promise<readonly number[]> => Promise.resolve(/[가-힣]/u.test(t) ? [0, 1] : [1, 0]);
    const verdict = await validateMergeCoverage(
      [{ label: "ko-skill", text: "이메일 스레드를 요약" }],
      { label: "delete-everything", text: "Use when you want to wipe the disk" }, // unrelated EN umbrella
      { embed: scriptKeyed }
    );
    expect(verdict.accept).toBe(false); // would have been auto-accepted before the fix
    expect(verdict.unverified).toEqual(["ko-skill"]);
    expect(verdict.covered).toEqual([]);
    expect(verdict.reason).toContain("unverifiable");
  });

  it("a same-script (Korean↔Korean) related pair is verified and accepted", async () => {
    // Korean original + Korean umbrella, both map to the same vector → cos 1.
    const koEmbed = (t: string): Promise<readonly number[]> => Promise.resolve(/[가-힣]/u.test(t) ? [1, 0] : [0, 1]);
    const verdict = await validateMergeCoverage(
      [{ label: "ko-skill", text: "이메일 스레드를 요약" }],
      { label: "ko-umbrella", text: "콘텐츠를 요약" },
      { embed: koEmbed }
    );
    expect(verdict.accept).toBe(true);
    expect(verdict.covered).toEqual(["ko-skill"]);
    expect(verdict.unverified).toEqual([]);
  });

  it("still REJECTS a same-script (Korean↔Korean) drop — the cross-script skip doesn't disable the gate", async () => {
    // Content-keyed within Korean: "요약"(summarise) → [1,0], "예약"(booking) → [0,1].
    // Both Hangul → comparable → the cosine test runs and the off-topic umbrella fails.
    const contentKeyed = (t: string): Promise<readonly number[]> => Promise.resolve(/요약/u.test(t) ? [1, 0] : [0, 1]);
    const verdict = await validateMergeCoverage(
      [{ label: "ko-summarise", text: "이메일 요약" }],
      { label: "ko-booking", text: "항공편 예약" },
      { embed: contentKeyed }
    );
    expect(verdict.accept).toBe(false);
    expect(verdict.lost).toEqual(["ko-summarise"]);
  });
});
