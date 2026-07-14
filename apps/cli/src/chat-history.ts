/**
 * Persistent chat-session helpers for the `muse chat -c` REPL.
 *
 * Turns are stored in the shared `@muse/stores` conversation store
 * (`~/.muse/conversations.json` — one record per conversation, each holding
 * its own `turns` array) so a conversation is an ADDRESSABLE, resumable unit
 * (`muse chats`) instead of a single flat file. Every helper below reads or
 * writes the ACTIVE conversation — the one `~/.muse/active-conversation.json`
 * currently points at — so every existing caller (the Ink REPL, the one-shot
 * `--continue` local chat, the end-of-session episode pipeline) keeps
 * working against "the conversation in progress" without knowing conversations
 * exist as a concept.
 *
 *   - `readLastChatHistory()` returns the last HISTORY_TURN_LIMIT*2 user/
 *     assistant turns of the active conversation (unchanged AI-context
 *     contract: the model sees the same window it always did).
 *   - `appendLastChatTurn` appends a redacted user+assistant pair.
 *   - Once a conversation grows past HISTORY_COMPACT_THRESHOLD turns,
 *     `maybeCompactLastChatHistory` summarises the old head into one
 *     `(Previous-conversation summary)` turn and keeps the recent tail
 *     verbatim — JARVIS doesn't forget; it abstracts.
 *   - `[SESSION_BOUNDARY]` sentinel turns (`appendSessionBoundary` /
 *     `readSessionBoundaries`) mark where a REPL session started, consumed
 *     by the end-of-session episode extractor (chat-end-session.ts).
 *
 * ONE-TIME MIGRATION: the very first time any of these helpers resolves "the
 * active conversation" and finds the store empty, it imports the legacy
 * `~/.muse/last-chat.jsonl` flat file (if present) as a conversation titled
 * "imported from last-chat", then renames the legacy file to
 * `last-chat.jsonl.migrated` (never deleted — the bytes stay recoverable).
 * Idempotent: a non-empty store is the guard, so a second boot never
 * re-imports even if the active-conversation pointer is itself missing.
 *
 * `~/.muse/activity.jsonl` — one JSONL line per REPL start / chat turn — is
 * a SEPARATE, unrelated surface (unchanged): the `muse routine` aggregator
 * reads it to learn active hours.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  defaultActiveConversationFile,
  defaultConversationsFile,
  FileConversationStore,
  newConversationId,
  readActiveConversationId,
  resolveConversationRef,
  writeActiveConversationId,
  type Conversation,
  type ConversationRefResolution,
  type ConversationSummary,
  type ConversationTurn
} from "@muse/stores";
import { redactSecretsInText, resolveHomeDir } from "@muse/shared";

import { isRecord } from "./credential-store.js";

const HISTORY_TURN_LIMIT = 12;
// Turn counts above this many turns in the active conversation trigger an
// LLM compaction pass at REPL boot. The compacted conversation then holds a
// single synthesized "summary" turn plus the last HISTORY_TURN_LIMIT * 2
// verbatim turns.
export const HISTORY_COMPACT_THRESHOLD = 60;
// Sentinel content the REPL writes at boot to mark a session break in the
// active conversation. The episodic-memory extractor (later step) reads
// from the most-recent boundary to the end to know which range belongs to
// the just-finished session. `readLastChatHistory` ignores it because the
// role is `system`, not user/assistant — so seed-history paths stay clean
// while the boundary remains discoverable.
export const SESSION_BOUNDARY_CONTENT = "[SESSION_BOUNDARY]";

export interface LastChatLine {
  readonly role: "user" | "assistant";
  readonly content: string;
  /**
   * `true` when this ASSISTANT turn rested on UNTRUSTED-only sources. Persisted so
   * a later end-of-session episode capture marks the episode `trusted:false` even
   * for turns from a prior process (one-shot `muse chat` / resumed session) — the
   * episode-laundering defense (MemoryGraft arXiv:2512.16962). Absent ⇒ trusted.
   */
  readonly untrustedOnly?: boolean;
}

