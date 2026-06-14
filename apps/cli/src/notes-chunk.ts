import { applyOverlap } from "@muse/agent-core";

/**
 * Paragraph-ish chunking — split by blank lines, then pack into
 * <= chunkChars so each chunk is a coherent embedding target.
 * Tiny enough that re-chunking on schema change is cheap.
 *
 * A single paragraph longer than `chunkChars` (a wall of text, a code
 * block, a minified blob) is hard-wrapped first, so NO chunk exceeds
 * `chunkChars` — an oversized chunk would overflow the embedding
 * model's context and be silently truncated, dropping retrieval recall
 * for everything past the cutoff.
 */
export function chunkText(text: string, chunkChars: number, overlapChars: number = 0): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .flatMap((p) => hardWrap(p.trim(), chunkChars))
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let buf = "";
  for (const para of paras) {
    if (buf.length === 0) {
      buf = para;
    } else if (buf.length + 2 + para.length <= chunkChars) {
      buf = `${buf}\n\n${para}`;
    } else {
      chunks.push(buf);
      buf = para;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  // Overlapping window (default 0 = back-compat): keep a fact straddling a
  // chunk boundary whole in chunk i so the notes-index `muse ask` reads
  // stays retrievable across boundaries. Reuses the shared applyOverlap so
  // both chunkers (this + the knowledge corpus) behave identically.
  return applyOverlap(chunks, overlapChars);
}

/**
 * Break a paragraph longer than `max` into <= `max`-char pieces,
 * preferring the last whitespace in the window so words aren't cut
 * mid-token; an unbreakable run (e.g. a long URL or base64 blob) is
 * cut hard at `max`. Paragraphs already within `max` pass through.
 */
function hardWrap(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) {
    return paragraph.length > 0 ? [paragraph] : [];
  }
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const ws = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"), window.lastIndexOf("\t"));
    const cut = ws >= Math.floor(max * 0.6) ? ws : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces.filter((p) => p.length > 0);
}
