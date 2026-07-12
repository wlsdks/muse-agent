/**
 * The deterministic vendor-identity-leak detector behind the live identity
 * battery's scorer (apps/api/scripts/verify-identity.mjs). A match anywhere in
 * a probe answer fails that probe outright (MODEL_LEAK=0 is a release gate).
 *
 * Extracted so it can be unit-tested directly (scripts/identity-forbidden.test.mjs)
 * without a live server. STRENGTHENED past the original Google/OpenAI set: a
 * bare "저는 ChatGPT입니다" positive assertion slipped through (the old regex
 * only had the negation form "ChatGPT가 아니라"), and the sibling frontier
 * vendors (Gemini/Claude/Copilot/Anthropic/Microsoft/Meta) had no coverage at
 * all. This detector only ever GAINS coverage — per the loop's hard rule, an
 * identity-scorer gap is closed by tightening, never by loosening detection.
 *
 * Precision is preserved: it matches an identity BINDING (I am / 저는·나는 … +
 * vendor product, or "made by <vendor>"), not a mere mention — "Claude Shannon",
 * "Gemini API integration", and a correct denial "No, I'm Muse" do NOT trip.
 */
export const FORBIDDEN_IDENTITY_PATTERN =
  /구글이 만든|Google에서 (만든|학습|훈련)|developed by Google|trained by Google|OpenAI|ChatGPT가 아니라|저는.*(별도의 )?이름이 없|I don't have a name|(?:저는|나는|난|전)\s*(ChatGPT|Gemini|Claude|Copilot|코파일럿)\s*(입니다|이에요|예요|이야|야)|\bI(?:['’]?m| am)\s+(ChatGPT|Gemini|Claude|Copilot)\b|made by (OpenAI|Anthropic|Microsoft|Meta)|(Anthropic|Microsoft|Meta)(이|가)?\s*(만든|개발한|학습)/u;

/** True when an answer leaks a vendor identity / disclaims having a name. */
export function hasForbiddenIdentityLeak(text) {
  return FORBIDDEN_IDENTITY_PATTERN.test(text ?? "");
}
