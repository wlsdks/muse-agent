/**
 * File-backed conversation store (`~/.muse/conversations.json`) — the shared
 * substrate for every surface that turns a chat exchange into an ADDRESSABLE,
 * resumable unit (CLI today; web + Telegram join the same store later).
 *
 * Mirrors `FileScheduledJobStore` (`@muse/scheduler`): delegates ALL business
 * rules (create-on-first-append, per-conversation turn cap, title
 * derivation) to a freshly-hydrated `InMemoryConversationStore` per call and
 * persists its full conversation map afterward — the file itself never
 * encodes any semantics of its own. Durability idioms match the personal
 * sidecar stores: atomic rename-based write (`atomicWriteFile`), a
 * cross-process file lock around every read-modify-write (`withFileLock` —
 * a CLI one-shot `muse chat` and a running Ink REPL are separate processes
 * that can touch the SAME file), and fail-soft-to-empty + quarantine on a
 * corrupt file (`quarantineCorruptStore`) rather than a crash.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isRecord } from "@muse/shared";

import { atomicWriteFile } from "./atomic-file-store.js";
import { withFileLock } from "./encrypted-file.js";
import { quarantineCorruptStore } from "./store-quarantine.js";

export interface ConversationTurn {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  /** ISO timestamp of this turn. Absent for turns migrated from a source that predates per-turn timestamps. */
  readonly at?: string;
  /** `true` when an ASSISTANT turn rested on UNTRUSTED-only sources (episode-laundering defense, MemoryGraft). */
  readonly untrustedOnly?: boolean;
  /** Carried on a SYSTEM session-boundary turn — the user the boundary belongs to. */
  readonly userId?: string;
}

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly origin: "cli" | "web" | "telegram" | string;
  readonly turns: readonly ConversationTurn[];
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly origin: string;
  readonly turnCount: number;
}

export type ConversationRefResolution =
  | { readonly status: "resolved"; readonly summary: ConversationSummary }
  | { readonly status: "ambiguous"; readonly candidates: readonly ConversationSummary[] }
  | { readonly status: "not-found" };

// Storage keeps more turns than the model context ever needs so a resumed
// conversation can re-run compaction over real history instead of picking up
// mid-summary; the 24-turn AI-context window stays a read-side concern.
export const MAX_TURNS_PER_CONVERSATION = 200;
const TITLE_MAX_CHARS = 40;

function deriveTitle(turns: readonly ConversationTurn[]): string {
  const source = turns.find((turn) => turn.role === "user")?.content ?? turns[0]?.content;
  if (!source) {
    return "New conversation";
  }
  const oneLine = source.replace(/\s+/gu, " ").trim();
  if (oneLine.length === 0) {
    return "New conversation";
  }
  return oneLine.length > TITLE_MAX_CHARS ? `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…` : oneLine;
}

function capTurns(turns: readonly ConversationTurn[]): readonly ConversationTurn[] {
  return turns.length > MAX_TURNS_PER_CONVERSATION ? turns.slice(turns.length - MAX_TURNS_PER_CONVERSATION) : turns;
}

/** Short, prefix-addressable id — `conv_` + 8 hex chars. */
export function newConversationId(): string {
  return `conv_${randomUUID().replace(/-/gu, "").slice(0, 8)}`;
}

export interface AppendTurnsOptions {
  readonly title?: string;
  readonly origin?: string;
  readonly now?: () => Date;
}

export class InMemoryConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  restore(conversations: readonly Conversation[]): void {
    this.conversations.clear();
    for (const conversation of conversations) {
      this.conversations.set(conversation.id, conversation);
    }
  }

  /** Full records, including turns — the persistence layer's write source. */
  all(): readonly Conversation[] {
    return [...this.conversations.values()];
  }

  list(): ConversationSummary[] {
    return [...this.conversations.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ createdAt: c.createdAt, id: c.id, origin: c.origin, title: c.title, turnCount: c.turns.length, updatedAt: c.updatedAt }));
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  newId(): string {
    return newConversationId();
  }

  /** Append turns to `id`, creating the conversation on first append. */
  appendTurns(id: string, turns: readonly ConversationTurn[], options: AppendTurnsOptions = {}): Conversation {
    const nowIso = (options.now ?? (() => new Date()))().toISOString();
    const existing = this.conversations.get(id);
    if (existing) {
      const next: Conversation = { ...existing, turns: capTurns([...existing.turns, ...turns]), updatedAt: nowIso };
      this.conversations.set(id, next);
      return next;
    }
    const created: Conversation = {
      createdAt: nowIso,
      id,
      origin: options.origin ?? "cli",
      title: options.title ?? deriveTitle(turns),
      turns: capTurns(turns),
      updatedAt: nowIso
    };
    this.conversations.set(id, created);
    return created;
  }

  /**
   * Replace a conversation's ENTIRE turn list (a full-history rewrite — used
   * by `/reset`-style clears and compaction, which both replace the whole
   * array rather than append to it). No-op (`undefined`) when `id` doesn't exist.
   */
  replaceTurns(id: string, turns: readonly ConversationTurn[], options: { readonly now?: () => Date } = {}): Conversation | undefined {
    const existing = this.conversations.get(id);
    if (!existing) {
      return undefined;
    }
    const nowIso = (options.now ?? (() => new Date()))().toISOString();
    const next: Conversation = { ...existing, turns: capTurns(turns), updatedAt: nowIso };
    this.conversations.set(id, next);
    return next;
  }

  rename(id: string, title: string): boolean {
    const existing = this.conversations.get(id);
    if (!existing) {
      return false;
    }
    this.conversations.set(id, { ...existing, title });
    return true;
  }

  delete(id: string): boolean {
    return this.conversations.delete(id);
  }
}

