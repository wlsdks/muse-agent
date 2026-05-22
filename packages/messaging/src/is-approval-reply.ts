/**
 * Does an inbound channel message read as a bare approval ("yes",
 * "approve", "go ahead", "응", …) of a previously-posted draft?
 *
 * Deliberately CONSERVATIVE: it matches only when the WHOLE trimmed
 * message is an affirmation (modulo surrounding punctuation/emoji), not
 * when a longer sentence merely contains "yes" — because this gates a
 * state-changing action, and a false positive must never let an
 * ambiguous message ("yes but change the subject") count as consent.
 */

const APPROVAL_PHRASES: ReadonlySet<string> = new Set([
  // English
  "y", "yes", "yes please", "yep", "yeah", "yup", "ya", "sure",
  "ok", "okay", "k", "approve", "approved", "confirm", "confirmed",
  "do it", "go ahead", "go", "send it", "send", "proceed", "accept", "accepted",
  // Korean
  "응", "어", "네", "예", "그래", "그래요", "승인", "보내", "보내줘", "진행"
]);

export function isApprovalReply(text: string): boolean {
  if (typeof text !== "string") {
    return false;
  }
  // Strip leading/trailing whitespace, punctuation, and common emoji
  // affirmations, collapse internal whitespace, lowercase.
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/^[\s.,!?"'`’“”()[\]👍✅🙏👌]+|[\s.,!?"'`’“”()[\]👍✅🙏👌]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) {
    return false;
  }
  return APPROVAL_PHRASES.has(normalized);
}