export interface ActivityEvent {
  readonly kind: "repl-start" | "chat-turn";
  readonly userId: string;
  readonly tsIso?: string;
}

/** The legacy flat-file path — only read now during the one-time migration. */
export function lastChatHistoryPath(): string {
  return path.join(resolveHomeDir(), ".muse", "last-chat.jsonl");
}

export function activityLogPath(): string {
  return path.join(resolveHomeDir(), ".muse", "activity.jsonl");
}

function conversationStore(): FileConversationStore {
  return new FileConversationStore({ file: defaultConversationsFile() });
}

function activePointerFile(): string {
  return defaultActiveConversationFile();
}

/**
 * Read the legacy `last-chat.jsonl` and convert its lines into
 * `ConversationTurn`s. Returns `undefined` when the file doesn't exist —
 * "nothing to migrate", not an error.
 */
async function readLegacyLastChatTurns(): Promise<readonly ConversationTurn[] | undefined> {
  let raw: string;
  try {
    raw = await readFile(lastChatHistoryPath(), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  const turns: ConversationTurn[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!isRecord(parsed)) continue;
      const role = parsed.role;
      if ((role !== "user" && role !== "assistant" && role !== "system") || typeof parsed.content !== "string") {
        continue;
      }
      turns.push({
        content: parsed.content,
        role,
        ...(typeof parsed.tsIso === "string" ? { at: parsed.tsIso } : {}),
        ...(parsed.untrustedOnly === true ? { untrustedOnly: true } : {}),
        ...(typeof parsed.userId === "string" ? { userId: parsed.userId } : {})
      });
    } catch { /* skip malformed lines */ }
  }
  return turns;
}

/**
 * One-time import: legacy file present + store empty → create a
 * conversation titled "imported from last-chat" and rename the legacy file
 * aside (`.migrated`, never deleted). Returns the new conversation's id, or
 * `undefined` when there was nothing to migrate.
 */
async function migrateLegacyLastChatIfPresent(): Promise<string | undefined> {
  const legacyTurns = await readLegacyLastChatTurns();
  if (legacyTurns === undefined) {
    return undefined;
  }
  const id = newConversationId();
  await conversationStore().appendTurns(id, legacyTurns, { origin: "cli", title: "imported from last-chat" });
  await rename(lastChatHistoryPath(), `${lastChatHistoryPath()}.migrated`).catch(() => undefined);
  return id;
}

/**
 * Resolve (and persist) the active conversation id: the pointer file's value
 * if it names ONE (trusted as-is — it may legitimately name a conversation
 * that doesn't exist YET, e.g. right after `startNewConversation()`;
 * `appendTurns` creates it lazily on first use, matching AC1's "creates on
 * first append"); otherwise the most-recently updated existing conversation;
 * otherwise a legacy-file migration; otherwise a brand-new id.
 */
async function ensureActiveConversationId(): Promise<string> {
  const pointerFile = activePointerFile();
  const pointer = await readActiveConversationId(pointerFile);
  if (pointer) {
    return pointer;
  }
  const summaries = await conversationStore().list();
  if (summaries.length > 0) {
    const mostRecent = summaries[0]!.id;
    await writeActiveConversationId(mostRecent, pointerFile);
    return mostRecent;
  }
  const migratedId = await migrateLegacyLastChatIfPresent();
  const activeId = migratedId ?? newConversationId();
  await writeActiveConversationId(activeId, pointerFile);
  return activeId;
}

/** The id the active-conversation pointer currently names (read-only; triggers migration if needed). */
export async function activeConversationId(): Promise<string> {
  return ensureActiveConversationId();
}

/** `muse chats` / `/sessions` listing: every conversation, newest first. */
export async function listConversations(): Promise<readonly ConversationSummary[]> {
  return conversationStore().list();
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  return conversationStore().get(id);
}

/**
 * Resolve `ref` (an id or unambiguous prefix) against the conversation
 * list and, on success, POINT the active conversation at it. Ambiguous or
 * unknown refs fail-close — the pointer is left untouched.
 */
