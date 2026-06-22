/**
 * Chunk-shaping utilities for the recall corpus: passage splitting with
 * overlap, contextual chunk annotation, nearest-heading lookup, and the
 * "Lost in the Middle" relevance reorder. Orthogonal to ranking + grounding.
 */

import type { KnowledgeChunk } from "./knowledge-ranking.js";

/**
 * Reorder passages so the most relevant sit at the START and END and the
 * weakest land in the MIDDLE — "Lost in the Middle" (Liu et al. 2023,
 * arXiv:2307.03172): decoder LLMs attend most to a context's head and
 * tail and under-use the middle, which bites hardest on a small local
 * model. Pure: ranks by score desc, then places ranks 1,3,5… from the
 * front and 2,4,6… from the back. Shared by `muse ask` and
 * `renderKnowledgeMatches` so both surfaces reorder identically.
 */
export function reorderForLongContext<T extends { readonly score: number }>(items: readonly T[]): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const front: T[] = [];
  const back: T[] = [];
  sorted.forEach((item, i) => {
    if (i % 2 === 0) {
      front.push(item);
    } else {
      back.push(item);
    }
  });
  return [...front, ...back.reverse()];
}

/** The closest markdown heading PRECEDING the chunk's position in its note. */
export function nearestHeading(noteText: string, chunkText: string): string | undefined {
  // A chunk may carry an OVERLAP PREFIX (the tail of the previous chunk, joined
  // with a blank line by `applyOverlap`). That prefix is a copy of text that
  // appears EARLIER in the note, so `indexOf` of the chunk's first 80 chars
  // would resolve to the previous chunk's position and attribute the wrong
  // heading. Anchor on the chunk's OWN start instead: the overlap prefix is the
  // run before the first blank-line break, and it duplicates earlier text, so
  // strip it and locate by the remaining (un-overlapped) body.
  const at = locateChunkStart(noteText, chunkText);
  if (at < 0) return undefined;
  const before = noteText.slice(0, at);
  const headings = [...before.matchAll(/^#{1,6}[ \t]+(.+)$/gmu)];
  const last = headings[headings.length - 1]?.[1]?.trim();
  // The note TITLE (# h1) is carried by the source name already; prefer a
  // section heading, fall back to the title only when it is not the sole match.
  if (!last) return undefined;
  return last;
}

/**
 * Locate a chunk's OWN start offset in the note, tolerant of an overlap
 * prefix. `indexOf(slice(0,80))` works for a chunk that sits verbatim in the
 * note. An overlap chunk is `<tail>\n\n<body>` where `<tail>` is a duplicate of
 * earlier text and the `\n\n` join is synthetic — so the whole chunk does NOT
 * appear verbatim at the prefix's location. When the verbatim match fails,
 * strip the leading blank-line-delimited prefix and locate by the body, whose
 * un-overlapped start IS verbatim in the note.
 */
function locateChunkStart(noteText: string, chunkText: string): number {
  const wholeStart = noteText.indexOf(chunkText.slice(0, 80).trim());
  if (wholeStart >= 0 && noteText.startsWith(chunkText, wholeStart)) {
    return wholeStart;
  }
  const breakAt = chunkText.indexOf("\n\n");
  if (breakAt >= 0) {
    const body = chunkText.slice(breakAt + 2).trim();
    if (body.length > 0) {
      const bodyAt = noteText.indexOf(body.slice(0, 80));
      if (bodyAt >= 0) {
        return bodyAt;
      }
    }
  }
  return wholeStart;
}

/**
 * Contextual chunk annotation (Anthropic contextual retrieval, deterministic
 * slice): the EMBEDDED text gets "[<source> · <nearest heading>]" prepended so
 * a context-free chunk (a bare list under "## 준비물") keeps its referent in
 * embedding space; the stored/evidence text stays raw, so the grounding gate
 * and citations are unchanged.
 */
export function annotateNoteChunks(
  source: string,
  noteText: string,
  pieces: readonly string[]
): KnowledgeChunk[] {
  return pieces.map((piece) => {
    const heading = nearestHeading(noteText, piece);
    const context = heading ? `[${source} · ${heading}]` : `[${source}]`;
    return { embedText: `${context} ${piece}`, source, text: piece };
  });
}

/**
 * Split `text` into passages of at most `maxChars`, preferring
 * paragraph boundaries (blank lines) so a chunk stays coherent. A
 * single paragraph longer than `maxChars` is hard-split. Returns []
 * for empty input; a short text returns one chunk. This is what lets
 * a long note / ingested document be retrieved + cited PASSAGE-by-
 * passage instead of truncated to its first `maxChars`.
 *
 * `overlapChars` (optional, default 0 = no overlap, back-compat) adds
 * an OVERLAPPING WINDOW between consecutive chunks: the tail of chunk
 * i-1 is prepended to chunk i, so a fact straddling a boundary appears
 * WHOLE in at least one chunk and stays retrievable. Standard RAG /
 * dense-retrieval chunking practice (Karpukhin et al. 2020, "Dense
 * Passage Retrieval", arXiv:2004.04906, uses overlapping 100-word
 * passages). The overlap is added to chunks i ≥ 1, so they may
 * slightly exceed `maxChars` — embedding models tolerate this; the
 * limit is a soft target.
 */
export function chunkText(text: string, maxChars: number, overlapChars: number = 0): string[] {
  const trimmed = text.trim();
  const limit = Number.isFinite(maxChars) ? Math.max(1, Math.trunc(maxChars)) : 4_000;
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.length <= limit) {
    return [trimmed];
  }
  const paragraphs = trimmed.split(/\n{2,}/u).map((p) => p.trim()).filter((p) => p.length > 0);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += limit) {
        chunks.push(paragraph.slice(i, i + limit));
      }
      continue;
    }
    const candidate = current.length > 0 ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return applyOverlap(chunks, overlapChars);
}

/**
 * Post-process: prepend each chunk (after the first) with the tail of
 * the previous one, so a fact spanning a chunk boundary appears whole
 * in chunk i. Prefers to start the tail at a word boundary so it
 * doesn't begin mid-token. A 0/negative/no-op `overlap` returns the
 * input unchanged. Exported so other chunkers (the CLI notes-index
 * builder) apply the SAME overlapping window without reimplementing it.
 */
export function applyOverlap(chunks: readonly string[], overlap: number): string[] {
  const n = Number.isFinite(overlap) ? Math.max(0, Math.trunc(overlap)) : 0;
  if (n === 0 || chunks.length <= 1) {
    return [...chunks];
  }
  const out: string[] = [chunks[0] ?? ""];
  for (let i = 1; i < chunks.length; i += 1) {
    const tail = overlapTail(chunks[i - 1] ?? "", n);
    out.push(tail.length > 0 ? `${tail}\n\n${chunks[i] ?? ""}` : chunks[i] ?? "");
  }
  return out;
}

function overlapTail(chunk: string, overlap: number): string {
  if (chunk.length === 0) {
    return "";
  }
  const effective = Math.min(overlap, chunk.length);
  const tail = chunk.slice(-effective);
  // Start the tail at the first whitespace inside it so we don't begin
  // mid-token; if none lies in the front of the tail, return it raw
  // (better to keep the boundary context than to drop it entirely).
  const m = /\s+/u.exec(tail);
  if (m && m.index < Math.floor(effective * 0.3)) {
    return tail.slice(m.index + m[0].length);
  }
  return tail;
}
