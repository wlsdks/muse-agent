/**
 * Pure, render-free helpers for the Ink chat surface (`chat-ink.ts`).
 * Holds the text-editor reducer (multiline, word/line delete, cursor
 * movement), slash parsing, message building, and display-width math —
 * all unit-testable without an Ink render.
 */

import { readFile as fsReadFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { augmentCompactionSummary } from "@muse/agent-core";
import {
  createApproximateTokenEstimator,
  DEFAULT_CHUNK_MAX_CHARS,
  DEFAULT_MESSAGE_STRUCTURE_OVERHEAD,
  estimateConversationTokens,
  normalizeMemoryKey,
  summarizeDroppedContextInStages,
  trimConversationMessages,
  verifyCompactionSummaryQuality,
  type ConversationTrimOptions,
  type ConversationTrimResult,
  type DroppedContextSummarizer
} from "@muse/memory";
import { type FrameName } from "@muse/mascot";
import { classifyProviderLocality, type ProviderLocality } from "@muse/model";
import { clamp, redactSecretsInText, stripUntrustedTerminalChars } from "@muse/shared";
import { classifyCommandTopology, emphasizeRiskyTokens } from "@muse/tools";

import { needsContextualRewrite, type ChatGrounding } from "./chat-grounding.js";
import { MUSE_TAGLINE } from "./muse-identity.js";

/**
 * The first screen a brand-new user sees: `muse` with no model configured.
 * Leads with the local-first identity (not a generic error), frames local
 * as the free/private default and cloud as opt-in, and points at a guided
 * wizard. Every command named is real (`muse setup local|model|wizard`).
 * Pure + exported so the copy is gradeable without spawning the CLI.
 */
export function formatNoModelMessage(): string {
  return [
    MUSE_TAGLINE,
    "",
    "No model configured yet — pick one to get started:",
    "  • Local (free, private):  muse setup local     installs / points at an Ollama model",
    "  • Cloud (opt-in):         muse setup model     OpenAI / Anthropic / Gemini key",
    "",
    "Then run `muse` again  ·  or `muse setup wizard` for guided setup.",
    ""
  ].join("\n");
}
import { sniffImageMime } from "./image-bytes.js";

export interface InkKeyEvent {
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly return?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly escape?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly tab?: boolean;
}

/** A printable code point keeps the buffer free of stray control bytes. */
function isPrintableCodePoint(code: number): boolean {
  if (code < 0x20) return false; // C0 controls
  if (code === 0x7f) return false; // DEL
  if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
  return true;
}

function isWideCodePoint(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul Syllables
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** Terminal column width of a string (wide CJK = 2, control = 0). */
export function displayWidth(value: string): number {
  let width = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (!isPrintableCodePoint(code)) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

/** Editable input: `value` may contain `\n`; `cursor` is a codepoint index. */
export interface InputState {
  readonly value: string;
  readonly cursor: number;
}

export const emptyInput: InputState = { cursor: 0, value: "" };

/** Result of folding one keypress: the next state plus an optional intent. */
export interface InputResult {
  readonly state: InputState;
  readonly submit: boolean;
}

/**
 * NFC-normalize a submitted chat turn. macOS/Swift (and several IME / paste
 * paths) deliver Hangul as NFD — syllables DECOMPOSED into jamo ("뭐" →
 * ㅁ+ㅜ+ㅓ) — while every classifier/keyword in the chat pipeline is written
 * in NFC, so an NFD turn silently misses them (parity with the one-shot
 * `runLocalChat` normalization; the interactive Ink surface submitted the raw
 * bytes untouched).
 */
export function normalizeChatInput(raw: string): string {
  return raw.trim().normalize("NFC");
}

export interface ContextualRewriteDeps {
  /** Retrieve grounding for a (possibly rewritten) query. */
  readonly retrieve: (query: string) => Promise<ChatGrounding>;
  /**
   * Resolve the turn into a self-contained retrieval query using the recent
   * conversation. Omit to never rewrite (fails open to the raw turn).
   */
  readonly rewrite?: (
    history: readonly ChatTurnMessage[],
    message: string
  ) => Promise<string>;
}

/**
 * Multi-turn retrieval parity with `runLocalChat`'s inline rewrite: an
 * anaphoric follow-up ("그거 언제 바뀌었지?", "what about that one") embeds on
 * the pronoun, not the topic, so retrieval misses the note the conversation
 * is plainly about. Fires the rewrite ONLY when `needsContextualRewrite`
 * says so, and fails open to the RAW turn on any rewrite error or when no
 * `rewrite` dependency is supplied — a bad rewrite can at worst rank notes
 * poorly, never block retrieval.
 */
export function createContextualGroundingLookup(
  deps: ContextualRewriteDeps
): (prompt: string, history: readonly ChatTurnMessage[]) => Promise<ChatGrounding> {
  return async (prompt, history) => {
    if (!deps.rewrite || !needsContextualRewrite(prompt, history.length)) {
      return deps.retrieve(prompt);
    }
    try {
      const rewritten = await deps.rewrite(history, prompt);
      return deps.retrieve(rewritten);
    } catch {
      return deps.retrieve(prompt);
    }
  };
}

function codepoints(value: string): string[] {
  return [...value];
}


/** Index of the line start (after the previous `\n`) for a cursor index. */
function lineStart(chars: readonly string[], cursor: number): number {
  let i = cursor;
  while (i > 0 && chars[i - 1] !== "\n") i -= 1;
  return i;
}

function lineEnd(chars: readonly string[], cursor: number): number {
  let i = cursor;
  while (i < chars.length && chars[i] !== "\n") i += 1;
  return i;
}

/** Start index of the word before the cursor (skips spaces, then word chars). */
function wordStart(chars: readonly string[], cursor: number): number {
  let i = cursor;
  while (i > 0 && chars[i - 1] === " ") i -= 1;
  while (i > 0 && chars[i - 1] !== " " && chars[i - 1] !== "\n") i -= 1;
  return i;
}

function make(value: string, cursor: number): InputState {
  return { cursor: clamp(cursor, 0, codepoints(value).length), value };
}

function spliceChars(chars: readonly string[], from: number, deleteCount: number, insert: string[] = []): string {
  const next = [...chars];
  next.splice(from, deleteCount, ...insert);
  return next.join("");
}

/**
 * Fold one keypress into the editable input. Mirrors the editing keys
 * users expect from claude / codex / any readline UI:
 *   - Enter submits; Shift+Enter (or Alt+Enter) inserts a newline
 *   - Backspace / Delete remove a char; Alt+Backspace and Ctrl+W remove a word
 *   - Ctrl+U clears to the line start; Ctrl+A / Ctrl+E jump to line start / end
 *   - Left / Right move the cursor; Up / Down move between lines
 *   - printable text inserts at the cursor
 */
export function reduceInput(state: InputState, input: string, key: InkKeyEvent): InputResult {
  const chars = codepoints(state.value);
  const cursor = clamp(state.cursor, 0, chars.length);
  const keep = (next: InputState): InputResult => ({ state: next, submit: false });

  if (key.return) {
    // Shift+Enter / Alt+Enter → newline; plain Enter → submit.
    if (key.shift || key.meta) {
      return keep(make(spliceChars(chars, cursor, 0, ["\n"]), cursor + 1));
    }
    return { state, submit: true };
  }

  if (key.backspace || key.delete) {
    if (cursor === 0) return keep(state);
    if (key.meta) {
      const start = wordStart(chars, cursor);
      return keep(make(spliceChars(chars, start, cursor - start), start));
    }
    return keep(make(spliceChars(chars, cursor - 1, 1), cursor - 1));
  }

  if (key.ctrl) {
    if (input === "w") {
      const start = wordStart(chars, cursor);
      return keep(make(spliceChars(chars, start, cursor - start), start));
    }
    if (input === "u") {
      const start = lineStart(chars, cursor);
      return keep(make(spliceChars(chars, start, cursor - start), start));
    }
    if (input === "a") return keep(make(state.value, lineStart(chars, cursor)));
    if (input === "e") return keep(make(state.value, lineEnd(chars, cursor)));
    return keep(state); // other ctrl chords are handled by the component (ctrl-c)
  }

  if (key.leftArrow) return keep(make(state.value, cursor - 1));
  if (key.rightArrow) return keep(make(state.value, cursor + 1));
  if (key.upArrow || key.downArrow) {
    const ls = lineStart(chars, cursor);
    const col = cursor - ls;
    if (key.upArrow) {
      if (ls === 0) return keep(make(state.value, 0));
      const prevStart = lineStart(chars, ls - 1);
      const prevEnd = ls - 1;
      return keep(make(state.value, Math.min(prevStart + col, prevEnd)));
    }
    const le = lineEnd(chars, cursor);
    if (le >= chars.length) return keep(make(state.value, chars.length));
    const nextStart = le + 1;
    const nextEnd = lineEnd(chars, nextStart);
    return keep(make(state.value, Math.min(nextStart + col, nextEnd)));
  }

  if (key.escape || key.tab || !input) return keep(state);

  const printable = codepoints(input).filter((ch) => isPrintableCodePoint(ch.codePointAt(0) ?? 0));
  if (printable.length === 0) return keep(state);
  return keep(make(spliceChars(chars, cursor, 0, printable), cursor + printable.length));
}

/** The cursor's visual line index and column (wide-char aware) within the value. */
export function cursorCoords(state: InputState): { line: number; col: number } {
  const chars = codepoints(state.value);
  const cursor = clamp(state.cursor, 0, chars.length);
  let line = 0;
  let lineStartIdx = 0;
  for (let i = 0; i < cursor; i += 1) {
    if (chars[i] === "\n") {
      line += 1;
      lineStartIdx = i + 1;
    }
  }
  const col = displayWidth(chars.slice(lineStartIdx, cursor).join(""));
  return { col, line };
}

/**
 * Absolute row (0-based, from the top of Ink's live/non-static region) where
 * the real terminal cursor must sit for a CJK IME to compose on the input's
 * cursor line — for the FULL-HEIGHT HOME layout (banner → flexGrow canvas →
 * input box → menu? → notice? → hint → HUD, all inside a `height = rows-1`
 * box). Because the banner + canvas spacer heights above the input are decided
 * by Ink's flex layout (and vary with terminal size), we anchor from the BOTTOM
 * instead: the input's cursor row is a KNOWN number of rows above the bottom
 * edge of the `rows-1` live region, and every block below it has a fixed height.
 *
 * Rows strictly below the cursor's content line:
 *  - input box: remaining content lines below the cursor line + the bottom
 *    border → `inputLines - caretLine`
 *  - menu (slash/agent/model), when open: marginTop(1) + `menuRows` + footer(1)
 *  - command notice, when shown: marginTop(1) + 1 line
 *  - hint line: marginTop(1) + 1 line
 *  - HUD line: 1
 * The live region is `rows-1` tall so its bottom row index is `rows-2`; the
 * cursor row is `rows-2 - below`. Clamped to ≥ 0 for degenerate tiny terminals.
 */
export function homeInputCursorY(opts: {
  readonly rows: number;
  readonly inputLines: number;
  readonly caretLine: number;
  readonly menuRows: number;
  readonly hasNotice: boolean;
}): number {
  const inputBelow = opts.inputLines - opts.caretLine;
  const menuBelow = opts.menuRows > 0 ? opts.menuRows + 2 : 0;
  const noticeBelow = opts.hasNotice ? 2 : 0;
  const hintBelow = 2;
  const hudBelow = 1;
  const below = inputBelow + menuBelow + noticeBelow + hintBelow + hudBelow;
  return Math.max(0, opts.rows - 2 - below);
}

export interface ChatTurnMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /** Inline image attachments (gemma4 vision) — set when the turn referenced an
   *  image via `@photo.png`. Forwarded to the model's per-message images. */
  readonly attachments?: ReadonlyArray<{ readonly mimeType: string; readonly dataBase64: string }>;
}

/** Active-context window (Context-Folding, arXiv:2510.11967): the max number
 * of prior user/assistant messages sent to the model per turn. Bounds per-turn
 * prompt size so a long companion session can't grow latency/cost until it
 * overruns the local model's context. Full history is still persisted on disk
 * + held for episode capture; only the model's working set is capped. */
export function resolveChatHistoryWindow(env: Record<string, string | undefined>): number {
  const raw = Number(env.MUSE_CHAT_HISTORY_WINDOW);
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 40;
}

export function buildTurnMessages(
  systemContent: string,
  history: readonly ChatTurnMessage[],
  userMessage: string,
  maxHistoryMessages?: number,
  attachments?: ReadonlyArray<{ readonly mimeType: string; readonly dataBase64: string }>
): ChatTurnMessage[] {
  const conversation = history.filter((m) => m.role === "user" || m.role === "assistant");
  const windowed = maxHistoryMessages !== undefined && maxHistoryMessages >= 0 && conversation.length > maxHistoryMessages
    ? conversation.slice(-maxHistoryMessages)
    : conversation;
  return [
    { content: systemContent, role: "system" },
    ...windowed,
    { content: userMessage, role: "user", ...(attachments && attachments.length > 0 ? { attachments } : {}) }
  ];
}

/**
 * Map a raw model/stream error to a short, actionable hint. Unknown
 * errors pass through unchanged so no information is lost.
 */
export function friendlyError(raw: string): string {
  const m = raw.toLowerCase();
  if (/econnrefused|fetch failed|enotfound|socket hang|network|connect/u.test(m)) {
    return "model unreachable — is the model server running? (e.g. `ollama serve`)";
  }
  if (/not found|404|no such model|unknown model/u.test(m)) {
    return "model not found — check /model, or pull it (e.g. `ollama pull <model>`)";
  }
  if (/\b401\b|\b403\b|unauthor|api key|invalid key/u.test(m)) {
    return "auth failed — check the provider key (run `muse setup model`)";
  }
  if (/\b429\b|rate.?limit|too many requests/u.test(m)) {
    return "rate limited — wait a moment, then try again";
  }
  if (/timeout|timed out|etimedout/u.test(m)) {
    return "request timed out — try again, or switch to a faster model (/model)";
  }
  return raw;
}

const HELP_TOPICS: Readonly<Record<string, string>> = {
  agents: "Agents — your own sub-agents. Define `~/.muse/agents/<name>/AGENT.md` (or `muse agents add <name>`). `/agents` lists them, `/agent <name>` switches (its prompt drives replies), `/agent default` clears.",
  file: "@file — reference files in a message (e.g. `summarize @notes/plan.md @./todo.txt`) and Muse attaches their contents to the turn.",
  keys: "Keys — Enter: send · Shift/Alt+Enter: newline · ↑↓: input history · Ctrl+W/U: delete word/line · Ctrl+A/E: line start/end · Esc: stop a reply · Ctrl-C ×2: quit.",
  model: "/model — switch the session model. Type `/model ` for a picker (↑↓ select, Tab/Enter switch). Same-provider models only for now.",
  skills: "Skills — drop `~/.muse/skills/<name>/SKILL.md` (or `muse skills add <name>`). Loaded skills are injected so Muse follows the relevant one. `/skills` lists them.",
  tools: "/tools — run tools in chat: time, calendar, notes, weather, and LOCAL writes (tasks/notes/calendar). Third-party outbound (email/web/home) stays blocked for safety."
};

/** In-chat help: a command index, or a detailed blurb for one topic. */
export function chatHelp(topic: string, commands: readonly { readonly cmd: string; readonly desc: string }[]): string {
  const t = topic.trim().toLowerCase();
  if (t.length === 0) {
    return `Commands: ${commands.map((c) => `/${c.cmd}`).join(" · ")}\n` +
      `Tips: @file to attach · ↑↓ for history · /help <topic> for any command`;
  }
  if (HELP_TOPICS[t]) return HELP_TOPICS[t] as string;
  // Fall back to the command's own one-line description so `/help <cmd>`
  // always answers, even for commands without a dedicated topic blurb.
  const command = commands.find((c) => c.cmd === t);
  if (command) return `/${command.cmd} — ${command.desc}`;
  return `No help for '${t}'. Try /help for the command list.`;
}

/**
 * Parse `/remember` input into a key/value to store as a fact. Accepts
 * `key=value` or `key: value`; the key is normalised to a snake_case slug so
 * it round-trips with `/forget <key>` and shows tidily in `/memory`. Returns
 * undefined when there's no usable key+value.
 */
export function parseRememberArg(arg: string): { key: string; value: string } | undefined {
  const match = /^\s*([^=:]+?)\s*[=:]\s*(.+)$/u.exec(arg);
  if (!match) return undefined;
  const rawKey = (match[1] ?? "").trim();
  const value = (match[2] ?? "").trim();
  // Canonicalize via the store's own normalizer (keeps Unicode — a Korean key
  // like "취미" survives; the old ASCII-only slug dropped it to "" and silently
  // refused the write). Guard a real letter/digit first, since normalizeMemoryKey
  // falls back to the raw key for an all-punctuation input. Matches remember_fact.
  if (!/[\p{L}\p{N}]/u.test(rawKey) || value.length === 0) return undefined;
  return { key: normalizeMemoryKey(rawKey), value };
}

export interface SlashCommand {
  readonly cmd: string;
  readonly desc: string;
}

/**
 * Slash commands whose name matches what the user has typed so far.
 * Empty unless the input begins with `/`; `/` alone lists everything,
 * `/cl` narrows to `clear`, etc. Drives the autocomplete menu.
 */
export function matchSlashCommands(value: string, commands: readonly SlashCommand[]): readonly SlashCommand[] {
  if (!value.startsWith("/")) return [];
  // Once a space is typed the command name is settled (the user is on to
  // its argument), so close the menu.
  if (/\s/u.test(value)) return [];
  const query = value.slice(1).toLowerCase();
  return commands.filter((command) => command.cmd.startsWith(query));
}

/** Agent-name completions while typing `/agent <partial>`. */
export function matchAgentNames(value: string, names: readonly string[]): readonly string[] {
  const match = /^\/agent\s+(.*)$/u.exec(value);
  if (!match) return [];
  const partial = (match[1] ?? "").toLowerCase();
  return names.filter((name) => name.toLowerCase().startsWith(partial));
}

/**
 * File paths referenced with `@path` in a message (claude/codex style),
 * so their contents can be attached to the turn. Returns each `@token`'s
 * path, de-duplicated, in order.
 */
export function extractAttachmentPaths(message: string): string[] {
  const out: string[] = [];
  for (const match of message.matchAll(/(?:^|\s)@([^\s]+)/gu)) {
    const path = match[1];
    if (path && !out.includes(path)) out.push(path);
  }
  return out;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  bmp: "image/bmp", gif: "image/gif", heic: "image/heic", jpeg: "image/jpeg",
  jpg: "image/jpeg", png: "image/png", webp: "image/webp"
};

/** The image MIME type for an `@path` by extension, or undefined for a non-image
 *  (read as text). Routes `@photo.png` to gemma4 vision, `@notes.md` to text. */
export function imageMimeForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? IMAGE_MIME_BY_EXT[ext] : undefined;
}

/**
 * Load a local image file as a base64 attachment for `muse chat --image`.
 * Returns undefined on any failure (fail-soft: unreadable or non-image paths
 * are silently skipped rather than crashing the chat session).
 * Content-sniffed: the file's magic bytes must match a recognised image
 * signature — a renamed text file with a .png extension is rejected and the
 * sniffed MIME type (not the extension-derived one) is returned as mimeType.
 */
export async function readImageAttachment(
  relativePath: string,
  cwd = process.cwd(),
): Promise<{ readonly mimeType: string; readonly dataBase64: string } | undefined> {
  if (!imageMimeForPath(relativePath)) return undefined;
  try {
    const abs = isAbsolute(relativePath) ? relativePath : join(cwd, relativePath);
    const bytes = await fsReadFile(abs);
    if (bytes.length === 0) return undefined;
    const sniffed = sniffImageMime(bytes);
    if (sniffed === null) return undefined;
    return { dataBase64: bytes.toString("base64"), mimeType: sniffed };
  } catch {
    return undefined;
  }
}

/** Model completions while typing `/model <partial>` (substring match). */
export function matchModelNames(value: string, names: readonly string[]): readonly string[] {
  const match = /^\/model\s+(.*)$/u.exec(value);
  if (!match) return [];
  const partial = (match[1] ?? "").toLowerCase();
  return names.filter((name) => name.toLowerCase().includes(partial));
}

export interface ParsedSlash {
  readonly cmd: string;
  readonly arg: string;
}

export function parseSlashCommand(line: string): ParsedSlash | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/u);
  return { arg: rest.join(" ").trim(), cmd: (cmd ?? "").toLowerCase() };
}