export async function resumeConversation(ref: string): Promise<ConversationRefResolution> {
  const summaries = await conversationStore().list();
  const resolution = resolveConversationRef(summaries, ref);
  if (resolution.status === "resolved") {
    await writeActiveConversationId(resolution.summary.id, activePointerFile());
  }
  return resolution;
}

/** `/new` / one-shot fresh start: point the active pointer at a brand-new (not-yet-persisted) conversation id. */
export async function startNewConversation(): Promise<string> {
  const id = newConversationId();
  await writeActiveConversationId(id, activePointerFile());
  return id;
}

export async function renameConversation(id: string, title: string): Promise<boolean> {
  return conversationStore().rename(id, title);
}

/**
 * Delete `id`. When it was the active conversation, the pointer falls back
 * to the most-recently-updated survivor, or a fresh (not-yet-persisted) id
 * when none remain — so the REPL/CLI always has a valid active conversation
 * to write into next. No collateral: every OTHER conversation is untouched.
 */
export async function deleteConversation(id: string): Promise<{ readonly deleted: boolean; readonly activeId: string }> {
  const store = conversationStore();
  const deleted = await store.delete(id);
  const currentActive = await readActiveConversationId(activePointerFile());
  if (!deleted || currentActive !== id) {
    return { activeId: await ensureActiveConversationId(), deleted };
  }
  const remaining = await store.list();
  const fallbackId = remaining[0]?.id ?? newConversationId();
  await writeActiveConversationId(fallbackId, activePointerFile());
  return { activeId: fallbackId, deleted };
}

export async function readLastChatHistory(): Promise<readonly LastChatLine[]> {
  const id = await ensureActiveConversationId();
  const conversation = await conversationStore().get(id);
  const lines: LastChatLine[] = [];
  for (const turn of conversation?.turns ?? []) {
    if ((turn.role !== "user" && turn.role !== "assistant") || turn.content.length === 0) continue;
    lines.push({
      content: turn.content,
      role: turn.role,
      ...(turn.untrustedOnly === true ? { untrustedOnly: true } : {})
    });
  }
  return lines.slice(-HISTORY_TURN_LIMIT * 2);
}

export async function appendLastChatTurn(turn: {
  readonly message: string;
  readonly response: string;
  /** `true` when this answer rested on untrusted-only sources — persisted on the
   *  assistant line so episode capture can mark the episode trusted:false even for
   *  one-shot / resumed turns (episode-laundering defense, MemoryGraft). */
  readonly responseUntrusted?: boolean;
}): Promise<void> {
  const id = await ensureActiveConversationId();
  const nowIso = new Date().toISOString();
  // Scrub before the write so a leaked secret doesn't persist on disk and
  // round-trip back into the model on --continue.
  await conversationStore().appendTurns(id, [
    { at: nowIso, content: redactSecretsInText(turn.message), role: "user" },
    {
      at: nowIso,
      content: redactSecretsInText(turn.response),
      role: "assistant",
      ...(turn.responseUntrusted === true ? { untrustedOnly: true } : {})
    }
  ]);
}

/** `--reset` / mid-REPL reset: clears the ACTIVE conversation's turns in place (same id, same title). */
export async function clearLastChatHistory(): Promise<void> {
  const id = await ensureActiveConversationId();
  await conversationStore().replaceTurns(id, []);
}

export interface SessionBoundary {
  readonly tsIso: string;
  readonly userId?: string;
}

/**
 * Append a `[SESSION_BOUNDARY]` marker to the active conversation. Called
 * once per REPL boot, before any seed read. Step 2 of
 * docs/design/episodic-memory.md — the later end-of-session summariser hook
 * scans from the most recent boundary to the end.
 *
 * The turn uses role: "system" so `readLastChatHistory`'s user|assistant
 * filter silently drops it — the seed history a fresh REPL sees stays
 * clean, but the boundary remains discoverable via `readSessionBoundaries`.
 */
export async function appendSessionBoundary(event: SessionBoundary = { tsIso: new Date().toISOString() }): Promise<void> {
  const id = await ensureActiveConversationId();
  await conversationStore().appendTurns(id, [
    {
      at: event.tsIso,
      content: SESSION_BOUNDARY_CONTENT,
      role: "system",
      ...(event.userId ? { userId: event.userId } : {})
    }
  ]);
}

