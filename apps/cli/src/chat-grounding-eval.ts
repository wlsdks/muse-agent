import { rankKnowledgeChunks, scoreGroundingEval } from "@muse/agent-core";
import type {
  GroundingEvalCorpus,
  GroundingEvalResult,
  GroundingVerification,
  KnowledgeMatch
} from "@muse/agent-core";

import { gateChatAnswer, isChatAbstention } from "./chat-grounding.js";

/**
 * Live, scored battery for the CONVERSATIONAL surface (`muse chat`) — the one
 * the desktop companion runs exclusively, yet which had only hand-written unit
 * fixtures, never a real-retrieval round-trip. The `muse ask` wedge already has
 * `verify-faithfulness-rate`; this proves the SEPARATE, sync `gateChatAnswer`
 * path (its deterministic number / email value checks) holds against REAL
 * nomic-embed retrieval, and gates it against regression — agent-level proof,
 * not a tsc pass (agent-testing.md). English possessive framing on purpose: it
 * matches the proven retrieval calibration of the ask corpus, so a false refusal
 * here is a gate bug, never a cross-lingual retrieval miss.
 */
export const CHAT_GROUNDING_EVAL_CORPUS: GroundingEvalCorpus = {
  notes: [
    { source: "lease.md", text: "Apartment lease: monthly rent 1,250,000 KRW due on the 1st, landlord is Mr. Park." },
    { source: "vpn-wireguard.md", text: "Office VPN fix: set MTU to 1380 on the wg0 interface and restart wireguard." },
    { source: "gym.md", text: "Gym membership: 89,000 KRW per month, locker number 214, renews on the 5th." },
    { source: "wifi.md", text: "Home network: wifi SSID is Nest-5G, router admin page at 192.168.0.1." },
    { source: "passport.md", text: "Passport expires 2029-11-03; the number is kept in the safe." },
    { source: "me.md", text: "My work email is jinan@foundry.io, personal is jinan@gmail.com." }
  ],
  cases: [
    // answerable — a faithful answer grounded in a note must NOT be refused
    { kind: "answerable", query: "what is my monthly rent?", answer: "Your monthly rent is 1,250,000 KRW, due on the 1st.", note: "rent value" },
    { kind: "answerable", query: "what is my office VPN MTU?", answer: "Your office VPN MTU is 1380 on the wg0 interface.", note: "MTU value" },
    { kind: "answerable", query: "how much is my gym membership?", answer: "Your gym membership is 89,000 KRW per month.", note: "gym fee" },
    { kind: "answerable", query: "what is my home wifi SSID?", answer: "Your home wifi SSID is Nest-5G.", note: "wifi ssid (no number)" },
    { kind: "answerable", query: "when does my passport expire?", answer: "Your passport expires on 2029-11-03.", note: "passport expiry date" },
    { kind: "answerable", query: "what is my work email?", answer: "Your work email is jinan@foundry.io.", note: "work email" },

    // drift — a wrong VALUE the note doesn't contain must be caught (abstained)
    { kind: "drift", query: "what is my monthly rent?", answer: "Your monthly rent is 1,500,000 KRW, due on the 1st.", note: "wrong rent 1,500,000 vs 1,250,000" },
    { kind: "drift", query: "what is my office VPN MTU?", answer: "Your office VPN MTU is 1500 on the wg0 interface.", note: "wrong MTU 1500 vs 1380" },
    { kind: "drift", query: "what is my work email?", answer: "Your work email is jinan@acme.com.", note: "wrong email domain acme vs foundry.io" }
  ]
};

/**
 * Map the sync chat gate into the pure scorer's verify contract: a refusal
 * (`isChatAbstention`) is an `ungrounded` verdict (caught a drift / a false
 * refusal on an answerable), anything else is `grounded` (surfaced). The rubric
 * fields are unused by the scorer's verdict tally, so they carry neutral values.
 */
export function chatGateVerify(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string
): GroundingVerification {
  const gated = gateChatAnswer(query, answer, matches);
  const refused = isChatAbstention(gated);
  return {
    invalidCitations: [],
    reason: refused ? "chat gate refused (ungrounded)" : "chat gate surfaced (grounded)",
    rubric: { answerability: 1, citationValidity: 1, confidence: 1, coverage: 1 },
    verdict: refused ? "ungrounded" : "grounded"
  };
}

export interface RunChatGroundingEvalDeps {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
}

/** Wire the pure scorer to REAL recall + the live `gateChatAnswer` (no judge — the chat gate is deterministic). */
export function runChatGroundingEval(
  corpus: GroundingEvalCorpus,
  deps: RunChatGroundingEvalDeps
): Promise<GroundingEvalResult> {
  const topK = deps.topK ?? 4;
  return scoreGroundingEval(corpus, {
    rank: (query) => rankKnowledgeChunks(query, corpus.notes, { diversify: true, embed: deps.embed, hybrid: true, topK }),
    verify: (answer, matches, query) => Promise.resolve(chatGateVerify(answer, matches, query))
  });
}
