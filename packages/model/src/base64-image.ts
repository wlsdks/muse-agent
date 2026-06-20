/**
 * Transport-seam image integrity for the vision surface.
 *
 * Ollama's `/api/chat` forwards a per-message `images: [base64]` array and
 * SILENTLY drops any entry it can't decode — then answers from the text prompt
 * alone, producing a confident "vision" answer the model formed WITHOUT seeing
 * the image (an ungrounded-answer source at the transport seam). The fix is to
 * refuse a malformed attachment in code BEFORE it ships, so a message carrying
 * only unusable images sends with NO images and downstream grounding fails
 * closed instead of fabricating.
 *
 * `isWellFormedBase64` is the deterministic gate: canonical RFC-4648 base64
 * only — `[A-Za-z0-9+/]` with `=` padding allowed ONLY at the end, total length
 * a multiple of 4, no embedded whitespace. A `data:<mime>;base64,…` prefix is
 * REJECTED (not stripped) because `VisionExtractInput` documents "no data:
 * prefix"; enforcing it loudly here surfaces a contract violation instead of
 * masking it.
 */
const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

export function isWellFormedBase64(s: string): boolean {
  if (s.length === 0) {
    return false;
  }
  if (s.length % 4 !== 0) {
    return false;
  }
  return CANONICAL_BASE64.test(s);
}