/**
 * One-line, human-readable preview of a tool call's arguments, for the
 * outbound-action approval prompt — the user must see WHAT is being sent
 * (recipient, subject, body) before confirming, per outbound-safety.md.
 * Long values are clipped so the prompt stays one screen line.
 */
export function summarizeToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(args)) {
    if (raw === undefined || raw === null || raw === "") continue;
    const value = redactSecretsInText(stripUntrustedTerminalChars(typeof raw === "string" ? raw : JSON.stringify(raw)));
    const clipped = value.length > 60 ? `${value.slice(0, 60)}…` : value;
    parts.push(`${key}: ${clipped.replace(/\s+/gu, " ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "(no arguments)";
}

export type ApprovalKind = "outbound" | "tool";
export interface ApprovalGateCall {
  readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> };
  readonly risk: "read" | "write" | "execute";
}
export interface ApprovalGateDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Build the fail-closed approval gate for the chat tool loop. A `read` tool
 * runs silently. Any `write`/`execute` tool — local write, shell, or an
 * outbound actuator — must be confirmed by the user via `ask(name, content,
 * kind)`, which shows the exact arguments before anything happens; only an
 * explicit approval (`true`) lets it through. A denial / cancel / timeout
 * blocks it with a reason, so a state-changing call never proceeds on the
 * gate's own judgement (outbound-safety.md rules 1 & 2). `kind` is `outbound`
 * for the third-party actuators so the prompt can flag them louder.
 *
 * `run_command` gets one extra check: a shell construct like `$(...)` or a
 * heredoc hides the REAL command from the string-level dangerous-command
 * guard (`classifyCommandTopology`). An un-analyzable command must never
 * take the silent `read` fast-path — a mis-set or spoofed `risk` must not
 * let it bypass confirmation — and the human is shown WHY it needs a closer
 * look before deciding.
 */
export function chatToolApprovalGate(
  outbound: readonly string[],
  ask: (name: string, detail: string, kind: ApprovalKind) => Promise<boolean>
): (input: ApprovalGateCall) => Promise<ApprovalGateDecision> {
  return async ({ toolCall, risk }) => {
    const isRunCommand = toolCall.name === "run_command";
    const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
    const args = Array.isArray(toolCall.arguments.args)
      ? toolCall.arguments.args.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    const topology = isRunCommand ? classifyCommandTopology(command, args) : undefined;

    if (risk === "read" && (topology === undefined || topology.analyzable)) return { allowed: true };

    const kind: ApprovalKind = outbound.includes(toolCall.name) ? "outbound" : "tool";
    // `summarizeToolArgs` already stripped untrusted terminal chars and
    // redacted secrets — the ANSI emphasis is TRUSTED styling added AFTER
    // that, so it never re-introduces an untrusted control byte.
    const summary = emphasizeRiskyTokens(summarizeToolArgs(toolCall.arguments));
    const detail =
      topology && !topology.analyzable
        ? `⚠ un-inspectable shell construction (${topology.construct ?? "un-analyzable"}) — its real command can't be checked automatically. ${summary}`
        : summary;
    const approved = await ask(toolCall.name, detail, kind);
    if (approved) return { allowed: true };
    return { allowed: false, reason: `user declined the ${kind === "outbound" ? "outbound action" : "tool call"}` };
  };
}

