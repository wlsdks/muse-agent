/**
 * Dominant-script-family classification for the held-out gates. nomic-embed-text
 * is English-centric and bridges Hangul / CJK / kana ↔ Latin weakly (a real
 * Korean string vs its English paraphrase scores ~0.39), so a cross-script
 * cosine comparison sits OUTSIDE the embedder's validity domain and would
 * false-reject legitimate bilingual self-improvement. The gates use this to skip
 * the cosine test for a pair whose dominant scripts differ.
 *
 * DOMINANT, not mere presence: a Korean sentence carrying a Latin loanword or
 * tool name ("JSON 형식으로 답해줘") is still Hangul-dominant, so it is not pulled
 * into a misleading cross-script comparison by one ASCII token — the bug a
 * presence-of-any-Latin test had.
 */

export type ScriptFamily = "hangul" | "han" | "kana" | "latin" | "none";

/** The script family with the most letters in `text` ("none" when it has no scripted letters). */
export function dominantScriptFamily(text: string): ScriptFamily {
  let hangul = 0;
  let han = 0;
  let kana = 0;
  let latin = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0xac00 && cp <= 0xd7a3) hangul += 1; // Hangul syllables
    else if (cp >= 0x1100 && cp <= 0x11ff) hangul += 1; // Hangul Jamo
    else if (cp >= 0x3040 && cp <= 0x30ff) kana += 1; // Hiragana + Katakana
    else if (cp >= 0x4e00 && cp <= 0x9fff) han += 1; // CJK Unified Ideographs
    else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) latin += 1; // A–Z a–z
  }
  const max = Math.max(hangul, han, kana, latin);
  if (max === 0) return "none";
  if (max === hangul) return "hangul";
  if (max === kana) return "kana";
  if (max === han) return "han";
  return "latin";
}

/**
 * True when both strings share a dominant script family the embedder can compare
 * meaningfully. When false, a semantic cosine gate must NOT be applied to the
 * pair (the comparison is unreliable) — fall back to keeping/covering it.
 */
export function comparableScript(a: string, b: string): boolean {
  const fa = dominantScriptFamily(a);
  return fa !== "none" && fa === dominantScriptFamily(b);
}
