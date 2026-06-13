import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { inboxGroundingSources, type KnowledgeMatch } from "@muse/agent-core";
import { appendInbound, FileBackedInboxContextProvider } from "@muse/messaging";

import { formatSourceReceipts, groundingVerdictNotice, untrustedOnlyGroundingNotice } from "./commands-ask.js";

const match = (source: string, text: string, cosine: number, trusted?: boolean): KnowledgeMatch => ({
  cosine,
  score: cosine,
  source,
  text,
  ...(trusted === undefined ? {} : { trusted })
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

  it("a web-grounded --with-tools answer is NOT false-flagged once the agent's tool output is in the evidence", async () => {
    const query = "what is the capital of France";
    const answer = "The capital of France is Paris.";
    // Notes-only evidence (what the verdict had before): the answer's claim is in
    // no note → the agent's correct web answer false-flags "not backed by notes".
    const notesOnly = [match("notes/trip.md", "Booked a hotel in Lyon for the spring trip.", 0.4)];
    expect(await groundingVerdictNotice(answer, notesOnly, query)).toBeDefined();
    // WITH the agent's web-tool output added as evidence (the fix: the answer is
    // scored against what the AGENT was shown), it covers and the warning clears.
    const withToolEvidence = [...notesOnly, match("tool: web_search", "Paris is the capital and largest city of France.", 1)];
    expect(await groundingVerdictNotice(answer, withToolEvidence, query)).toBeUndefined();
  });

  it("an answer recalling a freshly-arrived inbox message is NOT false-flagged once the inbox message is in the evidence", async () => {
    const query = "did Sarah message me about anything";
    const answer = "Yes — Sarah asked you to call her back about the venue deposit.";
    // Notes-only evidence: a just-arrived inbound message lives in no note, so the
    // correct recall false-flags "not backed by your notes" without the wiring.
    const notesOnly = [match("notes/trip.md", "Booked a hotel in Lyon for the spring trip.", 0.4)];
    expect(await groundingVerdictNotice(answer, notesOnly, query)).toBeDefined();
    // WITH the injected inbox message in the evidence set (what --with-tools now
    // surfaces via groundingSources → scoredMatches), the recall grounds.
    const withInbox = [...notesOnly, match("tool: inbox/telegram", "Sarah: Can you call me back about the venue deposit?", 1)];
    expect(await groundingVerdictNotice(answer, withInbox, query)).toBeUndefined();
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

describe("untrustedOnlyGroundingNotice — grounded≠true source-trust segregation (the poisoned-source vector)", () => {
  // A faithful answer can rest ENTIRELY on untrusted provenance (MCP/web tool
  // output). The faithfulness gate stays silent (the claim DOES match its source),
  // so without this marker a confident answer resting only on poisonable
  // tool-fetched data is handed over as "grounded" with no scrutiny cue.
  it("warns when a faithful answer resolves ONLY to untrusted tool-fetched sources", () => {
    const matches = [match("tool: web_search", "The capital of France is Paris.", 1, false)];
    const answer = "The capital of France is Paris [from tool: web_search].";
    const notice = untrustedOnlyGroundingNotice(answer, matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("tool-fetched");
  });

  it("clears once a single TRUSTED source also backs the answer (one trusted citation makes it the user's own)", () => {
    const matches = [
      match("tool: web_search", "The capital of France is Paris.", 1, false),
      match("notes/geo.md", "Paris is the capital of France.", 0.8)
    ];
    const answer = "The capital of France is Paris [from tool: web_search] [from notes/geo.md].";
    expect(untrustedOnlyGroundingNotice(answer, matches)).toBeUndefined();
  });

  it("stays silent for an answer grounded only in the user's own notes (no untrusted dependence)", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72)];
    expect(untrustedOnlyGroundingNotice("Set the VPN MTU to 1380 on wg0 [from notes/vpn.md].", matches)).toBeUndefined();
  });
});

describe("inbox recall-with-citation — ingest → resolve → citeable evidence (end-to-end, real store + provider)", () => {
  it("a message ingested via the real inbox store becomes a citeable grounding source, and a recall of it grounds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-inbox-ground-"));
    const inboxFile = join(dir, "telegram-inbox.json");
    const cursorFile = join(dir, "telegram-cursor.json");
    // Ingest a real inbound message through the SAME store the poll daemon writes to.
    await appendInbound(inboxFile, {
      providerId: "telegram", messageId: "m1", source: "dm:sarah", sender: "Sarah",
      receivedAtIso: "2026-06-03T09:00:00Z", text: "Can you call me back about the venue deposit?"
    });
    // Resolve via the REAL provider — exactly the runtime path (advances the
    // injection cursor on resolve, so re-resolving must NOT re-surface it).
    const provider = new FileBackedInboxContextProvider({ sources: [{ cursorFile, inboxFile, providerId: "telegram" }] });
    const sources = inboxGroundingSources(await provider.resolve("u1"));
    expect(sources).toEqual([{ source: "inbox/telegram", text: "Sarah: Can you call me back about the venue deposit?" }]);

    // Mapped into the verdict's evidence exactly as commands-ask maps groundingSources
    // (`tool: <source>`, cosine 1), a recall of that message is grounded, not flagged.
    const query = "did Sarah message me about anything";
    const answer = "Yes — Sarah asked you to call her back about the venue deposit.";
    const notesOnly = [match("notes/trip.md", "Booked a hotel in Lyon for the spring trip.", 0.4)];
    expect(await groundingVerdictNotice(answer, notesOnly, query)).toBeDefined();
    const withInbox = [...notesOnly, ...sources.map((s) => match(`tool: ${s.source}`, s.text, 1))];
    expect(await groundingVerdictNotice(answer, withInbox, query)).toBeUndefined();

    // The single resolve advanced the cursor — a second resolve surfaces nothing
    // (no double-injection / no cursor double-advance hazard).
    expect(await provider.resolve("u1")).toBeUndefined();
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

describe("groundingVerdictNotice — reverifySamples=3 live-site contract", () => {
  const weakMatches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0 to stop handshake drops.", 0.5)];
  const weakAnswer = "The VPN MTU is 1380 on wg0 [from notes/vpn.md].";
  const query = "what MTU for the office VPN";

  it("live site (reverifySamples=3): YES-then-NO judge on a weak-band answer → warns (dissent caught)", async () => {
    let calls = 0;
    const yesNo = async () => { calls += 1; return calls === 1; };
    const notice = await groundingVerdictNotice(weakAnswer, weakMatches, query, yesNo, 3);
    expect(notice).toBeDefined();
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("live site (reverifySamples=3): all-YES judge on a weak-band answer → stays silent (unanimous pass)", async () => {
    let calls = 0;
    const allYes = async () => { calls += 1; return true; };
    const notice = await groundingVerdictNotice(weakAnswer, weakMatches, query, allYes, 3);
    expect(notice).toBeUndefined();
    expect(calls).toBe(3);
  });

  it("live site: single-sample (reverifySamples=1, default) all-YES → stays silent (back-compat)", async () => {
    const notice = await groundingVerdictNotice(weakAnswer, weakMatches, query, async () => true, 1);
    expect(notice).toBeUndefined();
  });
});
