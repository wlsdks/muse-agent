import { describe, expect, it } from "vitest";

import { selectOpenCommitments } from "../src/index.js";

// π-Bench (arXiv:2605.14678): a commitment the user discharged LATER in the
// conversation must not be surfaced (it would nag about a done thing).

// Keyword embedder: "email"/"bob" → email axis; "call"/"dentist" → dentist axis.
// So an "emailed Bob" discharge matches an "email Bob" commitment (cosine 1),
// while "called the dentist" does not (cosine 0).
function fakeEmbed(text: string): Promise<readonly number[]> {
  const t = text.toLowerCase();
  const email = /email|bob|report/.test(t) ? 1 : 0;
  const dentist = /call|dentist/.test(t) ? 1 : 0;
  return Promise.resolve([email, dentist, 0]);
}

describe("selectOpenCommitments", () => {
  it("drops a commitment discharged by a strictly later turn (marker + semantic match)", async () => {
    const open = await selectOpenCommitments(
      ["I need to email Bob the report", "done — I emailed Bob the report just now"],
      fakeEmbed
    );
    expect(open).toHaveLength(0);
  });

  it("keeps a commitment whose later discharge is about an UNRELATED action", async () => {
    const open = await selectOpenCommitments(
      ["I need to email Bob the report", "done — I called the dentist"],
      fakeEmbed
    );
    expect(open.map((c) => c.text)).toContain("email Bob the report");
  });

  it("keeps a commitment when the later turn has no completion marker", async () => {
    // "I emailed Bob" semantically matches but carries no marker? It DOES (emailed) —
    // use a no-marker restatement instead to isolate the marker requirement.
    const open = await selectOpenCommitments(
      ["I need to email Bob the report", "Bob and the report are on my mind"],
      fakeEmbed
    );
    expect(open).toHaveLength(1);
  });

  it("does NOT self-discharge: a marker in the SAME turn as the commitment", async () => {
    // One turn both voices and 'completes' — strict ordering means it isn't dropped.
    const open = await selectOpenCommitments(
      ["I need to email Bob the report, done"],
      fakeEmbed
    );
    expect(open).toHaveLength(1);
  });

  it("keeps a commitment with NO later turns at all", async () => {
    const open = await selectOpenCommitments(["I need to email Bob the report"], fakeEmbed);
    expect(open).toHaveLength(1);
  });

  it("fail-soft: an embedder error returns the detected set (never a false drop)", async () => {
    const open = await selectOpenCommitments(
      ["I need to email Bob the report", "done — I emailed Bob the report"],
      () => Promise.reject(new Error("embedder down"))
    );
    expect(open.length).toBeGreaterThan(0); // degrades to today's behaviour
  });

  it("Korean discharge marker drops the matching commitment", async () => {
    // ko-haeya rule needs a 하다-verb (정리해야 해) — detectUserCommitments captures
    // "Bob 자료 정리"; the later "다 했어" turn discharges it.
    const open = await selectOpenCommitments(
      ["Bob 자료 정리해야 해", "Bob 자료 정리 다 했어"],
      fakeEmbed
    );
    expect(open).toHaveLength(0);
  });

  it("non-vacuity: WITHOUT a discharge turn the same KO commitment IS kept", async () => {
    const open = await selectOpenCommitments(["Bob 자료 정리해야 해"], fakeEmbed);
    expect(open).toHaveLength(1); // proves the drop above is the discharge, not non-detection
  });
});