export interface MemorySnapshot {
  readonly facts: Readonly<Record<string, string>>;
  readonly preferences: Readonly<Record<string, string>>;
  readonly recentTopics: readonly string[];
  readonly factHistory?: readonly { readonly key: string; readonly previousValue: string; readonly replacedAt: string }[];
}

/**
 * The once-a-day session-open greeting: morning brief, plus a proactive
 * reflection line ONLY when there's an honest cross-session insight (empty →
 * no nag). Kept pure so the speaks-first composition is unit-testable apart
 * from the file/model I/O that resolves the brief + insight.
 */
export function composeMorningGreeting(opts: {
  readonly who?: string;
  readonly brief: string;
  readonly insight?: string;
}): string {
  const greeting = `♪ good morning${opts.who && opts.who.length > 0 ? `, ${opts.who}` : ""}`;
  const insight = (opts.insight ?? "").trim();
  const reflection = insight.length > 0 ? `\n\n🪞 ${stripUntrustedTerminalChars(insight)}` : "";
  return `${greeting}\n\n${opts.brief}${reflection}`;
}

export interface RecurringThread {
  readonly topic: string;
  readonly sessions: number;
}

/**
 * Reflection over episodic memory: topics the user has returned to across
 * MULTIPLE distinct sessions, ranked by how many sessions touched them. A
 * deterministic "hindsight" aggregate (no LLM synthesis) — surfaces the
 * threads a JARVIS would notice ("you keep coming back to the Q3 budget").
 * A topic counts once per episode (intra-episode repeats don't inflate it);
 * grouping is case-insensitive but the first-seen display form is kept.
 */
