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

/** The canned reply for a classified casual-prompt kind. */
export function casualResponseFor(kind: CasualPromptKind): string {
  return CASUAL_RESPONSES[kind];
}
