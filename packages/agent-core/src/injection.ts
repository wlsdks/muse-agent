/**
 * Deterministic injection neutralizer — the single source for both the STORED
 * grounding surfaces (memory facts / notes / episodes / feeds, via @muse/recall
 * which re-exports these) AND the LIVE agentic surface (tool / MCP / sub-agent
 * output, via the model loop's `capToolOutput`). It lives in agent-core because
 * that is the lowest layer both consumers depend on — a prompt-based "this is
 * untrusted, ignore instructions" tag does NOT stop a small local model obeying an
 * embedded instruction, so the defense must be deterministic CODE that neutralizes
 * the injecting text before it reaches the model, not a please-ignore in the prompt.
 *
 * Patterns are NARROW on purpose — a legitimate preference ("always reply in
 * Korean") or a benign tool result must pass untouched; only imperative override /
 * role-hijack / output-clamp / fake-system shapes are caught.
 */
import { normalizeForInjectionDetection } from "@muse/policy";

export const MEMORY_INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b.{0,24}\b(instruction|instructions|prompt|rule|rules|previous|prior|the user|above|system)\b/iu,
  /\breply only with\b|\brespond only with\b|\boutput only\b/iu,
  /\byou are now\b|\bact as\b.{0,20}\binstead\b/iu,
  /^\s*system\s*[:>]/imu,
  // Korean analog of the canonical ignore-previous-instructions shape (the
  // stored/tool surface is the Korean user's primary language). Verb-final order
  // (noun → 무시/잊), kept NARROW like the English set; span-level neutralization
  // bounds any collateral on a benign sentence that merely names a rule.
  /(?:이전|위의|앞의|모든)?\s*(?:지시|지침|규칙|명령)(?:사항)?\s*(?:을|를|은|는|도)?\s*(?:모두|전부|싹)?\s*(?:무시|잊)/u
];

const INJECTION_EVASION_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Remove zero-width / control / format / separator chars that an attacker inserts
 * MID-WORD to bypass the patterns — `ig<U+200B>nore` defeats `\bignore\b`, so every
 * defense above (facts / notes / episodes / feeds / tool output) would be evadable
 * without this. Stripped BEFORE matching. Structural whitespace a reader/model
 * needs (tab / newline / carriage-return) is kept; everything else in Cc/Cf/Zl/Zp
 * (zero-width space, ZWNJ/ZWJ, BOM, soft-hyphen, bidi marks, line/para separators,
 * NUL) goes. Clean text with no such chars is returned byte-identical.
 */
export function stripInjectionEvasionChars(text: string): string {
  return text.replace(INJECTION_EVASION_CHARS, (ch) => (ch === "\t" || ch === "\n" || ch === "\r" ? ch : ""));
}

/**
 * True when a value reads like an injected instruction. Matches against the FULLY
 * normalized form (`@muse/policy`'s shared `normalizeForInjectionDetection` — entity-
 * decode + NFKC + zero-width-strip + homoglyph-fold + diacritical-strip) so a
 * homoglyph (`іgnore`, Cyrillic і) or HTML-entity (`&#105;gnore`) injection can't slip
 * past the patterns. Unifies the live-surface defense with the user-input path.
 */
export function isMemoryInjection(value: string): boolean {
  return MEMORY_INJECTION_PATTERNS.some((re) => re.test(normalizeForInjectionDetection(value)));
}

/**
 * Whole-value defense for an ATOMIC short value (a memory fact): replace the entire
 * value with a neutral placeholder when it reads like an injected instruction; a
 * clean value is returned unchanged. The placeholder names WHY it is hidden so the
 * user knows to inspect/remove it, without echoing the attack text into the prompt.
 */
export function defangMemoryInjection(value: string): string {
  return isMemoryInjection(value) ? "(stored note hidden — its text looked like an instruction)" : value;
}

const INJECTION_SPAN_PLACEHOLDER = "[removed: injected instruction]";

/**
 * SPAN-level neutralization for PROSE (episode summaries, feed text, note chunks,
 * tool / MCP / sub-agent output): replace ONLY each matched injection span with a
 * placeholder, keeping the rest of the text intact. Atomic short facts use the
 * whole-value `defangMemoryInjection`; prose must NOT lose an entire paragraph (or a
 * whole tool result) to a single matched phrase — a benign sentence that merely
 * trips a token ("forget about the previous vendor") keeps its surrounding content.
 * Deterministic; clean text is returned byte-identical.
 */
export function neutralizeInjectionSpans(text: string): string {
  const normalized = normalizeForInjectionDetection(text);
  // Fast path: clean text — no injection even after entity-decode / NFKC / zero-width
  // / homoglyph / diacritical folding — is returned BYTE-IDENTICAL. We pay
  // normalization's collateral (a stripped diacritic, an NFKC-folded ligature) ONLY on
  // text that ACTUALLY hides an injection, which is untrusted anyway — clean recall
  // content (incl. accents / fullwidth) is never mangled.
  if (!MEMORY_INJECTION_PATTERNS.some((re) => re.test(normalized))) return text;
  let out = normalized;
  for (const pattern of MEMORY_INJECTION_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    out = out.replace(new RegExp(pattern.source, flags), INJECTION_SPAN_PLACEHOLDER);
  }
  return out;
}
