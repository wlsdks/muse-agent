/**
 * Conversation-scope capability profile — the "is this a 1:1 or a group
 * chat" gate group/shared surfaces need before TOFU pairing, memory
 * injection, or risky-tool approval touch a message (openclaw parity,
 * the sequel to the channel-owner TOFU gate).
 *
 * Fail-close by construction: `InboundMessage.scope` is optional because
 * most providers can't always tell (a Discord REST channel fetch has no
 * DM/guild signal), and an unknown/absent/malformed value must NEVER be
 * treated as the safer 1:1 posture. Only the exact literal `"direct"`
 * downgrades to direct; everything else — `undefined`, `"shared"`, a
 * future scope value, a typo — resolves to `"shared"`.
 */

export type ConversationScope = "direct" | "shared";

export function effectiveScope(scope: string | undefined): ConversationScope {
  return scope === "direct" ? "direct" : "shared";
}