export function recurringEpisodeThreads(
  episodes: readonly { readonly topics?: readonly string[] }[],
  opts: { readonly minSessions?: number; readonly max?: number } = {}
): RecurringThread[] {
  const minSessions = opts.minSessions ?? 2;
  const max = opts.max ?? 3;
  const counts = new Map<string, { display: string; sessions: number }>();
  for (const episode of episodes) {
    const seen = new Set<string>();
    for (const raw of episode.topics ?? []) {
      const topic = raw.trim();
      if (topic.length === 0) continue;
      const norm = topic.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      const entry = counts.get(norm);
      if (entry) entry.sessions += 1;
      else counts.set(norm, { display: topic, sessions: 1 });
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.sessions >= minSessions)
    .sort((a, b) => b.sessions - a.sessions || a.display.localeCompare(b.display))
    .slice(0, max)
    .map((entry) => ({ topic: entry.display, sessions: entry.sessions }));
}

/** The most-recent prior value for `key` from the supersession log, or undefined. */
function latestPriorValue(
  factHistory: MemorySnapshot["factHistory"],
  key: string
): { readonly previousValue: string; readonly replacedAt: string } | undefined {
  if (!factHistory) return undefined;
  for (let i = factHistory.length - 1; i >= 0; i--) {
    const entry = factHistory[i];
    if (entry && entry.key === key) return { previousValue: entry.previousValue, replacedAt: entry.replacedAt };
  }
  return undefined;
}

/**
 * Render `/memory` — what Muse remembers about the user — as indented
 * lines. Returns an empty-state line when nothing is stored yet so the
 * command always answers. UI strings are English (open-source surface).
 */
export function formatMemoryView(
  memory: MemorySnapshot | undefined,
  episodes?: { readonly count: number; readonly lastAt?: string },
  recurringThreads?: readonly RecurringThread[]
): string {
  const factKeys = memory ? Object.keys(memory.facts) : [];
  const prefKeys = memory ? Object.keys(memory.preferences) : [];
  const topics = memory?.recentTopics ?? [];
  const epCount = episodes?.count ?? 0;
  const threads = recurringThreads ?? [];
  if (factKeys.length === 0 && prefKeys.length === 0 && topics.length === 0 && epCount === 0 && threads.length === 0) {
    return "I haven't remembered anything about you yet.";
  }
  const lines: string[] = ["What I remember about you:"];
  if (factKeys.length > 0) {
    lines.push("  Facts:");
    for (const key of factKeys) {
      const prior = latestPriorValue(memory!.factHistory, key);
      const wasSuffix = prior
        ? ` (was ${stripUntrustedTerminalChars(prior.previousValue)} until ${prior.replacedAt.slice(0, 10)})`
        : "";
      lines.push(`    ${key}: ${memory!.facts[key]}${wasSuffix}`);
    }
  }
  if (prefKeys.length > 0) {
    lines.push("  Preferences:");
    for (const key of prefKeys) lines.push(`    ${key}: ${memory!.preferences[key]}`);
  }
  if (topics.length > 0) lines.push(`  Recent topics: ${topics.join(", ")}`);
  if (threads.length > 0) {
    const phrased = threads.map((t) => `${stripUntrustedTerminalChars(t.topic)} (${t.sessions} sessions)`);
    lines.push(`  Threads you keep returning to: ${phrased.join(", ")}`);
  }
  if (epCount > 0) {
    const when = episodes?.lastAt ? ` (most recent ${episodes.lastAt.slice(0, 10)})` : "";
    lines.push(`  Past sessions remembered: ${epCount}${when} — search them with /recall`);
  }
  lines.push("Type /forget <key> to drop one.");
  return lines.join("\n");
}

/**
 * The one-line "where we left off" recap shown when a continuous session
 * resumes. Composes the most recent episode summary with the count of
 * still-open commitments. Returns `""` when there is nothing to recap so
 * the caller renders no line (a brand-new relationship stays clean).
 */
export function buildRecap(input: {
  readonly lastEpisode?: string;
  readonly pendingTasks?: number;
  readonly pendingFollowups?: number;
  /** Untracked open loops the user voiced last session (detectUserCommitments). */
  readonly openCommitments?: number;
}): string {
  const parts: string[] = [];
  const summary = input.lastEpisode?.replace(/\s+/gu, " ").trim();
  if (summary) parts.push(summary.length > 80 ? `${summary.slice(0, 80)}…` : summary);
  const open: string[] = [];
  if ((input.pendingTasks ?? 0) > 0) open.push(`${input.pendingTasks} task${input.pendingTasks === 1 ? "" : "s"}`);
  if ((input.pendingFollowups ?? 0) > 0) open.push(`${input.pendingFollowups} follow-up${input.pendingFollowups === 1 ? "" : "s"}`);
  if (open.length > 0) parts.push(`${open.join(", ")} waiting`);
  // Distinct from "waiting" (tracked tasks/follow-ups): these were only
  // SAID, never written down — a nudge to formalise them. `muse commitments
  // scan` lists them.
  const commitments = input.openCommitments ?? 0;
  if (commitments > 0) parts.push(`${commitments} loose end${commitments === 1 ? "" : "s"} you mentioned`);
  return parts.length > 0 ? `Where we left off: ${parts.join(" · ")}` : "";
}

export interface RecallHitView {
  readonly source: string;
  readonly ref: string;
  readonly score: number;
  readonly snippet: string;
}

/**
 * Render `/recall` hits for the chat: a header plus one indented
 * source/ref/score line and a clipped snippet per hit. Empty-state line
 * when nothing matched so the command always answers.
 */
export function formatRecallHits(query: string, hits: readonly RecallHitView[]): string {
  if (hits.length === 0) return `No memories matched "${query}". Try \`muse notes reindex\` / \`muse episode reindex\`.`;
  const lines: string[] = [`Recall for "${query}":`];
  for (const hit of hits) {
    lines.push(`  [${hit.source}] ${stripUntrustedTerminalChars(hit.ref)} (${hit.score.toFixed(2)})`);
    lines.push(`    ${stripUntrustedTerminalChars(hit.snippet).replace(/\s+/gu, " ").trim().slice(0, 140)}`);
  }
  return lines.join("\n");
}

export interface JobListItem {
  readonly id: string;
  readonly status: string;
  readonly prompt?: string;
  readonly finalText?: string;
}

/**
 * Render `/jobs` — recent background jobs with a status glyph, the prompt
 * that started each, and (when done) a one-line result preview. Empty-state
 * line when none have been started so the command always answers.
 */
export function formatJobsList(jobs: readonly JobListItem[]): string {
  if (jobs.length === 0) return "No background jobs yet. Start one with /job <prompt>.";
  const glyph = (status: string): string =>
    status === "done" ? "✓" : status === "error" ? "✗" : status === "running" ? "⏳" : "·";
  const lines: string[] = ["Background jobs:"];
  for (const job of jobs) {
    const label = stripUntrustedTerminalChars(job.prompt ?? "").replace(/\s+/gu, " ").trim().slice(0, 50) || job.id;
    lines.push(`  ${glyph(job.status)} ${job.id.slice(0, 24)} — ${label} (${job.status})`);
    if (job.status === "done" && job.finalText) {
      lines.push(`      → ${stripUntrustedTerminalChars(job.finalText).replace(/\s+/gu, " ").trim().slice(0, 80)}`);
    }
  }
  return lines.join("\n");
}

/**
 * True when the chat is being opened for the first time on `today` (the
 * stored marker holds a different / no date), so the launch shows the full
 * morning briefing instead of the one-line recap. Dates are `YYYY-MM-DD`.
 */
export function firstOpenToday(lastBriefDate: string | undefined, today: string): boolean {
  return (lastBriefDate?.trim() ?? "") !== today;
}

/** Render `/trust` — the user's trusted + blocked tool lists (read-only view). */
export function formatTrust(trusted: readonly string[], blocked: readonly string[]): string {
  return [
    `Trusted tools (${trusted.length}): ${trusted.length > 0 ? [...trusted].sort().join(", ") : "(none)"}`,
    `Blocked tools (${blocked.length}): ${blocked.length > 0 ? [...blocked].sort().join(", ") : "(none)"}`
  ].join("\n");
}

/**
 * The first name to greet the user by, pulled from remembered facts
 * (name / user_name / first_name / preferred_name). Returns the first token
 * only, terminal-control stripped, or undefined when nothing usable is stored
 * — so the morning greeting personalises ("good morning, Jinan") only when
 * Muse actually knows a name.
 */
export function greetingName(facts: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!facts) return undefined;
  const raw = (facts.name ?? facts.user_name ?? facts.first_name ?? facts.preferred_name ?? "").trim();
  if (raw.length === 0) return undefined;
  const first = stripUntrustedTerminalChars(raw).replace(/\s+/gu, " ").trim().split(" ")[0] ?? "";
  return first.length > 0 ? first.slice(0, 40) : undefined;
}

