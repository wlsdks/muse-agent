import { scoreGroundingEval } from "@muse/agent-core";
import type { KnowledgeMatch } from "@muse/agent-core";
import { describe, expect, it } from "vitest";

import { CHAT_GROUNDING_EVAL_CORPUS, chatGateVerify } from "./chat-grounding-eval.js";

// Deterministic stand-in for live retrieval: hand every query the full note set
// as confident matches, so the scorer exercises the chat gate's verdict logic
// (number / email value checks) with no embeddings. The live script proves the
// same corpus against REAL nomic retrieval.
const allNotes: KnowledgeMatch[] = CHAT_GROUNDING_EVAL_CORPUS.notes.map((note) => ({
  cosine: 0.7,
  score: 0.7,
  source: note.source,
  text: note.text
}));

describe("chatGateVerify — maps the sync chat gate into the scorer's verdict contract", () => {
  it("a refused (abstained) answer is ungrounded", () => {
    const note: KnowledgeMatch = { cosine: 0.7, score: 0.7, source: "vpn.md", text: "MTU is 1380" };
    expect(chatGateVerify("Your VPN MTU is 1500.", [note], "what is my VPN MTU?").verdict).toBe("ungrounded");
  });
  it("a surfaced answer is grounded", () => {
    const note: KnowledgeMatch = { cosine: 0.7, score: 0.7, source: "vpn.md", text: "MTU is 1380" };
    expect(chatGateVerify("Your VPN MTU is 1380.", [note], "what is my VPN MTU?").verdict).toBe("grounded");
  });
});

describe("CHAT_GROUNDING_EVAL_CORPUS — the chat gate catches drift and never false-refuses (deterministic)", () => {
  it("faithfulness 1.0 (all drift caught) and false-refusal 0.0 (no answerable refused)", async () => {
    const result = await scoreGroundingEval(CHAT_GROUNDING_EVAL_CORPUS, {
      rank: () => Promise.resolve(allNotes),
      verify: (answer, matches, query) => Promise.resolve(chatGateVerify(answer, matches, query))
    });
    expect(result.faithfulnessRate).toBe(1);
    expect(result.falseRefusalRate).toBe(0);
    expect(result.drift).toBeGreaterThanOrEqual(3);
    expect(result.answerable).toBeGreaterThanOrEqual(6);
  });
});
