import { describe, expect, it } from "vitest";

import {
  buildGroundingReverifyPrompt,
  parseGroundingReverifyVerdict,
  verifyGroundingWithReverify,
  type KnowledgeMatch
} from "../src/index.js";

const match = (source: string, text: string, cosine: number): KnowledgeMatch => ({
  cosine,
  score: cosine,
  source,
  text
});

// Force a `weak` base verdict (otherwise-consistent answer over an ambiguous
// cosine, just under the default 0.55 threshold).
const weakMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.5)];
const weakAnswer = "The VPN MTU is 1380 on wg0 [from notes/vpn.md].";
const query = "what MTU for the office VPN";

const never = () => {
  throw new Error("reverify must NOT be called when the deterministic core already decides");
};

describe("verifyGroundingWithReverify — test-time re-verification of the weak verdict (fail-close)", () => {
  it("promotes WEAK to GROUNDED when the injected re-verifier judges the answer supported", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => true);
    expect(out.verdict).toBe("grounded");
  });

  it("demotes WEAK to UNGROUNDED when the re-verifier judges the answer unsupported", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => false);
    expect(out.verdict).toBe("ungrounded");
  });

  it("fail-closes WEAK to UNGROUNDED when the re-verifier throws (no silent upgrade on error)", async () => {
    const out = await verifyGroundingWithReverify(weakAnswer, weakMatches, query, async () => {
      throw new Error("model unreachable");
    });
    expect(out.verdict).toBe("ungrounded");
  });

  it("does NOT call the re-verifier when the deterministic core already returns GROUNDED", async () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72)];
    const out = await verifyGroundingWithReverify(weakAnswer, matches, query, never);
    expect(out.verdict).toBe("grounded");
  });

  it("does NOT call the re-verifier when the deterministic core already returns UNGROUNDED", async () => {
    const out = await verifyGroundingWithReverify("Your flight is at 9am.", [], "when is my flight", never);
    expect(out.verdict).toBe("ungrounded");
  });
});

describe("parseGroundingReverifyVerdict — deterministic YES/NO parse, fail-close", () => {
  it("treats a clear YES as supported", () => {
    expect(parseGroundingReverifyVerdict("YES — the passage states MTU 1380.")).toBe(true);
  });

  it("treats NO as unsupported", () => {
    expect(parseGroundingReverifyVerdict("NO, the evidence does not mention that.")).toBe(false);
  });

  it("fail-closes an ambiguous or empty model reply to unsupported", () => {
    expect(parseGroundingReverifyVerdict("I'm not certain")).toBe(false);
    expect(parseGroundingReverifyVerdict("")).toBe(false);
  });
});

describe("buildGroundingReverifyPrompt", () => {
  it("includes the answer, the query, and the evidence so a one-shot judge has everything", () => {
    const prompt = buildGroundingReverifyPrompt({
      answer: weakAnswer,
      evidence: weakMatches.map((m) => m.text).join("\n"),
      query
    });
    expect(prompt).toContain(weakAnswer);
    expect(prompt).toContain(query);
    expect(prompt).toContain("MTU 1380");
  });
});
