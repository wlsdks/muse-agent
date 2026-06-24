/**
 * MED-2 — bound the text handed to a TTS engine. A full agent answer can
 * run many pages; synthesizing all of it is slow, wastes the engine, and
 * no one wants ten minutes of speech. This caps the text at a sentence
 * boundary where possible (so speech ends on a complete thought), falling
 * back to a word boundary, then a hard cut, and appends an audible
 * "(truncated)" cue so the listener knows more text exists.
 *
 * Pure + deterministic. Byte-identical when the text already fits — the
 * common case — so short replies are never altered.
 */

const TRUNCATION_CUE = " (truncated)";

export function truncateForTts(text: string, maxChars = 8_000): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const window = text.slice(0, maxChars);
  // Prefer the last sentence terminator in the window, else the last word
  // break, else a hard cut — never mid-word if a space is available.
  const lastSentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  const cut = lastSentence > maxChars * 0.5
    ? lastSentence + 1
    : window.lastIndexOf(" ") > maxChars * 0.5
      ? window.lastIndexOf(" ")
      : maxChars;
  return `${text.slice(0, cut).trimEnd()}${TRUNCATION_CUE}`;
}
