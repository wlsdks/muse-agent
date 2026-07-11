import type { CasualPromptKind } from "./casual-prompt.js";

// Instant, on-brand replies for a PURE social prompt — so a bare "hi" / "thanks"
// gets a clean conversational line instead of the empty-corpus on-ramp + a
// fabricated `[action: …]` citation the gate then strips + a "treat as
// unverified" grounding warning. Deterministic (no model call, no
// retrieval), so it is also the fastest path — shared by every surface
// (`muse ask`, channel replies) that runs `classifyCasualPrompt` first.
const CASUAL_RESPONSES: Record<CasualPromptKind, string> = {
  farewell: "Take care — I'll be here when you need your notes.",
  greeting: "Hi! I answer from your own notes — ask me anything you've saved and I'll quote the source, or tell you honestly when it isn't there.",
  thanks: "You're welcome."
};

// classifyCasualPrompt already matches Korean greetings/thanks/farewells, but
// the reply text was English-only, so a Korean "안녕~" got an English answer.
// Same intent as the EN set above (quotes the source, admits when it isn't
// there, plain thanks) — no new promises, just the Korean half of the parity.
const CASUAL_RESPONSES_KO: Record<CasualPromptKind, string> = {
  farewell: "잘 가! 노트가 필요할 때 내가 여기 있을게.",
  greeting: "안녕! 네가 저장한 노트에서 답할게 — 뭐든 물어봐. 출처를 그대로 알려주고, 없으면 솔직하게 말할게.",
  thanks: "천만에!"
};

const HANGUL_RE = /[가-힣]/u;

/** True when `text` contains at least one Hangul syllable — the deterministic signal for a Korean turn. */
export function containsHangul(text: string): boolean {
  return HANGUL_RE.test(text);
}

/** The canned reply for a classified casual-prompt kind, in Korean when `korean` is true (default English). */
export function casualResponseFor(kind: CasualPromptKind, korean = false): string {
  return (korean ? CASUAL_RESPONSES_KO : CASUAL_RESPONSES)[kind];
}