export function defaultConversationsFile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = env.MUSE_CONVERSATIONS_FILE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".muse", "conversations.json");
}

function reviveTurn(raw: unknown): ConversationTurn | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const role = raw.role;
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return undefined;
  }
  if (typeof raw.content !== "string") {
    return undefined;
  }
  return {
    content: raw.content,
    role,
    ...(typeof raw.at === "string" ? { at: raw.at } : {}),
    ...(raw.untrustedOnly === true ? { untrustedOnly: true } : {}),
    ...(typeof raw.userId === "string" ? { userId: raw.userId } : {})
  };
}

function reviveConversation(raw: unknown): Conversation | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  if (typeof raw.title !== "string") return undefined;
  if (typeof raw.createdAt !== "string") return undefined;
  if (typeof raw.updatedAt !== "string") return undefined;
  const origin = typeof raw.origin === "string" && raw.origin.length > 0 ? raw.origin : "cli";
  const turnsRaw = Array.isArray(raw.turns) ? raw.turns : [];
  const turns = turnsRaw.flatMap((entry): readonly ConversationTurn[] => {
    const turn = reviveTurn(entry);
    return turn ? [turn] : [];
  });
  return { createdAt: raw.createdAt, id: raw.id, origin, title: raw.title, turns, updatedAt: raw.updatedAt };
}

async function readConversationsFile(file: string): Promise<readonly Conversation[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    await quarantineCorruptStore(file);
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.conversations)) {
    await quarantineCorruptStore(file);
    return [];
  }
  return Object.values(parsed.conversations).flatMap((entry): readonly Conversation[] => {
    const conversation = reviveConversation(entry);
    return conversation ? [conversation] : [];
  });
}

async function writeConversationsFile(file: string, conversations: readonly Conversation[]): Promise<void> {
  const byId: Record<string, Conversation> = {};
  for (const conversation of conversations) {
    byId[conversation.id] = conversation;
  }
  const payload = `${JSON.stringify({ conversations: byId, version: 1 }, null, 2)}\n`;
  await atomicWriteFile(file, payload);
}

export interface FileConversationStoreOptions {
  readonly file?: string;
  /** Injectable clock, forwarded to every mutation. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export class FileConversationStore {
  private readonly file: string;
  private readonly now: (() => Date) | undefined;

  constructor(options: FileConversationStoreOptions = {}) {
    this.file = options.file && options.file.trim().length > 0 ? options.file : defaultConversationsFile();
    this.now = options.now;
  }

  private async hydrate(): Promise<InMemoryConversationStore> {
    const mem = new InMemoryConversationStore();
    mem.restore(await readConversationsFile(this.file));
    return mem;
  }

  newId(): string {
    return newConversationId();
  }

  async list(): Promise<readonly ConversationSummary[]> {
    return (await this.hydrate()).list();
  }

  async get(id: string): Promise<Conversation | undefined> {
    return (await this.hydrate()).get(id);
  }

  async appendTurns(id: string, turns: readonly ConversationTurn[], options: { readonly title?: string; readonly origin?: string } = {}): Promise<Conversation> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      const result = mem.appendTurns(id, turns, { ...options, ...(this.now ? { now: this.now } : {}) });
      await writeConversationsFile(this.file, mem.all());
      return result;
    });
  }

  async replaceTurns(id: string, turns: readonly ConversationTurn[]): Promise<Conversation | undefined> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      const result = mem.replaceTurns(id, turns, this.now ? { now: this.now } : {});
      if (result) {
        await writeConversationsFile(this.file, mem.all());
      }
      return result;
    });
  }

  async rename(id: string, title: string): Promise<boolean> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      const ok = mem.rename(id, title);
      if (ok) {
        await writeConversationsFile(this.file, mem.all());
      }
      return ok;
    });
  }

  async delete(id: string): Promise<boolean> {
    return withFileLock(this.file, async () => {
      const mem = await this.hydrate();
      const ok = mem.delete(id);
      if (ok) {
        await writeConversationsFile(this.file, mem.all());
      }
      return ok;
    });
  }
}

/**
 * Resolve a user-supplied id-or-prefix against a conversation summary list.
 * An exact id wins; otherwise a unique id-prefix match resolves. Multiple
 * prefix matches are AMBIGUOUS — fail-close and return every candidate
 * rather than acting on a guess (mirrors `resolveTaskRef`).
 */
export function resolveConversationRef(summaries: readonly ConversationSummary[], ref: string): ConversationRefResolution {
  const trimmed = ref.trim();
  if (trimmed.length === 0) {
    return { status: "not-found" };
  }
  const exact = summaries.find((s) => s.id === trimmed);
  if (exact) {
    return { status: "resolved", summary: exact };
  }
  const matches = summaries.filter((s) => s.id.startsWith(trimmed));
  if (matches.length === 1) {
    return { status: "resolved", summary: matches[0]! };
  }
  if (matches.length > 1) {
    return { status: "ambiguous", candidates: matches };
  }
  return { status: "not-found" };
}
