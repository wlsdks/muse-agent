/**
 * Tool-output context-aware trimming (Context Engineering step 1.b,
 * round 161). Anthropic's effective-context-engineering guidance
 * names tool output as the #1 source of context bloat — a single
 * large tool result (file read, web fetch, DB query) can blow the
 * window in one call. This module provides a deterministic
 * truncation primitive that the agent runtime applies to every tool
 * result before it lands in the conversation.
 *
 * Strategy: head + tail preservation with an explicit elision
 * marker. The model still sees the start of the output (where most
 * tool results put their headline) and the end (where errors,
 * trailing summaries, and "more available" hints typically live).
 * The middle is replaced by `[truncated: …]` so the agent doesn't
 * mistake the truncation for the actual data. Original size is
 * surfaced so the agent can decide whether to re-fetch with
 * narrower scope.
 *
 * Design rules:
 *   - Pure string transform — no I/O, no allocation beyond what
 *     `slice` does.
 *   - Idempotent: trimming an already-trimmed string is a no-op
 *     (the marker is part of the string and is shorter than the
 *     cap by construction).
 *   - Conservative: when `maxChars <= 0` or already-fits, the
 *     original string is returned unchanged.
 *   - Reports `truncated: boolean` so callers can log /
 *     observability hook.
 */

export interface ToolOutputTrimOptions {
  /**
   * Maximum total characters of the returned `output` string,
   * INCLUDING the elision marker. When the original is already
   * within this cap, no trim happens.
   *
   * 0 or negative → no-op (treat as "no cap configured", returns
   * the original string unchanged).
   */
  readonly maxChars: number;
  /**
   * Fraction (0..1) of the budget to allocate to the head. The
   * tail gets the remaining `1 - headRatio`. Defaults to 0.7
   * — most tool results put the headline at the top, so keeping
   * more head than tail is the more useful default.
   */
  readonly headRatio?: number;
  /**
   * Optional hint string surfaced inside the elision marker.
   * Typical use: tool name + a re-fetch ID or instruction (e.g.
   * `"call muse.fs.read with offset=N to see more"`). Kept short
   * because it competes for the same budget.
   */
  readonly hint?: string;
}

export interface ToolOutputTrimResult {
  readonly output: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

const DEFAULT_HEAD_RATIO = 0.7;

export function trimToolOutput(input: string, options: ToolOutputTrimOptions): ToolOutputTrimResult {
  const originalLength = input.length;
  const maxChars = options.maxChars;
  if (maxChars <= 0 || originalLength <= maxChars) {
    return { output: input, truncated: false, originalLength };
  }

  const hint = (options.hint ?? "").trim();
  const elidedChars = originalLength - maxChars;
  // Marker carries: how many chars elided + total original size +
  // optional hint. Stable wording so downstream tooling can grep.
  const marker = hint.length > 0
    ? `\n\n[truncated: ${elidedChars} chars elided of ${originalLength} total — ${hint}]\n\n`
    : `\n\n[truncated: ${elidedChars} chars elided of ${originalLength} total]\n\n`;

  // If the marker itself is bigger than the cap (pathological tiny
  // budget), there's no point head/tail-splitting. Return marker only.
  if (marker.length >= maxChars) {
    return {
      output: marker.slice(0, maxChars),
      truncated: true,
      originalLength
    };
  }

  const remaining = maxChars - marker.length;
  const headRatio = clampRatio(options.headRatio ?? DEFAULT_HEAD_RATIO);
  const headChars = Math.max(0, Math.floor(remaining * headRatio));
  const tailChars = Math.max(0, remaining - headChars);
  const head = input.slice(0, headChars);
  const tail = tailChars > 0 ? input.slice(originalLength - tailChars) : "";
  return {
    output: `${head}${marker}${tail}`,
    truncated: true,
    originalLength
  };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_HEAD_RATIO;
  }
  return Math.min(1, Math.max(0, value));
}
