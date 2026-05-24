/**
 * Pure, render-free helpers for the Ink chat surface (`chat-ink.ts`).
 * Holds the text-editor reducer (multiline, word/line delete, cursor
 * movement), slash parsing, message building, and display-width math —
 * all unit-testable without an Ink render.
 */

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

function codepoints(value: string): string[] {
  return [...value];
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
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

export interface ChatTurnMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export function buildTurnMessages(
  systemContent: string,
  history: readonly ChatTurnMessage[],
  userMessage: string
): ChatTurnMessage[] {
  return [
    { content: systemContent, role: "system" },
    ...history.filter((m) => m.role === "user" || m.role === "assistant"),
    { content: userMessage, role: "user" }
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

export interface MarkdownBlock {
  readonly type: "code" | "text";
  readonly lang?: string;
  readonly lines: readonly string[];
}

/** Split text into fenced-code vs prose blocks for terminal rendering. */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let inCode = false;
  let lang = "";
  let cur: string[] = [];
  const flush = (type: "code" | "text"): void => {
    if (type === "code" || cur.length > 0) {
      blocks.push(lang ? { lang, lines: cur, type } : { lines: cur, type });
    }
    cur = [];
  };
  for (const line of text.split("\n")) {
    const fence = /^```(\w*)\s*$/u.exec(line);
    if (fence) {
      if (inCode) { flush("code"); inCode = false; lang = ""; }
      else { if (cur.length > 0) flush("text"); inCode = true; lang = fence[1] ?? ""; }
      continue;
    }
    cur.push(line);
  }
  flush(inCode ? "code" : "text");
  return blocks;
}

export interface InlineSpan {
  readonly text: string;
  readonly bold?: boolean;
  readonly code?: boolean;
}

/** Split one prose line into bold (`**x**`) / inline-code (`` `x` ``) spans. */
export function parseInlineSpans(line: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index) });
    if (m[1] !== undefined) spans.push({ bold: true, text: m[1] });
    else if (m[2] !== undefined) spans.push({ code: true, text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < line.length) spans.push({ text: line.slice(last) });
  return spans.length > 0 ? spans : [{ text: line }];
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
