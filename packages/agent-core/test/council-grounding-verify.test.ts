import { describe, expect, it, vi } from "vitest";

import {
  synthesizeCouncilAnswer,
  verifyCouncilGrounding,
  type CouncilAnswer,
  type CouncilUtterance
} from "../src/council.js";

const utterances: readonly CouncilUtterance[] = [
  { peerId: "phone", reasoning: "Prefer a phased rollout: ship to 10% first and watch error rates." },
  { peerId: "laptop", reasoning: "Agree on staging behind a flag before a full launch." }
];

const council = (answer: string, ...contributors: string[]): CouncilAnswer => ({ answer, contributors });

describe("verifyCouncilGrounding — RGV re-verification applied to the council surface", () => {
  it("keeps a synthesis the injected judge upholds", async () => {
    const out = await verifyCouncilGrounding(
      council("Roll out gradually behind a flag, starting at 10%.", "phone", "laptop"),
      "how should we launch?",
      utterances,
      async () => true
    );
    expect(out?.answer).toContain("gradually");
  });

  it("drops a synthesis the judge rejects (a consensus none of the members actually reasoned)", async () => {
    const out = await verifyCouncilGrounding(
      council("Cancel the launch and refund every customer.", "phone", "laptop"),
      "how should we launch?",
      utterances,
      async () => false
    );
    expect(out).toBeNull();
  });

  it("fail-closes to null when the judge errors", async () => {
    const out = await verifyCouncilGrounding(
      council("Roll out gradually.", "phone"),
      "how should we launch?",
      utterances,
      async () => { throw new Error("model unreachable"); }
    );
    expect(out).toBeNull();
  });

  it("fail-closes to null WITHOUT consulting the judge when the contributors' evidence is empty (a YES on nothing is a fabrication leak)", async () => {
    const judge = vi.fn(async () => true);
    const out = await verifyCouncilGrounding(
      council("A synthesis with no backing reasoning.", "phone"),
      "how should we launch?",
      [{ peerId: "phone", reasoning: "   " }],
      judge
    );
    expect(out).toBeNull();
    expect(judge).not.toHaveBeenCalled();
  });

  it("with k samples (reverifySamples=2), one NO among the verdicts drops the synthesis (a flaky YES can't promote it)", async () => {
    const judge = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const out = await verifyCouncilGrounding(council("Phased rollout.", "phone"), "how should we launch?", utterances, judge, 2);
    expect(out).toBeNull();
    expect(judge).toHaveBeenCalledTimes(2); // short-circuits AT the first NO (2nd call)
  });

  it("with k samples, an all-YES run keeps the synthesis and consults the judge exactly k times", async () => {
    const judge = vi.fn(async () => true);
    const out = await verifyCouncilGrounding(council("Phased rollout.", "phone"), "how should we launch?", utterances, judge, 3);
    expect(out?.answer).toBe("Phased rollout.");
    expect(judge).toHaveBeenCalledTimes(3);
  });

  it("assembles the evidence from the CONTRIBUTORS' reasoning text, not their ids", async () => {
    let seen = "";
    await verifyCouncilGrounding(council("Phased rollout.", "phone"), "how should we launch?", utterances, async ({ evidence }) => {
      seen = evidence;
      return true;
    });
    expect(seen).toContain("ship to 10% first");
    expect(seen).not.toContain("phone");
  });
});

const fakeProvider = (output: string) => ({ generate: async () => ({ id: "r", model: "m", output }) });

describe("synthesizeCouncilAnswer — optional grounding re-verification", () => {
  const synthesis = JSON.stringify({ answer: "Roll out gradually behind a flag.", contributors: ["phone", "laptop"] });

  it("returns the synthesis when the injected judge upholds it", async () => {
    const out = await synthesizeCouncilAnswer("how should we launch?", utterances, {
      model: "m",
      modelProvider: fakeProvider(synthesis),
      reverify: async () => true
    });
    expect(out?.answer).toContain("gradually");
  });

  it("returns null when the injected judge rejects it", async () => {
    const out = await synthesizeCouncilAnswer("how should we launch?", utterances, {
      model: "m",
      modelProvider: fakeProvider(synthesis),
      reverify: async () => false
    });
    expect(out).toBeNull();
  });
});
