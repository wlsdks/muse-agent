import { describe, expect, it } from "vitest";

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
