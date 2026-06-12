import { describe, expect, it } from "vitest";

import { buildAttributedRepairPrompt, repairToEvidence } from "../src/index.js";
import type { GroundingVerdict, GroundingVerification, KnowledgeMatch } from "../src/index.js";

const match = (source: string, text: string): KnowledgeMatch => ({ cosine: 0.7, score: 0.7, source, text });
const verdict = (v: GroundingVerdict): GroundingVerification => ({
  invalidCitations: [],
  reason: v,
  rubric: { answerability: 1, citationValidity: 1, confidence: 1, coverage: 1 },
  verdict: v
});

const evidence = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.")];
const query = "what MTU for the office VPN";

describe("repairToEvidence — attributed self-repair (RARR), fail-closed", () => {
  it("returns the corrected answer when the rewrite re-verifies GROUNDED", async () => {
    const result = await repairToEvidence("The VPN uses MTU 9000.", evidence, query, {
      rewrite: async () => "The office VPN uses MTU 1380 on wg0 [from notes/vpn.md].",
      verify: async () => verdict("grounded")
    });
    expect(result.repaired).toBe("The office VPN uses MTU 1380 on wg0 [from notes/vpn.md].");
  });

  it("drops the rewrite when it still re-verifies UNGROUNDED (never shows an unverified fix)", async () => {
    const result = await repairToEvidence("The VPN uses MTU 9000.", evidence, query, {
      rewrite: async () => "The office VPN uses MTU 9000 on wg0 [from notes/vpn.md].",
      verify: async () => verdict("ungrounded")
    });
    expect(result.repaired).toBeUndefined();
    expect(result.reason).toContain("ungrounded");
  });

  it("drops the rewrite when it still re-verifies WEAK (only a grounded rewrite is shown)", async () => {
    const result = await repairToEvidence("draft", evidence, query, {
      rewrite: async () => "Maybe MTU something [from notes/vpn.md].",
      verify: async () => verdict("weak")
    });
    expect(result.repaired).toBeUndefined();
  });

  it("does NOT fabricate a fix: a refusing rewrite leaves the honest refusal standing", async () => {
    let verifyCalled = false;
    const result = await repairToEvidence("Your blood type is O+.", evidence, "what is my blood type", {
      isRefusal: (a) => /i'm not sure/iu.test(a),
      rewrite: async () => "I'm not sure — that isn't in your notes.",
      verify: async () => { verifyCalled = true; return verdict("grounded"); }
    });
    expect(result.repaired).toBeUndefined();
    expect(verifyCalled).toBe(false); // short-circuits before verifying a refusal
  });

  it("does not attempt a repair when there is no evidence to ground on", async () => {
    let rewriteCalled = false;
    const result = await repairToEvidence("anything", [], query, {
      rewrite: async () => { rewriteCalled = true; return "x"; },
      verify: async () => verdict("grounded")
    });
    expect(result.repaired).toBeUndefined();
    expect(rewriteCalled).toBe(false);
  });

  it("applies the citation gate before verifying (a stripped fabricated citation can't ground the fix)", async () => {
    const gatedSeen: string[] = [];
    const result = await repairToEvidence("draft", evidence, query, {
      gate: (a) => { gatedSeen.push(a); return a.replace(/\[from secret\.md\]/u, ""); },
      rewrite: async () => "MTU 1380 [from notes/vpn.md] [from secret.md].",
      verify: async (a) => { expect(a).not.toContain("secret.md"); return verdict("grounded"); }
    });
    expect(gatedSeen).toHaveLength(1);
    expect(result.repaired).toContain("[from notes/vpn.md]");
    expect(result.repaired).not.toContain("secret.md");
  });

  it("fail-closes on a rewrite-pass error", async () => {
    const result = await repairToEvidence("draft", evidence, query, {
      rewrite: async () => { throw new Error("model unreachable"); },
      verify: async () => verdict("grounded")
    });
    expect(result.repaired).toBeUndefined();
    expect(result.reason).toContain("failed");
  });

  it("fail-closes (does not throw) when the VERIFIER itself errors — honest refusal stands", async () => {
    const result = await repairToEvidence("draft", evidence, query, {
      rewrite: async () => "MTU 1380 [from notes/vpn.md].",
      verify: async () => { throw new Error("reverify judge unreachable"); }
    });
    expect(result.repaired).toBeUndefined();
    expect(result.reason).toContain("verification failed");
  });
});

describe("buildAttributedRepairPrompt", () => {
  it("carries the question, evidence, and draft so a one-shot rewrite has everything", () => {
    const prompt = buildAttributedRepairPrompt({ answer: "MTU 9000", evidence: "[notes/vpn.md] MTU 1380", query });
    expect(prompt).toContain(query);
    expect(prompt).toContain("[notes/vpn.md] MTU 1380");
    expect(prompt).toContain("MTU 9000");
    expect(prompt).toContain("[from <source>]");
  });
});