/**
 * Return every `[SESSION_BOUNDARY]` turn in the active conversation, oldest
 * first. The end-of-session summariser hook (step 3) reads this to find
 * where the current session began. Returns `[]` when the active
 * conversation has no boundaries yet.
 */
export async function readSessionBoundaries(): Promise<readonly SessionBoundary[]> {
  const id = await ensureActiveConversationId();
  const conversation = await conversationStore().get(id);
  const boundaries: SessionBoundary[] = [];
  for (const turn of conversation?.turns ?? []) {
    if (turn.role === "system" && turn.content === SESSION_BOUNDARY_CONTENT && typeof turn.at === "string") {
      boundaries.push({ tsIso: turn.at, ...(turn.userId ? { userId: turn.userId } : {}) });
    }
  }
  return boundaries;
}

export async function appendActivity(event: ActivityEvent): Promise<void> {
  const filePath = activityLogPath();
  const stamped = { ...event, tsIso: event.tsIso ?? new Date().toISOString() };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stamped)}\n`, { flag: "a", mode: 0o600 });
}

/**
 * If the active conversation has grown past HISTORY_COMPACT_THRESHOLD
 * turns, summarize the older portion via a one-shot model call and rewrite
 * its turns to: [{ role: "system", content: "(summary)" }, ...last
 * HISTORY_TURN_LIMIT * 2 verbatim turns].
 *
 * Best-effort — extraction failures leave the conversation untouched, so a
 * network glitch never loses chat memory.
 */
export async function maybeCompactLastChatHistory(
  modelProvider: {
    stream(request: {
      readonly model: string;
      readonly messages: readonly { readonly role: string; readonly content: string }[];
    }): AsyncIterable<{ readonly type: string; readonly text?: string }>;
  },
  model: string
): Promise<{ readonly compacted: boolean; readonly dropped: number; readonly summary?: string }> {
  const id = await ensureActiveConversationId();
  const conversation = await conversationStore().get(id);
  const turns = conversation?.turns ?? [];
  if (turns.length <= HISTORY_COMPACT_THRESHOLD) {
    return { compacted: false, dropped: 0 };
  }
  const keepRecent = HISTORY_TURN_LIMIT * 2;
  const older = turns.slice(0, turns.length - keepRecent);
  const recent = turns.slice(-keepRecent);
  const olderText = older.map((turn) => `${turn.role}: ${capContentForSummary(turn.content, 400)}`).join("\n");

  let summary = "";
  try {
    for await (const ev of modelProvider.stream({
      messages: [
        {
          content:
            "Summarise the following multi-turn user↔assistant chat as one short paragraph (≤ 200 chars). " +
            "Preserve names, decisions, follow-up items. Plain text, no quotes, no JSON.",
          role: "system"
        },
        { content: olderText, role: "user" }
      ],
      model
    })) {
      if (ev.type === "text-delta" && typeof ev.text === "string") {
        summary += ev.text;
      }
    }
  } catch {
    return { compacted: false, dropped: 0 };
  }
  const rawSummary = summary.trim();
  if (rawSummary.length === 0) {
    return { compacted: false, dropped: 0 };
  }
  // Re-scrub: the model can hallucinate a credential-shaped
  // string into the summary even though the input turns were
  // already redacted on disk.
  const trimmedSummary = redactSecretsInText(rawSummary);
  const nextTurns: ConversationTurn[] = [
    { at: new Date().toISOString(), content: `(Previous-conversation summary) ${trimmedSummary}`, role: "system" },
    ...recent
  ];
  await conversationStore().replaceTurns(id, nextTurns);
  return { compacted: true, dropped: older.length, summary: trimmedSummary };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return isRecord(value) && typeof (value as { code?: unknown }).code === "string";
}

export function capContentForSummary(value: string, cap: number): string {
  const head = value.slice(0, cap);
  if (head.length === 0) return head;
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}
