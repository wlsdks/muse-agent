/**
 * Pure, render-free helpers for the Ink chat surface (`chat-ink.ts`).
 * Kept separate so the input-editing, slash-parsing, and message-build
 * logic is unit-testable without standing up an Ink render (the CLI
 * ships `ink` but not `ink-testing-library`).
 */

export interface InkKeyEvent {
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly return?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly escape?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly tab?: boolean;
}

/** A printable code point keeps single-line input free of control bytes. */
function isPrintableCodePoint(code: number): boolean {
  if (code < 0x20) return false; // C0 controls + newline/tab
  if (code === 0x7f) return false; // DEL
  if (code >= 0x80 && code <= 0x9f) return false; // C1 controls
  return true;
}

/**
 * Fold one keypress into the input buffer. Returns the new buffer.
 * Only printable text and backspace/delete mutate it here; submit
 * (return), exit (ctrl-c / escape), and history nav are control
 * decisions the caller makes — this stays a pure string editor.
 */
export function editInputBuffer(buffer: string, input: string, key: InkKeyEvent): string {
  if (key.return || key.escape || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
    return buffer;
  }
  if (key.backspace || key.delete) {
    return buffer.slice(0, -1);
  }
  // Ignore control-key chords (ctrl-c etc.) and empty input.
  if (key.ctrl || key.meta || !input) {
    return buffer;
  }
  const printable = Array.from(input)
    .filter((ch) => isPrintableCodePoint(ch.codePointAt(0) ?? 0))
    .join("");
  return buffer + printable;
}

export interface ChatTurnMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * Assemble the model message list for one turn: system grounding,
 * prior turns, then the new user message. Mirrors the readline REPL so
 * both surfaces feed the model identically.
 */
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

export interface ParsedSlash {
  readonly cmd: string;
  readonly arg: string;
}

/**
 * Parse a `/command arg...` line. Returns `undefined` for ordinary
 * chat input so the caller can branch cleanly.
 */
export function parseSlashCommand(line: string): ParsedSlash | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const [cmd, ...rest] = trimmed.slice(1).split(/\s+/u);
  return { arg: rest.join(" ").trim(), cmd: (cmd ?? "").toLowerCase() };
}
