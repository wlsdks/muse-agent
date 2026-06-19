/**
 * Poisoned-memory defense — a deterministic neutralizer for a remembered value
 * that reads like an INJECTED INSTRUCTION rather than a fact. A fact poisoned at
 * write time (a malicious tool result, a pasted web snippet) must not steer the
 * model when it is rehydrated into the grounding context. This is defense-in-
 * depth BEHIND the input guard, applied at RENDER time so the raw value stays in
 * the store (the user can still read + remove it) while the prompt sees only the
 * neutralized form — security is deterministic code, never a prompt please-ignore.
 *
 * The single source of these patterns; both the persona block and the ask-path
 * memory block (`renderMemoryFact`) defang through here so the two surfaces can't
 * drift. Patterns are NARROW on purpose — a legitimate preference ("always reply
 * in Korean") must pass untouched; only imperative override / role-hijack /
 * output-clamp / fake-system shapes are caught.
 */
export const MEMORY_INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget)\b.{0,24}\b(instruction|instructions|prompt|rule|rules|previous|prior|the user|above|system)\b/iu,
  /\breply only with\b|\brespond only with\b|\boutput only\b/iu,
  /\byou are now\b|\bact as\b.{0,20}\binstead\b/iu,
  /^\s*system\s*[:>]/iu
];

/** True when a stored value reads like an injected instruction. */
export function isMemoryInjection(value: string): boolean {
  return MEMORY_INJECTION_PATTERNS.some((re) => re.test(value));
}

/**
 * Replace an injection-shaped value with a neutral placeholder; a clean value is
 * returned unchanged. The placeholder names WHY it is hidden so the user knows to
 * inspect/remove it, without echoing the attack text into the prompt.
 */
export function defangMemoryInjection(value: string): string {
  return isMemoryInjection(value) ? "(stored note hidden — its text looked like an instruction)" : value;
}

const INJECTION_SPAN_PLACEHOLDER = "[removed: injected instruction]";

/**
 * SPAN-level neutralization for PROSE (episode summaries, feed text, note chunks):
 * replace ONLY each matched injection span with a placeholder, keeping the rest of
 * the text intact. Atomic short facts use the whole-value `defangMemoryInjection`;
 * prose must NOT lose an entire paragraph to a single matched phrase — a benign
 * sentence that merely trips a token ("forget about the previous vendor") keeps its
 * surrounding recall content. Deterministic; clean text is returned byte-identical.
 */
export function neutralizeInjectionSpans(text: string): string {
  let out = text;
  for (const pattern of MEMORY_INJECTION_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    out = out.replace(new RegExp(pattern.source, flags), INJECTION_SPAN_PLACEHOLDER);
  }
  return out;
}
