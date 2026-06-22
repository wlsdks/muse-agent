/**
 * Deterministic non-RAG short-circuit constants for `muse ask` — the
 * on-brand replies a pure social / capability / action prompt gets
 * BEFORE any retrieval or model call. Pulled out of the command handler
 * so they can be unit-tested directly.
 */

import type { CasualPromptKind } from "@muse/agent-core";

// Instant, on-brand replies for a PURE social prompt — so a bare "hi" / "thanks"
// gets a clean conversational line instead of the empty-corpus on-ramp + a
// fabricated `[action: …]` citation + a "treat as unverified" grounding warning.
// Deterministic (no model call, no retrieval), so it is also the fastest path.
export const CASUAL_RESPONSES: Record<CasualPromptKind, string> = {
  farewell: "Take care — I'll be here when you need your notes.",
  greeting: "Hi! I answer from your own notes — ask me anything you've saved and I'll quote the source, or tell you honestly when it isn't there.",
  thanks: "You're welcome."
};

// An ACCURATE, honest description of what Muse actually does — so a "what can
// you do?" question doesn't make the local model free-compose an OVER-CLAIMED
// answer ("I can manage your schedule…") that then gets a grounding warning.
// Honesty about its OWN capabilities is the same edge as honesty about recall.
export const META_RESPONSE =
  "I answer questions from your own notes and quote the exact source — and I tell you \"I'm not sure\" instead of guessing. " +
  "Everything runs locally on your machine; nothing leaves. " +
  "Add notes with `muse read <file> --save-to-notes <id>`, then ask me anything you've saved — or run `muse demo` to see a cited answer and an honest refusal in about 30 seconds.";

// Honest guide for an action request on the chat-only path — so Muse never says
// "I'll remind you…" without actually doing it (a false promise).
export const ACTION_GUIDE =
  "That's something to DO, not a question — and on this path I can only read and answer, so I won't pretend to have done it. " +
  "Re-run with `--with-tools` and I'll actually do it (I show the exact action and ask before any outbound send or change). " +
  "Reads stay silent; writes/sends always ask first.";
