import { type KnowledgeMatch } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { citationPrecisionNotice, citationRecallNotice, untrustedOnlyGroundingNotice } from "./grounding-notices.js";

const match = (source: string, text: string, cosine: number, trusted?: boolean): KnowledgeMatch => ({
  cosine,
  score: cosine,
  source,
  text,
  ...(trusted === undefined ? {} : { trusted })
});

describe("untrustedOnlyGroundingNotice", () => {
  it("warns when a faithful answer resolves ONLY to untrusted tool-fetched sources", () => {
    const matches = [match("tool: web_search", "The capital of France is Paris.", 1, false)];
    const notice = untrustedOnlyGroundingNotice("The capital of France is Paris [from tool: web_search].", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("tool-fetched");
  });

  it("stays silent for an answer grounded only in the user's own notes", () => {
    const matches = [match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72)];
    expect(untrustedOnlyGroundingNotice("Set the VPN MTU to 1380 on wg0 [from notes/vpn.md].", matches)).toBeUndefined();
  });

  it("surfaces a per-claim untrusted source in a MIXED answer — whole-answer gate clears on a trusted note, but one claim rests only on tool data", () => {
    const matches = [
      match("notes/vpn.md", "The office VPN needs MTU 1380 on wg0.", 0.72), // trusted note
      match("tool: web_search", "Paris is the capital of France.", 1, false) // untrusted tool source
    ];
    const answer = "Set the VPN MTU to 1380 on wg0 [from notes/vpn.md]. Paris is the capital of France [from tool: web_search].";
    const notice = untrustedOnlyGroundingNotice(answer, matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("one claim rests only on tool-fetched data"); // the per-claim notice, not the whole-answer one
    expect(notice).toContain("Paris is the capital of France"); // the specific untrusted claim is surfaced
  });
});

describe("citationPrecisionNotice", () => {
  it("warns when a cited source resolves but does not support its sentence", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    const notice = citationPrecisionNotice("The office MTU is 1380 [from vpn.md]. The flight departs from gate twelve [from vpn.md].", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("Citation check");
  });

  it("stays silent when every cited source supports its sentence", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    expect(citationPrecisionNotice("The office MTU is 1380 [from vpn.md].", matches)).toBeUndefined();
  });
});

describe("citationRecallNotice", () => {
  it("warns when a citable claim carries no citation", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    const notice = citationRecallNotice("The office MTU is 1380.", matches);
    expect(notice).toBeDefined();
    expect(notice).toContain("Attribution check");
  });

  it("stays silent when the citable claim carries its citation", () => {
    const matches = [match("vpn.md", "the office vpn mtu is 1380 on wg0", 0.7)];
    expect(citationRecallNotice("The office MTU is 1380 [from vpn.md].", matches)).toBeUndefined();
  });
});
