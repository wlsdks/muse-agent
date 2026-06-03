import { describe, expect, it } from "vitest";

import type { KnowledgeMatch } from "@muse/agent-core";

import { formatSourceReceipts, groundingVerdictNotice } from "./commands-ask.js";

const match = (source: string, text: string, cosine: number): KnowledgeMatch => ({
  cosine,
  score: cosine,
  source,
  text
});

describe("groundingVerdictNotice — output-side rubric verdict on the ask wedge", () => {
  it("returns undefined for a grounded answer (claims backed by confident evidence)", async () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.72)];
    expect(await groundingVerdictNotice("Set the VPN MTU to 1380 on wg0 [from notes/vpn.md].", matches, "what MTU for the office VPN")).toBeUndefined();
  });

  it("warns when a confident retrieval is followed by an answer whose claims the evidence does not support", async () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72)];
    const notice = await groundingVerdictNotice(
      "Your dentist appointment is Tuesday at 3pm and the rent is due Friday.",
      matches,
      "what MTU for the office VPN"
    );
    expect(notice).toBeDefined();
    expect(notice).toContain("Grounding check");
  });

  it("stays silent on an honest refusal (the refusal already asserts no grounded claim — no double warning)", async () => {
    expect(await groundingVerdictNotice("I'm not sure — nothing in your notes covers that.", [], "when is my flight")).toBeUndefined();
  });

  // The handler gates the "📎 From your notes" receipt on the verdict — a receipt
  // is shown ONLY when groundingVerdictNotice returns undefined (the answer passed
  // grounding). This pins the contract that makes that gate meaningful: an
  // ungrounded answer (a fabrication carrying a structurally-valid citation, e.g.
  // an off-topic question answered from the model's own knowledge then cited to
  // the grounded source) BOTH fires the verdict AND would otherwise render a
  // receipt — so suppressing it stops the edge from vouching for a fabrication.
  it("an ungrounded answer fires the verdict, and that same answer WOULD render a receipt without the gate (so suppression does real work)", async () => {
    const matches = [match("clipboard", "The office printer IP is 10.0.0.42.", 0.72)];
    const fabrication = "The 2018 World Cup was won by France [from clipboard].";
    const notice = await groundingVerdictNotice(fabrication, matches, "who won the 2018 world cup", async () => false);
    expect(notice).toBeDefined(); // → the handler suppresses the receipt
    const wouldShowWithoutGate = formatSourceReceipts(fabrication, "/notes", [{ file: "clipboard", text: "The office printer IP is 10.0.0.42." }], "who won the 2018 world cup");
    expect(wouldShowWithoutGate).toContain("📎 From your notes");
  });

  it("a grounded answer stays silent AND renders a receipt (the gate lets a verified answer show its work)", async () => {
    const matches = [match("clipboard", "The office printer IP is 10.0.0.42.", 0.72)];
    const grounded = "The office printer IP is 10.0.0.42 [from clipboard].";
    expect(await groundingVerdictNotice(grounded, matches, "what is the printer IP")).toBeUndefined();
    const receipt = formatSourceReceipts(grounded, "/notes", [{ file: "clipboard", text: "The office printer IP is 10.0.0.42." }], "what is the printer IP");
    expect(receipt).toContain("📎 From your notes");
  });
});

describe("groundingVerdictNotice — with injected weak-verdict re-verification", () => {
  // A weakly-relevant match (ambiguous cosine) over an otherwise-consistent answer.
  const weakMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.5)];
  const weakAnswer = "The VPN MTU is 1380 on wg0 [from notes/vpn.md].";
  const query = "what MTU for the office VPN";

  it("stays silent when the injected judge upholds a weak answer (weak → grounded)", async () => {
    const notice = await groundingVerdictNotice(weakAnswer, weakMatches, query, async () => true);
    expect(notice).toBeUndefined();
  });

  it("warns when the injected judge rejects a weak answer (weak → ungrounded)", async () => {
    const notice = await groundingVerdictNotice(weakAnswer, weakMatches, query, async () => false);
    expect(notice).toBeDefined();
    expect(notice).toContain("Grounding check");
  });

  it("fail-closes to a warning when the judge errors (no silent pass on a weak answer)", async () => {
    const notice = await groundingVerdictNotice(weakAnswer, weakMatches, query, async () => {
      throw new Error("model unreachable");
    });
    expect(notice).toBeDefined();
  });
});
