import { describe, expect, it } from "vitest";

import { evidenceIsUntrustedOnly, groundedOnUntrustedOnly, verifyGrounding } from "./knowledge-recall.js";
import type { KnowledgeMatch } from "./knowledge-recall.js";

/**
 * grounded ≠ true — the NAMED boundary of the grounding gate (the biggest open hole).
 *
 * The gate verifies an answer is FAITHFUL TO ITS SOURCE: claim↔evidence token
 * coverage + a citation that resolves to a retrieved source. It does NOT — and on a
 * single fixed local model cannot — verify the SOURCE is TRUE. So a poisoned note, or
 * simply a wrong fact in the user's own data, produces a CONFIDENT, GROUNDED, CITED
 * answer that is factually false. This is intentional for a "tell it everything, it's
 * yours" assistant (Muse is faithful to YOUR data, not an oracle of world truth); the
 * user's defense is PROVENANCE — the citation is always present and resolving, so a
 * false claim is traceable to the exact source the user can then distrust. What the gate
 * DOES still protect is citation INTEGRITY: you cannot cite a source you were not given.
 *
 * These tests LOCK that boundary so any future change to it (e.g. source-trust
 * segregation for untrusted MCP tool-output) is deliberate, not accidental.
 */
describe("grounded ≠ true (named boundary)", () => {
  const note = (source: string, text: string): KnowledgeMatch => ({ cosine: 0.97, score: 1, source, text });

  it("marks a FALSE-but-source-supported answer GROUNDED — faithfulness is to the source, not the truth", () => {
    const matches = [note("rumor.md", "The Eiffel Tower is located in Berlin.")];
    const v = verifyGrounding("The Eiffel Tower is in Berlin [from rumor.md].", matches, "Where is the Eiffel Tower?");
    expect(v.verdict).toBe("grounded"); // the gate is satisfied — the claim matches its (false) source
    expect(v.invalidCitations).toEqual([]); // provenance holds: the citation resolves
  });

  it("a poisoned answer ALWAYS carries a resolving citation — provenance is the user's only defense", () => {
    const matches = [note("old-meeting.md", "Project X ships on the 3rd; Dana owns billing.")];
    // Even if "Dana owns billing" is stale/false in the world, the gate ties it to its
    // source so the user can verify and override it.
    const v = verifyGrounding("Dana owns billing [from old-meeting.md].", matches, "Who owns billing?");
    expect(v.verdict).toBe("grounded");
    expect(v.rubric.citationValidity).toBe(1);
  });

  it("STILL catches a FABRICATED citation (source not retrieved) — citation integrity is protected, veracity is not", () => {
    const matches = [note("rumor.md", "The Eiffel Tower is in Berlin.")];
    const v = verifyGrounding("The Eiffel Tower is in Berlin [from trusted-encyclopedia.md].", matches, "Where is the Eiffel Tower?");
    expect(v.verdict).toBe("ungrounded"); // a source the user never had cannot be cited, even for a token-supported claim
    expect(v.invalidCitations).toContain("trusted-encyclopedia.md");
  });
});

describe("groundedOnUntrustedOnly (source-trust segregation — the grounded≠true mitigation)", () => {
  const untrusted = (source: string): KnowledgeMatch => ({ score: 1, source, text: "x", trusted: false });
  const trusted = (source: string): KnowledgeMatch => ({ score: 1, source, text: "x" }); // absent = user's own data

  it("flags an answer that cites ONLY untrusted (tool-output) sources", () => {
    expect(groundedOnUntrustedOnly("It costs $9 [from mcp-shop.json].", [untrusted("mcp-shop.json")])).toBe(true);
  });

  it("does NOT flag when a TRUSTED source also backs the claim", () => {
    const matches = [untrusted("mcp-shop.json"), trusted("my-notes.md")];
    expect(groundedOnUntrustedOnly("It costs $9 [from mcp-shop.json] [from my-notes.md].", matches)).toBe(false);
  });

  it("does NOT flag a purely user-data answer, and treats absent `trusted` as the user's own", () => {
    expect(groundedOnUntrustedOnly("Rent is 1,250,000 [from lease.md].", [trusted("lease.md")])).toBe(false);
  });

  it("returns false when nothing is cited or no citation resolves (verifyGrounding owns those)", () => {
    expect(groundedOnUntrustedOnly("Rent is 1,250,000.", [trusted("lease.md")])).toBe(false);
    expect(groundedOnUntrustedOnly("Rent is 1,250,000 [from ghost.md].", [untrusted("mcp-shop.json")])).toBe(false);
  });
});

describe("evidenceIsUntrustedOnly (structural dual — fires the notice even when the model didn't cite)", () => {
  const untrusted = (source: string): KnowledgeMatch => ({ score: 1, source, text: "x", trusted: false });
  const trusted = (source: string): KnowledgeMatch => ({ score: 1, source, text: "x" }); // absent = user's own data

  it("true when the evidence pool is non-empty and EVERY match is untrusted (tool-only ground)", () => {
    expect(evidenceIsUntrustedOnly([untrusted("mcp-shop.json")])).toBe(true);
    expect(evidenceIsUntrustedOnly([untrusted("web_search"), untrusted("mcp-shop.json")])).toBe(true);
  });

  it("false when ANY trusted note is in the pool (mixed — the per-claim guard owns that)", () => {
    expect(evidenceIsUntrustedOnly([untrusted("mcp-shop.json"), trusted("notes/rent.md")])).toBe(false);
  });

  it("false for an all-trusted pool, and treats absent `trusted` as the user's own", () => {
    expect(evidenceIsUntrustedOnly([trusted("notes/rent.md")])).toBe(false);
  });

  it("false for an EMPTY pool (nothing to rest on — not a tool-only ground)", () => {
    expect(evidenceIsUntrustedOnly([])).toBe(false);
  });
});
