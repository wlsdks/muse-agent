/**
 * Deterministic element grounding — the single biggest lever for a
 * low-spec local model doing web control. Instead of making the 8B read a
 * 50-element snapshot and juggle numeric refs across turns, the model
 * names what it wants ("Sign in button", "search box") and THIS code maps
 * that description to the right element. Grounding lives in deterministic
 * code, not in the model (per `.claude/rules/tool-calling.md`: make the
 * first call correct; don't make the small model chain/observe-then-pick).
 *
 * Scoring (highest wins), case-insensitive:
 *   exact name           100
 *   prefix either way     80
 *   substring either way  60   (so "Sign in button" → "Sign in")
 *   shared words          20 + 10·overlap
 * then a small role bonus for the acting intent (button/link for click,
 * textbox for type). No match ⇒ undefined (the tool then re-reads / asks).
 */

import type { PageSnapshot, SnapshotElement } from "./controller.js";

const SETTLED_TEXT_MIN = 40;

/**
 * True when a snapshot looks like a not-yet-rendered SPA shell (no
 * interactive elements AND only a stub of text) — the controller then
 * waits briefly and re-observes instead of showing the model a blank page.
 */
export function looksUnsettled(snapshot: PageSnapshot): boolean {
  return snapshot.elements.length === 0 && snapshot.text.trim().length < SETTLED_TEXT_MIN;
}

export type MatchIntent = "click" | "type";

function tokens(value: string): string[] {
  return value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

function baseScore(name: string, target: string): number {
  if (name.length === 0) return 0;
  if (name === target) return 100;
  if (name.startsWith(target) || target.startsWith(name)) return 80;
  if (name.includes(target) || target.includes(name)) return 60;
  const targetWords = new Set(tokens(target));
  const overlap = tokens(name).filter((word) => targetWords.has(word)).length;
  return overlap > 0 ? 20 + overlap * 10 : 0;
}

function roleBonus(role: string, intent: MatchIntent): number {
  if (intent === "click" && (role === "button" || role === "link")) return 5;
  if (intent === "type" && (role === "textbox" || role === "combobox")) return 5;
  return 0;
}

export interface MatchResult {
  readonly element: SnapshotElement;
  readonly score: number;
}

/** Best element for a free-text `target`, or undefined when nothing matches. */
export function matchElement(
  elements: readonly SnapshotElement[],
  target: string,
  intent: MatchIntent
): SnapshotElement | undefined {
  const needle = target.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  let best: MatchResult | undefined;
  for (const element of elements) {
    const score = baseScore(element.name.toLowerCase(), needle) + (baseScore(element.name.toLowerCase(), needle) > 0 ? roleBonus(element.role, intent) : 0);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { element, score };
  }
  return best?.element;
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Best `<select>` option for a free-text choice, or undefined when nothing
 * matches — the dropdown analog of `matchElement`: the model names the option
 * ("Canada"), code picks it; an unmatchable option is refused, never guessed.
 */
export function matchOption(options: readonly SelectOption[], text: string): SelectOption | undefined {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  let best: { option: SelectOption; score: number } | undefined;
  for (const option of options) {
    const score = Math.max(
      baseScore(option.label.trim().toLowerCase(), needle),
      baseScore(option.value.trim().toLowerCase(), needle)
    );
    if (score <= 0) continue;
    if (!best || score > best.score) best = { option, score };
  }
  return best?.option;
}

/** Elements whose name loosely matches `query` — for a focused `browser_read`. */
export function filterElements(elements: readonly SnapshotElement[], query: string): readonly SnapshotElement[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return elements;
  return elements.filter((element) => baseScore(element.name.toLowerCase(), needle) > 0);
}
