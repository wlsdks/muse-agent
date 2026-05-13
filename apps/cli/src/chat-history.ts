/**
 * Persistent chat-session helpers for the `muse chat -c` REPL.
 *
 * Two on-disk surfaces live here:
 *
 *   - `~/.muse/last-chat.jsonl` — one JSONL line per turn
 *     ({ role: "user" | "assistant", content }). The REPL appends
 *     and trims via HISTORY_TURN_LIMIT; once the file grows past
 *     HISTORY_COMPACT_THRESHOLD, `maybeCompactLastChatHistory`
 *     summarises the head into a single `(Previous-conversation
 *     summary)` line and keeps the recent tail verbatim. JARVIS
 *     doesn't forget; it abstracts.
 *
 *   - `~/.muse/activity.jsonl` — one JSONL line per REPL start /
 *     chat turn. The `muse routine` aggregator reads it to learn
 *     active hours and write the `routine_active_hours` fact back
 *     into user memory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./credential-store.js";

export const HISTORY_TURN_LIMIT = 12;
// Files larger than this many lines (each turn = 1 line, so 60 lines =
// 30 turns) trigger an LLM compaction pass at REPL boot. The compacted
// file then holds a single synthesized "summary" entry plus the last
// HISTORY_TURN_LIMIT * 2 verbatim turns.
export const HISTORY_COMPACT_THRESHOLD = 60;

export interface LastChatLine {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ActivityEvent {
  readonly kind: "repl-start" | "chat-turn";
  readonly userId: string;
  readonly tsIso?: string;
}

export function lastChatHistoryPath(): string {
  const home = process.env.HOME ?? "~";
  return path.join(home, ".muse", "last-chat.jsonl");
}

export function activityLogPath(): string {
  const home = process.env.HOME ?? "~";
  return path.join(home, ".muse", "activity.jsonl");
}

export async function readLastChatHistory(): Promise<readonly LastChatLine[]> {
  const filePath = lastChatHistoryPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const lines: LastChatLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        isRecord(parsed)
        && (parsed.role === "user" || parsed.role === "assistant")
        && typeof parsed.content === "string"
        && parsed.content.length > 0
      ) {
        lines.push({ content: parsed.content, role: parsed.role });
      }
    } catch { /* skip malformed lines */ }
  }
  return lines.slice(-HISTORY_TURN_LIMIT * 2);
}

export async function appendLastChatTurn(turn: { readonly message: string; readonly response: string }): Promise<void> {
  const filePath = lastChatHistoryPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const payload =
    `${JSON.stringify({ content: turn.message, role: "user" })}\n` +
    `${JSON.stringify({ content: turn.response, role: "assistant" })}\n`;
  await writeFile(filePath, payload, { flag: "a", mode: 0o600 });
}

export async function clearLastChatHistory(): Promise<void> {
  const filePath = lastChatHistoryPath();
  try {
    await writeFile(filePath, "", { mode: 0o600 });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function appendActivity(event: ActivityEvent): Promise<void> {
  const filePath = activityLogPath();
  const stamped = { ...event, tsIso: event.tsIso ?? new Date().toISOString() };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(stamped)}\n`, { flag: "a", mode: 0o600 });
}

/**
 * Heuristic: when did the user's `routine_active_hours` fact last
 * change? We don't track per-fact mtime, so the closest signal is
 * `updatedAt` on the whole memory blob. If undefined or older than
 * the staleness threshold, the REPL fires a background re-aggregation.
 *
 * Cheap; returns Date.now() (effectively "fresh") when no signal
 * exists so we don't spam fact-writes on every empty REPL boot.
 */
export function parseRoutineUpdateMs(memory: {
  readonly facts: Readonly<Record<string, string>>;
  readonly updatedAt?: Date;
} | undefined): number {
  if (!memory) return Date.now();
  if (!memory.facts.routine_active_hours) return 0; // no fact yet → always stale
  const ts = memory.updatedAt instanceof Date ? memory.updatedAt.getTime() : Date.now();
  return Number.isFinite(ts) ? ts : Date.now();
}

/**
 * If last-chat.jsonl has grown past HISTORY_COMPACT_THRESHOLD lines,
 * summarize the older portion via a one-shot model call and rewrite
 * the file with: [{ role: "system", content: "(summary)" }, ...
 * last HISTORY_TURN_LIMIT * 2 verbatim turns].
 *
 * Best-effort — extraction failures leave the original file
 * untouched, so a network glitch never loses chat memory.
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
  const filePath = lastChatHistoryPath();
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return { compacted: false, dropped: 0 };
    }
    throw cause;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= HISTORY_COMPACT_THRESHOLD) {
    return { compacted: false, dropped: 0 };
  }
  const keepRecent = HISTORY_TURN_LIMIT * 2;
  const older = lines.slice(0, lines.length - keepRecent);
  const recent = lines.slice(-keepRecent);
  const olderText = older.map((line) => {
    try {
      const parsed = JSON.parse(line) as { role?: string; content?: string };
      const role = parsed.role ?? "?";
      const content = (parsed.content ?? "").slice(0, 400);
      return `${role}: ${content}`;
    } catch {
      return line;
    }
  }).join("\n");

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
  const trimmedSummary = summary.trim();
  if (trimmedSummary.length === 0) {
    return { compacted: false, dropped: 0 };
  }
  const nextLines = [
    JSON.stringify({ content: `(Previous-conversation summary) ${trimmedSummary}`, role: "system" }),
    ...recent
  ];
  await writeFile(filePath, `${nextLines.join("\n")}\n`, { mode: 0o600 });
  return { compacted: true, dropped: older.length, summary: trimmedSummary };
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return isRecord(value) && typeof (value as { code?: unknown }).code === "string";
}
