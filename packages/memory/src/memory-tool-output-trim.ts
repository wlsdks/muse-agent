/**
 * Tool-output context-aware trimming (Context Engineering step 1.b,
 * Anthropic's effective-context-engineering guidance
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
  /**
   * Optional query terms (typically derived from the latest user
   * message). When present AND a real line in the would-be-elided
   * MIDDLE contains one of these terms (case-insensitive), a bounded
   * window around that line is carved VERBATIM from the input into the
   * retained text — head/tail shrink so the total stays ≤ `maxChars`.
   *
   * This closes the ACON failure mode (arXiv:2510.00615): plain
   * head+tail elision loses the specific middle span that holds the
   * answer (Lost-in-the-Middle, arXiv:2307.03172). The window is never
   * synthesized — it is sliced from the real input.
   *
   * Absent OR no match → output is BYTE-IDENTICAL to the head+tail
   * behavior (the critical no-op safety property).
   */
  readonly anchorTerms?: readonly string[];
}

export interface ToolOutputTrimResult {
  readonly output: string;
  readonly truncated: boolean;
  readonly originalLength: number;
}

const DEFAULT_HEAD_RATIO = 0.7;
const INNER_ELISION = "\n\n[…]\n\n";

export function trimToolOutput(input: string, options: ToolOutputTrimOptions): ToolOutputTrimResult {
  const originalLength = input.length;
  const maxChars = options.maxChars;
  if (maxChars <= 0 || originalLength <= maxChars) {
    return { output: input, truncated: false, originalLength };
  }

  const hint = (options.hint ?? "").trim();
  // Marker carries: how many original chars are absent from the
  // retained head+tail + total original size + optional hint. Stable
  // wording so downstream tooling can grep.
  const markerFor = (elided: number): string =>
    hint.length > 0
      ? `\n\n[truncated: ${elided} chars elided of ${originalLength} total — ${hint}]\n\n`
      : `\n\n[truncated: ${elided} chars elided of ${originalLength} total]\n\n`;

  // Reserve space against the widest the marker can ever be: the
  // elided count is at most `originalLength` (zero content kept), so
  // a marker sized with `originalLength` is an upper bound on the
  // final one. Reserving against it lets us report the EXACT elided
  // count (computed from the real head/tail below) without the
  // circular "marker length depends on the number it prints" problem,
  // and guarantees the output never exceeds `maxChars`.
  const reservedMarker = markerFor(originalLength);

  // If even the marker can't fit the cap (pathological tiny budget),
  // there's no point head/tail-splitting. Return marker only.
  if (reservedMarker.length >= maxChars) {
    return {
      output: reservedMarker.slice(0, maxChars),
      truncated: true,
      originalLength
    };
  }

  const remaining = maxChars - reservedMarker.length;
  const headRatio = clampRatio(options.headRatio ?? DEFAULT_HEAD_RATIO);
  const headChars = Math.max(0, Math.floor(remaining * headRatio));
  const tailChars = Math.max(0, remaining - headChars);
  const head = input.slice(0, headChars);
  const tail = tailChars > 0 ? input.slice(originalLength - tailChars) : "";

  // Query-anchored retention: when an anchor term matches a line in the
  // would-be-elided middle, carve a bounded verbatim window around it.
  // The layout becomes `head|marker|window|inner|tail`: ONE full marker
  // (carrying the elided-count + hint) plus a short inner separator that
  // signals the window→tail gap, so the anchor case only pays the full
  // marker once. head/window/tail compete within the leftover budget.
  // Falls back to plain head+tail when there's no match or no room.
  const anchored = carveAnchorWindow(input, {
    anchorTerms: options.anchorTerms,
    contentBudget: maxChars - reservedMarker.length - INNER_ELISION.length,
    defaultHeadEnd: head.length,
    defaultTailStart: originalLength - tail.length,
    headRatio
  });
  if (anchored) {
    const elided = originalLength - anchored.head.length - anchored.window.length - anchored.tail.length;
    const marker = markerFor(elided);
    return {
      output: `${anchored.head}${marker}${anchored.window}${INNER_ELISION}${anchored.tail}`,
      truncated: true,
      originalLength
    };
  }

  const marker = markerFor(originalLength - head.length - tail.length);
  return {
    output: `${head}${marker}${tail}`,
    truncated: true,
    originalLength
  };
}

interface AnchorWindow {
  readonly head: string;
  readonly window: string;
  readonly tail: string;
}

/**
 * When an anchor term matches a line in the would-be-elided middle
 * (between `defaultHeadEnd` and `defaultTailStart`), carve a bounded
 * verbatim window around that line so the total stays within
 * `contentBudget` (the cap minus the two elision markers the anchored
 * layout prints). Returns `undefined` when there are no anchor terms,
 * no middle, no match, or no room — the caller then keeps the
 * byte-identical head+tail behavior.
 */
function carveAnchorWindow(
  input: string,
  args: {
    readonly anchorTerms: readonly string[] | undefined;
    readonly contentBudget: number;
    readonly defaultHeadEnd: number;
    readonly defaultTailStart: number;
    readonly headRatio: number;
  }
): AnchorWindow | undefined {
  const terms = (args.anchorTerms ?? [])
    .map((term) => term.toLowerCase())
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return undefined;
  }
  const { contentBudget, defaultHeadEnd, defaultTailStart, headRatio } = args;
  if (contentBudget <= 0 || defaultTailStart <= defaultHeadEnd) {
    return undefined;
  }

  const middle = input.slice(defaultHeadEnd, defaultTailStart);
  const middleLower = middle.toLowerCase();
  // Find the FIRST line in the middle whose content matches any anchor
  // term — deterministic, stable, lowercased compare.
  let lineStart = 0;
  let matchStart = -1;
  let matchEnd = -1;
  while (lineStart <= middle.length) {
    const nlRel = middleLower.indexOf("\n", lineStart);
    const lineEnd = nlRel === -1 ? middle.length : nlRel;
    const lineLower = middleLower.slice(lineStart, lineEnd);
    if (terms.some((term) => lineLower.includes(term))) {
      matchStart = defaultHeadEnd + lineStart;
      matchEnd = defaultHeadEnd + lineEnd;
      break;
    }
    if (nlRel === -1) {
      break;
    }
    lineStart = nlRel + 1;
  }
  if (matchStart === -1) {
    return undefined;
  }

  // The matched line is the priority claim on the budget; if it alone
  // exceeds the budget, take a bounded verbatim prefix of it. Whatever
  // is left splits into head/tail at the same head bias.
  const matchedLineLen = matchEnd - matchStart;
  const windowLen = Math.min(matchedLineLen, contentBudget);
  const window = input.slice(matchStart, matchStart + windowLen);
  const leftover = contentBudget - windowLen;
  const headBudget = Math.max(0, Math.min(matchStart, Math.floor(leftover * headRatio)));
  const tailBudget = Math.max(0, Math.min(input.length - matchEnd, leftover - headBudget));
  const head = input.slice(0, headBudget);
  const tail = tailBudget > 0 ? input.slice(input.length - tailBudget) : "";
  return { head, window, tail };
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_HEAD_RATIO;
  }
  return Math.min(1, Math.max(0, value));
}
