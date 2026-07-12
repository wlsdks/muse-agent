/**
 * Pure matchers for the prompt-seam drift lint (scripts/check-prompt-seam.mjs),
 * extracted so they can be unit-tested directly (scripts/check-prompt-seam.test.mjs)
 * without running the whole filesystem walk.
 *
 * IDENTITY_STRING_PATTERNS was broadened past the original two exact literals
 * (/You are Muse/ and /너는 뮤즈/) — a paraphrase outside the seam ("I am Muse",
 * "저는 뮤즈입니다", "제 이름은 뮤즈") slipped through and re-opened the
 * divergent-identity-string drift the guard exists to close. These match a
 * first/second-person identity BINDING to the Muse name (EN + KO), not a mere
 * mention: "Muse is a local agent", "@muse/prompts", "you are musing" do NOT
 * trip. "Muse" stays capitalized (the product name always is) so lowercase
 * package paths (`@muse/…`) are never flagged.
 *
 * The name is `(?:Muse\b|뮤즈)` on BOTH copula/pronoun sides so the MIXED
 * scripts also trip — an EN copula bound to the KO name ("You are 뮤즈 (Muse)")
 * or a KO pronoun bound to the latin name ("너는 Muse야"). That EN+KO form is
 * exactly what once evaded this guard in a hand-rolled channel prompt.
 */

export const IDENTITY_STRING_PATTERNS = [
  /\b(?:I ?am|I['’`]?m|[Yy]ou ?are|[Yy]ou['’`]?re|(?:[Mm]y |[Yy]our )?name is)\s+(?:Muse\b|뮤즈)/u,
  /(?:너는|넌|나는|난|저는|제\s*이름은|내\s*이름은)\s*(?:뮤즈|Muse\b)/u
];

export const BUILD_SYSTEM_PROMPT_PATTERN = /\bbuildSystemPrompt\s*\(/u;

/** True when a source line hardcodes an identity self-assertion binding to the Muse name. */
export function lineAssertsIdentity(line) {
  return IDENTITY_STRING_PATTERNS.some((re) => re.test(line));
}

/** True when a source line calls buildSystemPrompt( directly (bypassing composeSurfacePrompt). */
export function lineCallsBuildSystemPrompt(line) {
  return BUILD_SYSTEM_PROMPT_PATTERN.test(line);
}
