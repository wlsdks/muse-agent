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
const TYPEABLE_ROLES = new Set(["textbox", "combobox", "searchbox"]);

const ORDINAL_WORDS: Record<string, number> = { fifth: 4, first: 0, fourth: 3, last: -1, second: 1, sixth: 5, third: 2 };

/**
 * A leading ordinal in the target ("the second Add to cart", "2nd result") →
 * {index, rest}. Used ONLY when `rest` actually matches several elements, so a
 * literal label like "First name" / "Last name" is never mis-stripped.
 */
function parseOrdinal(target: string): { readonly index: number; readonly rest: string } | undefined {
  const word = /^(?:the\s+)?(first|second|third|fourth|fifth|sixth|last)\s+(.+)$/iu.exec(target.trim());
  if (word) return { index: ORDINAL_WORDS[word[1]!.toLowerCase()]!, rest: word[2]! };
  const num = /^(?:the\s+)?(\d+)(?:st|nd|rd|th)\s+(.+)$/iu.exec(target.trim());
  if (num) return { index: Number.parseInt(num[1]!, 10) - 1, rest: num[2]! };
  return undefined;
}

/** Score every element for `needle` (>0 only), best first, DOM order for ties. */
function scoreAll(elements: readonly SnapshotElement[], needle: string, intent: MatchIntent): MatchResult[] {
  if (needle.length === 0) return [];
  return elements
    .map((element): MatchResult => {
      const base = baseScore(element.name.toLowerCase(), needle);
      return { element, score: base > 0 ? base + roleBonus(element.role, intent) : 0 };
    })
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score || a.element.ref - b.element.ref);
}

export function matchElement(
  elements: readonly SnapshotElement[],
  target: string,
  intent: MatchIntent
): SnapshotElement | undefined {
  // Ordinal targeting: among several identically-labelled controls (an "Add to
  // cart" per product row, the Nth search "View"), pick the requested one — but
  // ONLY when `rest` really has multiple matches, so "First name" stays literal.
  const ordinal = parseOrdinal(target);
  if (ordinal) {
    const rest = scoreAll(elements, ordinal.rest.trim().toLowerCase(), intent);
    const top = rest[0]?.score;
    const tied = top === undefined ? [] : rest.filter((scored) => scored.score === top);
    if (tied.length > 1) {
      const index = ordinal.index < 0 ? tied.length - 1 : ordinal.index;
      return (tied[index] ?? tied[tied.length - 1])?.element;
    }
  }
  const scored = scoreAll(elements, target.trim().toLowerCase(), intent);
  if (scored.length === 0) return undefined;
  // Typing into a button/link is a no-op that strands the whole task — for a
  // type intent ANY matching field beats a better-scoring untypeable element
  // ("search box" must mean the input, not the adjacent "Search" button).
  if (intent === "type") {
    const typeable = scored.find((scored) => TYPEABLE_ROLES.has(scored.element.role));
    if (typeable) return typeable.element;
  }
  return scored[0]!.element;
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
