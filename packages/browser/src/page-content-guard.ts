/**
 * Neutralize injection vectors in untrusted browser page text BEFORE it reaches
 * the model — deterministic, not a prompt please-be-careful. Readable output is
 * preserved (prose is unchanged); only the structural attack tokens are defanged.
 */

// Case-insensitive literal boundary tokens, replaced with a fullwidth look-alike
// so an injected page can't forge/close the `<page>` wrapper below.
const PAGE_CLOSE_TAG = /<\/page>/giu;
const PAGE_OPEN_TAG = /<page>/giu;

// Breaks a live markdown link/image (`[text](url)` / `![alt](url)`) so the
// renderer never treats it as a fetchable image/link — a single inserted
// space keeps the surrounding prose readable.
const MARKDOWN_LINK_OPEN = /\]\(/gu;

// Canonical "ignore/disregard/forget/override ... previous/above/... instructions"
// override phrasing. The `{0,40}` gaps are bounded (not `.*`) so this can never
// catastrophically backtrack on adversarial input.
const INSTRUCTION_OVERRIDE = /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}?\b(previous|above|prior|preceding|earlier|all)\b[\s\S]{0,40}?\b(instruction|instructions|prompt|prompts|rule|rules|context|message|messages)\b/giu;

export function defangPageText(text: string): string {
  return text
    .replace(PAGE_CLOSE_TAG, "〈/page〉")
    .replace(PAGE_OPEN_TAG, "〈page〉")
    .replace(MARKDOWN_LINK_OPEN, "] (")
    .replace(INSTRUCTION_OVERRIDE, "[defanged-directive]");
}

/** Wrap page text in an explicit untrusted-data boundary, escaping any forged boundary inside. */
export function wrapPageContent(text: string): string {
  return `<page>\n${defangPageText(text)}\n</page>`;
}

/** Defang a short untrusted label (element name) — same token neutralization, no wrapping. */
export function defangElementName(name: string): string {
  return defangPageText(name);
}
