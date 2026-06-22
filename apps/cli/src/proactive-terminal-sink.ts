import { stripUntrustedTerminalChars } from "@muse/shared";
import type { ProactiveNoticeSink } from "@muse/proactivity";

/**
 * Render one proactive notice as a prompt-safe terminal line.
 *
 * `\r` + `\x1b[K` returns to column 0 and erases the line so the
 * notice overwrites a partially-typed `you> …` REPL prompt instead
 * of smearing into it; the caller redraws the prompt afterwards.
 * The text is third-party (LLM-synthesised, or a calendar/task
 * title) so it goes through the shared control-byte stripper before
 * it can emit raw escape sequences to the user's terminal.
 */
export function formatProactiveTerminalNotice(notice: {
  readonly text: string;
  readonly title: string;
  readonly kind: string;
}): string {
  return `\r\x1b[K${stripUntrustedTerminalChars(notice.text)}\n`;
}

export interface TerminalProactiveSinkDeps {
  readonly write: (chunk: string) => void;
  /**
   * Re-render the REPL prompt after the notice (e.g.
   * `() => rl.prompt(true)`). Omitted when there is no readline
   * prompt to restore (the foreground daemon just logs).
   */
  readonly redrawPrompt?: () => void;
}

export function createTerminalProactiveSink(deps: TerminalProactiveSinkDeps): ProactiveNoticeSink {
  return {
    deliver(notice): void {
      deps.write(formatProactiveTerminalNotice(notice));
      deps.redrawPrompt?.();
    }
  };
}
