/**
 * A compact, bounded "knows-you" snapshot for the channel chat fast-path
 * (S3, `createComposeChatReply`) — the same `UserMemoryStore` the CLI's
 * `buildMusePersona` reads from, reduced to a handful of citable lines so a
 * small-talk turn can draw on real facts instead of answering as a stranger.
 *
 * Scope discipline (P7-3, `inbound-agent-run.ts`): personal facts are the
 * paired owner's 1:1 memory ONLY. A shared/group chat's scope
 * (`${providerId}:shared:${source}`) never reads or receives this snapshot —
 * enforced HERE, not just by the caller, so a future call site can't
 * accidentally leak it into a group turn.
 */

import type { UserMemory, UserMemoryStore } from "@muse/memory";
import type { ConversationScope } from "@muse/messaging";
import type { ChatGroundingSource } from "@muse/recall";

/** Hard cap on rendered lines — keeps the channel system prompt small on local Qwen. */
const MAX_SNAPSHOT_LINES = 10;
/** A single value longer than this is truncated so one oversized fact can't eat the whole budget. */
const MAX_VALUE_LENGTH = 100;
/** Rendered first, ahead of other facts, when present — the two atoms a casual reply most benefits from. */
const PRIORITY_FACT_KEYS = ["name", "language"];

function clip(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_VALUE_LENGTH ? `${trimmed.slice(0, MAX_VALUE_LENGTH)}…` : trimmed;
}

function renderEntries(
  kind: "fact" | "preference" | "topic",
  entries: readonly (readonly [string, string])[],
  lines: ChatGroundingSource[]
): void {
  for (const [key, value] of entries) {
    if (lines.length >= MAX_SNAPSHOT_LINES) return;
    const clipped = clip(value);
    if (clipped.length === 0) continue;
    lines.push({
      source: `persona:${kind}:${key}`,
      text: kind === "topic" ? `recent topic: ${clipped}` : `${key}: ${clipped}`
    });
  }
}

/**
 * `null` means "no personalization for this turn" — either the scope
 * forbids it (shared/group) or the store is unavailable/unreadable/empty.
 * A non-null result is always an array bounded to `MAX_SNAPSHOT_LINES`,
 * possibly empty (owner scope, genuinely no facts stored yet). Callers
 * fail-open identically either way: `snapshot ?? []`.
 */
export async function loadChatPersonaSnapshot(input: {
  readonly userMemoryStore: UserMemoryStore | undefined;
  readonly providerId: string;
  readonly source: string;
  readonly scope: ConversationScope;
}): Promise<readonly ChatGroundingSource[] | null> {
  if (input.scope === "shared" || !input.userMemoryStore) {
    return null;
  }
  // SAME scope the auto-extract hook writes to and `inbound-agent-run.ts`
  // passes as `metadata.userId` for the owner scope — one shared identity
  // for "the facts this channel identity has taught Muse".
  const userId = `${input.providerId}:${input.source}`;
  let memory: UserMemory | undefined;
  try {
    memory = await Promise.resolve(input.userMemoryStore.findByUserId(userId));
  } catch {
    return null;
  }
  if (!memory) {
    return null;
  }
  const facts = Object.entries(memory.facts ?? {}).filter(([, value]) => typeof value === "string");
  // Preferences split the same way `buildMusePersona` does: `veto:`/`goal:`
  // slots are behavioral guardrails, not the kind of small-talk fact a
  // casual reply should surface, so only the plain preferences count here.
  const preferences = Object.entries(memory.preferences ?? {})
    .filter(([key, value]) => typeof value === "string" && !key.startsWith("veto:") && !key.startsWith("goal:"));
  const factsByKey = new Map(facts);
  // Ordered by PRIORITY_FACT_KEYS itself (name, then language), not by the
  // store's insertion order — a name/language section that flipped order
  // between users would be a confusing, hard-to-test inconsistency.
  const priorityFacts = PRIORITY_FACT_KEYS
    .filter((key) => factsByKey.has(key))
    .map((key) => [key, factsByKey.get(key)!] as const);
  const otherFacts = facts.filter(([key]) => !PRIORITY_FACT_KEYS.includes(key));
  // Freshest topic first — recentTopics is append-order (oldest-first), same
  // convention `buildMusePersona`'s recentTopics slice relies on.
  const recentTopics = [...(memory.recentTopics ?? [])].reverse().map((topic, index) => [String(index), topic] as const);

  const lines: ChatGroundingSource[] = [];
  renderEntries("fact", priorityFacts, lines);
  renderEntries("fact", otherFacts, lines);
  renderEntries("preference", preferences, lines);
  renderEntries("topic", recentTopics, lines);
  return lines;
}