/**
 * Render `/compact` — a read-only preview of what the NEXT proactive
 * compaction pass would drop from the in-context conversation, computed
 * from the same `trimConversationMessages` result the live runtime would
 * produce. Never mutates anything; it's a preview only.
 */
export function formatCompactPreview(totalMessages: number, result: ConversationTrimResult): string {
  const lines: string[] = [
    `Compaction preview — ${totalMessages} message(s) in context`,
    `  tokens: ~${result.estimatedTokens} / ${result.budgetTokens} budget`
  ];
  if (result.removedCount === 0) {
    lines.push("  nothing would be dropped right now.");
    return lines.join("\n");
  }
  lines.push(`  would drop ${result.removedCount} message(s) (trigger: ${result.triggeredBy})`);
  const byRole = new Map<string, number>();
  for (const m of result.dropped) byRole.set(m.role, (byRole.get(m.role) ?? 0) + 1);
  lines.push(`    ${[...byRole.entries()].map(([role, count]) => `${count} ${role}`).join(", ")}`);
  const oldest = result.dropped[0];
  if (oldest) {
    const preview = stripUntrustedTerminalChars(oldest.content).replace(/\s+/gu, " ").trim().slice(0, 60);
    lines.push(`    oldest dropped: [${oldest.role}] ${preview}${preview.length === 60 ? "…" : ""}`);
  }
  if (result.summaryInserted) lines.push("  a conversation summary would be inserted in their place.");
  return lines.join("\n");
}

