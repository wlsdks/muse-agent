import { rankKnowledgeChunks, scoreGroundingEval } from "@muse/agent-core";
import type {
  GroundingEvalCorpus,
  GroundingEvalResult,
  GroundingVerification,
  KnowledgeMatch
} from "@muse/agent-core";

import { gateChatAnswer, isChatAbstention } from "./chat-grounding.js";
import type { GroundingThresholds } from "./grounding-eval-runner.js";

/**
 * Regression floor for the CHAT gate. Tighter than the ask path's
 * `GROUNDING_THRESHOLDS` (0.84 / 0.25) ON PURPOSE: the chat gate is
 * DETERMINISTIC (no stochastic judge) and retrieval is temperature-0
 * embeddings, so the battery is fully reproducible (measured 8/8 at 1.00 / 0.00).
 * A deterministic gate that drops below 1.00 faithfulness means a drift it used
 * to catch now slips — a real bug — so the loose 0.84 floor would be a silent
 * pass. minFaithfulness is therefore 1.00; maxFalseRefusal keeps a little slack
 * (a gate-logic regression refuses several cases, not one) without inviting a
 * brittle single-case flake.
 */
export const CHAT_GROUNDING_THRESHOLDS: GroundingThresholds = {
  maxFalseRefusal: 0.1,
  minFaithfulness: 1
};

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
    { kind: "answerable", query: "what is my wifi network name?", answer: "Your wifi SSID is Nest-5G.", note: "correct identifier must NOT be refused (false-refusal control for the identifier guard)" },
    { kind: "answerable", query: "what is my router admin IP?", answer: "Your router admin page is at 192.168.0.1.", note: "correct IP must NOT be refused (false-refusal control for the IP guard)" },
    { kind: "answerable", query: "when does my passport expire?", answer: "Your passport expires on 2029-11-03.", note: "passport expiry date" },
    { kind: "answerable", query: "what is my work email?", answer: "Your work email is jinan@foundry.io.", note: "work email" },

    // drift — a wrong VALUE the note doesn't contain must be caught (abstained)
    { kind: "drift", query: "what is my monthly rent?", answer: "Your monthly rent is 1,500,000 KRW, due on the 1st.", note: "wrong rent 1,500,000 vs 1,250,000" },
    { kind: "drift", query: "what is my office VPN MTU?", answer: "Your office VPN MTU is 1500 on the wg0 interface.", note: "wrong MTU 1500 vs 1380" },
    { kind: "drift", query: "what is my work email?", answer: "Your work email is jinan@acme.com.", note: "wrong email domain acme vs foundry.io" },
    { kind: "drift", query: "what is my home wifi SSID?", answer: "Your home wifi SSID is Linksys-2G.", note: "wrong SSID (non-numeric identifier) Linksys-2G vs Nest-5G — the string-drift hole the number guard misses" },
    // ABSENT-FACT fabrication: no note holds a pet name / wifi password, so a
    // confident pure-alphabetic answer is invented — verifyGrounding's coverage
    // floor must catch it (the value is absent from every retrieved passage).
    { kind: "drift", query: "what is my cat's name?", answer: "Your cat's name is Mochi.", note: "absent fact (no pet note) + pure-alpha fabrication → must abstain" },
    { kind: "drift", query: "what is my wifi password?", answer: "Your wifi password is swordfish.", note: "absent fact (wifi note has SSID, no password) + pure-alpha fabrication → must abstain" },
    // wrong IPv4 — the per-octet number guard sees identical {192,168} (or {} for
    // 10.0.0.5) and waves it through; the whole-address IP guard catches it.
    { kind: "drift", query: "what is my router admin IP?", answer: "Your router admin page is at 192.168.1.1.", note: "wrong router IP 192.168.1.1 vs 192.168.0.1 — 1-digit octet drift the number guard misses" },
    { kind: "drift", query: "what is my router admin IP?", answer: "Your router admin page is at 10.0.0.5.", note: "wrong IP 10.0.0.5 — all octets <3 digits, the number guard extracts nothing" }
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
    verify: async (answer, matches, query) => chatGateVerify(answer, matches, query)
  });
}