export interface FocusedCompactionResult {
  readonly messages: readonly ChatTurnMessage[];
  readonly note: string;
}

function findLastIndexBy<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index] as T)) return index;
  }
  return -1;
}

function toChatTurnMessages(messages: Parameters<typeof augmentCompactionSummary>[0]): readonly ChatTurnMessage[] {
  return messages
    .filter((message): message is typeof message & { role: "system" | "user" | "assistant" } => message.role !== "tool")
    .map((message) => {
      const attachments = (message.attachments ?? []).filter(
        (attachment): attachment is { readonly mimeType: string; readonly dataBase64: string } =>
          typeof attachment.dataBase64 === "string"
      );
      return {
        content: message.content,
        role: message.role,
        ...(attachments.length > 0 ? { attachments } : {})
      };
    });
}

/**
 * `/compact <topic>` — unlike bare `/compact` (a read-only preview), this
 * actually compacts the in-session history NOW: force-trims everything
 * OLDER than the most recent exchange down to a deterministic summary (the
 * SAME `trimConversationMessages` pipeline the live runtime uses), then
 * asks the aux summarizer for a topic-FOCUSED recap of what was dropped
 * (hermes' `/compact <focus>` pattern). The recap is gated
 * (`verifyCompactionSummaryQuality`, deterministic, no LLM) before it's
 * appended — a lossy recap is dropped, not shipped; the deterministic
 * `[Key details]` summary (always inserted) is the floor either way.
 *
 * The "force" target is EXACTLY the token cost of the most recent exchange
 * (the last user turn through the end of history) — not a near-zero
 * budget, and not a loose one either: `trimToolHistory` (part of the
 * standard trim pipeline) keeps trimming past the last-user boundary for
 * as long as the target is unreachable, so an unreachably-low target would
 * eat into the very exchange this command means to keep intact; a loose
 * target would stop early and leave some older turns un-compacted. Using
 * the SAME estimator + overhead for both the tail measurement and the
 * forced trim keeps the two numbers exactly comparable.
 */
export async function runFocusedCompaction(
  topic: string,
  history: readonly ChatTurnMessage[],
  trimOptions: ConversationTrimOptions,
  summarizer: DroppedContextSummarizer | undefined
): Promise<FocusedCompactionResult> {
  const estimator = trimOptions.estimator ?? createApproximateTokenEstimator();
  const messageStructureOverhead = trimOptions.messageStructureOverhead ?? DEFAULT_MESSAGE_STRUCTURE_OVERHEAD;
  const lastUserIndex = findLastIndexBy(history, (message) => message.role === "user");
  const tail = lastUserIndex >= 0 ? history.slice(lastUserIndex) : history;
  const tailTokens = estimateConversationTokens(tail, { estimator, messageStructureOverhead });

  const forcedOptions: ConversationTrimOptions = {
    ...trimOptions,
    compactionThreshold: 1,
    estimator,
    messageStructureOverhead,
    workingBudgetTokens: tailTokens
  };
  const result = trimConversationMessages(history, forcedOptions);

  if (result.dropped.length === 0) {
    return { messages: history, note: "Nothing to compact yet — the conversation is still short." };
  }

  const droppedCount = result.dropped.length.toString();
  let note = `Compacted ${droppedCount} message(s), focused on "${topic}" — kept the most recent exchange and a deterministic summary.`;
  let messages: Parameters<typeof augmentCompactionSummary>[0] = result.messages;

  const auxSummary = await summarizeDroppedContextInStages(result.dropped, summarizer, {
    fallback: "",
    focusTopic: topic,
    chunkMaxChars: DEFAULT_CHUNK_MAX_CHARS
  });
  if (auxSummary.length > 0) {
    const gate = verifyCompactionSummaryQuality(result.dropped, auxSummary);
    if (gate.passed) {
      messages = augmentCompactionSummary(messages, auxSummary);
      note += ` Added a topic-focused recap on "${topic}".`;
    } else {
      note += " (a topic-focused recap was generated but didn't preserve enough of the dropped detail, so it was skipped.)";
    }
  }

  return { messages: toChatTurnMessages(messages), note };
}

export type ParsedUndoArg =
  | { readonly kind: "ok"; readonly count: number }
  | { readonly kind: "invalid"; readonly raw: string };

/**
 * Parse `/undo [N]`'s argument. Empty ⇒ 1 (undo the last exchange). A
 * strict integer only — "2x" / "2.5" / "all" are rejected outright (never
 * silently coerced, so a typo doesn't undo the wrong number of turns); a
 * valid integer outside 1-20 is clamped into range rather than rejected,
 * since the intent ("undo a lot" / "undo everything") is unambiguous.
 */
export function parseUndoArg(arg: string): ParsedUndoArg {
  const trimmed = arg.trim();
  if (trimmed.length === 0) return { count: 1, kind: "ok" };
  if (!/^-?\d+$/u.test(trimmed)) return { kind: "invalid", raw: trimmed };
  const parsed = Number.parseInt(trimmed, 10);
  return { count: clamp(parsed, 1, 20), kind: "ok" };
}

export interface UndoResult {
  /** The history with the removed exchanges dropped — never mutates the input. */
  readonly history: readonly ChatTurnMessage[];
  readonly removedExchanges: number;
  readonly remainingExchanges: number;
}

/**
 * Roll back the last `count` user/assistant exchanges from the in-session
 * history. An "exchange" is everything from one `user` message up to (but
 * excluding) the next `user` message — so a tool call/result recorded
 * between two user turns is removed along with the exchange it belongs to,
 * and a trailing un-answered user message (no assistant reply yet) still
 * counts as one whole exchange rather than being left dangling. `count` is
 * clamped to the number of exchanges actually present, so `/undo 20` on a
 * 2-exchange conversation clears it without erroring.
 */
export function undoExchanges(history: readonly ChatTurnMessage[], count: number): UndoResult {
  const total = history.filter((m) => m.role === "user").length;
  const toRemove = Math.max(0, Math.min(count, total));
  if (toRemove === 0) {
    return { history, remainingExchanges: total, removedExchanges: 0 };
  }
  const keepUserCount = total - toRemove;
  let userSeen = 0;
  let cutIndex = history.length;
  for (let i = 0; i < history.length; i++) {
    if (history[i]?.role === "user") {
      userSeen += 1;
      if (userSeen === keepUserCount + 1) {
        cutIndex = i;
        break;
      }
    }
  }
  return { history: history.slice(0, cutIndex), remainingExchanges: keepUserCount, removedExchanges: toRemove };
}

/** Feedback line for `/undo` — how many exchanges came off and how many remain. */
export function formatUndoNotice(result: UndoResult): string {
  if (result.removedExchanges === 0) return "Nothing to undo yet.";
  const plural = result.removedExchanges === 1 ? "" : "s";
  return `Removed the last ${result.removedExchanges.toString()} exchange${plural} — ${result.remainingExchanges.toString()} remaining.`;
}

export type ForgetResolution =
  | { readonly kind: "exact"; readonly key: string }
  | { readonly kind: "unique"; readonly key: string }
  | { readonly kind: "ambiguous"; readonly matches: readonly string[] }
  | { readonly kind: "none" };

/**
 * Resolve a `/forget <query>` against the known memory keys. Prefers an exact
 * key; otherwise a case-insensitive substring match — unique → that key, many
 * → ambiguous (the caller asks the user to be specific), none → not found. Lets
 * the user forget "city" without typing the exact stored key, while staying
 * safe (never guesses among several).
 */
export function resolveForgetKey(keys: readonly string[], query: string): ForgetResolution {
  const q = query.trim();
  if (keys.includes(q)) return { key: q, kind: "exact" };
  const lower = q.toLowerCase();
  const matches = keys.filter((k) => k.toLowerCase().includes(lower));
  if (matches.length === 1) return { key: matches[0] as string, kind: "unique" };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "none" };
}

/**
 * Home-screen bird idle loop. A subtle reduction of the desktop companion's
 * bob/blink idle vocabulary to what reads well at the terminal's 6 half-block
 * lines: mostly standing, an occasional single-frame blink, and one gentle bob
 * (`hopUp` lifts the body a pixel, then it settles back to `stand`). Every pose
 * is a canonical `@muse/mascot` frame — no hand-drawn art — and each renders to
 * exactly 6 lines, so cycling them never jitters the layout.
 */
export const BIRD_IDLE_CYCLE: readonly FrameName[] = [
  "stand", "stand", "blink", "stand", "stand", "hopUp", "stand", "stand"
];

/** How long each idle frame holds (ms). ~650ms keeps the motion gentle, well
 *  inside the "one small bird, not a parade" brief. */
export const BIRD_FRAME_MS = 650;

/** The frame to draw for a given tick. `animate: false` (reduced-motion /
 *  NO_COLOR / non-TTY) pins the bird to a single static `stand` pose. */
export function birdIdleFrame(tick: number, animate = true): FrameName {
  if (!animate) return "stand";
  const len = BIRD_IDLE_CYCLE.length;
  const idx = ((Math.trunc(tick) % len) + len) % len;
  return BIRD_IDLE_CYCLE[idx] as FrameName;
}

function envFlagOn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no" && v !== "off";
}

/** The truecolor half-block bird only makes sense on a color TTY. NO_COLOR
 *  (https://no-color.org/) or a non-TTY (piped/CI) ⇒ no ANSI-color bird. */
export function birdColorEnabled(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (env.NO_COLOR !== undefined) return false;
  return isTty;
}

/** Whether the idle timer should run. Off under NO_COLOR / non-TTY (no bird at
 *  all) and off under `MUSE_NO_ANIM` (a static bird — the reduced-motion path).
 *  When this is false the caller renders a single static frame with no timer. */
export function birdAnimationEnabled(env: Record<string, string | undefined>, isTty: boolean): boolean {
  if (!birdColorEnabled(env, isTty)) return false;
  if (envFlagOn(env.MUSE_NO_ANIM)) return false;
  return true;
}

/** The HUD status-bar segments, in their canonical default order. */
export type HudSegmentId = "model" | "locality" | "proactive" | "agent" | "tools" | "skills" | "ctx" | "tokens";

export const HUD_SEGMENTS_DEFAULT: readonly HudSegmentId[] = [
  "model", "locality", "proactive", "agent", "tools", "skills", "ctx", "tokens"
];

const HUD_SEGMENT_SET: ReadonlySet<string> = new Set(HUD_SEGMENTS_DEFAULT);

/** Named presets — sugar over an explicit segment list. */
export const HUD_PRESETS: Readonly<Record<string, readonly HudSegmentId[]>> = {
  minimal: ["model", "locality"],
  full: HUD_SEGMENTS_DEFAULT
};

/** Parse a comma list into an ordered, de-duplicated list of KNOWN segment ids;
 *  unknown names and duplicates are dropped silently. */
function parseHudSegmentList(raw: string): HudSegmentId[] {
  const seen = new Set<string>();
  const out: HudSegmentId[] = [];
  for (const token of raw.split(",")) {
    const id = token.trim().toLowerCase();
    if (HUD_SEGMENT_SET.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id as HudSegmentId);
    }
  }
  return out;
}

/**
 * Resolve which HUD segments to render, in order. Precedence:
 *  1. an explicit comma list — `MUSE_HUD_SEGMENTS` env, else `config.segments`
 *     (unknown/duplicate names ignored; picks AND orders),
 *  2. a named preset — `MUSE_HUD` env, else `config.preset` (`minimal`/`full`),
 *  3. the full default order.
 * Any step that resolves to an empty/blank selection falls through to the next,
 * so the HUD is never blank.
 */
export function resolveHudSegments(
  env: Record<string, string | undefined>,
  config?: { readonly segments?: string; readonly preset?: string }
): readonly HudSegmentId[] {
  const rawList = env.MUSE_HUD_SEGMENTS ?? config?.segments;
  if (rawList !== undefined && rawList.trim().length > 0) {
    const picked = parseHudSegmentList(rawList);
    if (picked.length > 0) return picked;
  }
  const rawPreset = (env.MUSE_HUD ?? config?.preset)?.trim().toLowerCase();
  if (rawPreset !== undefined && rawPreset.length > 0) {
    const preset = HUD_PRESETS[rawPreset];
    if (preset && preset.length > 0) return preset;
  }
  return HUD_SEGMENTS_DEFAULT;
}

/** Cloud-LLM credential env keys — mirrors autoconfigure's `CLOUD_CREDENTIAL_ENV_KEYS`
 *  so the HUD's egress-possible warning agrees with `muse doctor`/`muse status`. */
const HUD_CLOUD_CREDENTIAL_ENV_KEYS: readonly string[] = [
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"
];

/** True when any cloud-LLM credential is present in the environment — the input
 *  the HUD uses to decide whether cloud egress is *possible* (posture warning). */
export function hasCloudCredential(env: Record<string, string | undefined>): boolean {
  return HUD_CLOUD_CREDENTIAL_ENV_KEYS.some((k) => (env[k] ?? "").trim().length > 0);
}

/** The provider id encoded as a `provider/model` prefix (e.g. `ollama/gemma4:12b`
 *  → `ollama`); falls back to the whole trimmed, lower-cased string when there's
 *  no slash. Used to classify the ACTIVE model's locality for the HUD. */
export function providerIdFromModel(model: string): string {
  const trimmed = model.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  return slash > 0 ? trimmed.slice(0, slash) : trimmed;
}

export interface HudLocality {
  /** Where the ACTIVE model runs — never a lie about a local model. */
  readonly locality: ProviderLocality;
  /** Show the ⚠ warn glyph: data egresses now (cloud) OR egress is possible
   *  (a local model with local-only off AND a cloud credential present). */
  readonly warn: boolean;
  /** The lock (private local) or warn glyph. */
  readonly glyph: string;
  /** `local` / `cloud` — the truthful model locality, independent of the flag. */
  readonly label: string;
  /** The single rendered string, e.g. `🔒 local`, `⚠ cloud`, `⚠ local`. */
  readonly text: string;
  /** `green` = private/guaranteed; `yellow` = egress happening or possible. */
  readonly tone: "green" | "yellow";
}

/**
 * Truthful HUD locality badge for the ACTIVE model — replaces the old "any
 * MUSE_LOCAL_ONLY=off ⇒ ⚠ cloud" alarm, which lied about a local Ollama model
 * whenever the (now-default-off) flag was off. Rules:
 *  - a cloud provider (openai/anthropic/gemini/openrouter, or an off-box host)
 *    → `⚠ cloud` — data is actually leaving the machine.
 *  - a local provider (ollama/lmstudio/loopback) → `🔒 local` REGARDLESS of the
 *    local-only flag — the model runs on-box, so the lock is honest.
 *  - a local provider where egress is *possible* (local-only explicitly off AND
 *    a cloud credential is set) → `⚠ local` — still truthfully local, but a
 *    caution that the posture would permit a cloud switch. Not alarmist: the
 *    label stays `local` and the lock only drops to a warn when a key exists.
 */
export function resolveHudLocality(input: {
  readonly providerId: string;
  readonly baseUrl?: string;
  readonly localOnly: boolean;
  readonly cloudKeyPresent: boolean;
}): HudLocality {
  const locality = classifyProviderLocality(input.providerId, input.baseUrl);
  const warn = locality === "cloud" || (!input.localOnly && input.cloudKeyPresent);
  const glyph = warn ? "⚠" : "🔒";
  const label = locality;
  return { glyph, label, locality, text: `${glyph} ${label}`, tone: warn ? "yellow" : "green", warn };
}

/**
 * The `ctx NN%` HUD segment — how full the model's context window is, from the
 * most recent turn's INPUT tokens (the live working-set size) over the window
 * budget. Self-omits (returns undefined) when either number is unknown/zero so
 * the segment disappears until a real round-trip reports usage. A sub-1% fill
 * shows `<1%` rather than a misleading `0%`.
 */
export function formatContextUsage(usedTokens: number, budgetTokens: number | undefined): string | undefined {
  if (budgetTokens === undefined || budgetTokens <= 0 || usedTokens <= 0) return undefined;
  const pct = Math.round((usedTokens / budgetTokens) * 100);
  const clamped = Math.max(0, Math.min(100, pct));
  return `ctx ${clamped === 0 ? "<1" : clamped.toString()}%`;
}

export type DisplayTurnRole = "user" | "assistant" | "system" | "proactive" | "command";

/**
 * The dim separator rule to draw ABOVE the turn at `index` in the transcript,
 * so a long conversation reads as scannable Q→A units instead of one stack.
 * Returns a rule ONLY at the start of a NEW exchange — a `user` turn that isn't
 * the first item — carrying a compact `#N` exchange number for scanning back;
 * every other turn (assistant answer, system note, sub-line) returns `""`, so
 * there's one separator per exchange, never between every line.
 *
 * `plain` (NO_COLOR / non-TTY) swaps the box-drawing `─` for an ASCII `-`; the
 * width is clamped to a sane band so a tiny or enormous terminal still reads.
 */
export function turnSeparator(
  roles: readonly DisplayTurnRole[],
  index: number,
  opts: { readonly width: number; readonly plain: boolean }
): string {
  if (index <= 0 || roles[index] !== "user") return "";
  let exchange = 0;
  for (let i = 0; i <= index; i++) if (roles[i] === "user") exchange += 1;
  const dash = opts.plain ? "-" : "─";
  const width = Math.max(12, Math.min(Math.trunc(opts.width) || 0, 120));
  const tag = `${dash}${dash} #${exchange.toString()} `;
  const fill = Math.max(0, width - displayWidth(tag));
  return tag + dash.repeat(fill);
}
