/**
 * Multi-document knowledge recall (RAG) with source attribution.
 *
 * Episodic recall ranks ONE corpus (past conversation summaries).
 * This ranks a MULTI-source personal corpus — notes + ingested docs —
 * and keeps each passage's `source` so the agent can CITE which
 * document an answer came from. Source-agnostic by design: the caller
 * assembles `KnowledgeChunk`s from whatever stores it has (local
 * notes, an ingested PDF, …); the ranker only needs `{ source, text }`.
 *
 * Embedding-backed (cosine), local + zero-cost (Ollama in production,
 * a deterministic fake in tests). Reuses `cosineSimilarity` so the
 * scoring matches episodic recall.
 */

import type { MuseTool } from "@muse/tools";

import { cosineSimilarity } from "./episodic-recall.js";

export interface KnowledgeChunk {
  readonly source: string;
  readonly text: string;
}

export interface KnowledgeMatch {
  readonly source: string;
  readonly text: string;
  /** Ranking score. In hybrid mode this is the RRF-fused (rank-based) value, NOT an absolute relevance. */
  readonly score: number;
  /** Absolute cosine similarity to the query — the signal for retrieval-confidence grading (CRAG). */
  readonly cosine?: number;
}

export interface RankKnowledgeOptions {
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
  readonly minScore?: number;
  /**
   * Fuse the cosine ranking with a lexical (keyword-overlap) ranking
   * via Reciprocal Rank Fusion so an exact rare token (a name, an
   * error code, an ID) the embedding misses is still recalled. Default
   * off — the cosine-only behaviour is unchanged.
   */
  readonly hybrid?: boolean;
  /** RRF constant; larger = flatter rank weighting. Default 60. */
  readonly rrfK?: number;
  /**
   * Diversify the top-K with Maximal Marginal Relevance so near-
   * duplicate passages don't crowd out a distinct relevant one — the
   * agent's limited context sees varied grounding. Default off.
   */
  readonly diversify?: boolean;
  /**
   * MMR relevance/diversity trade-off in [0,1]; higher = more
   * relevance. Default 0.5 — a balanced split: at 0.7 real near-
   * duplicate notes (cosine ~0.95) still both surface (live-measured
   * on nomic-embed), so 0.5 is needed for the diversity penalty to
   * actually drop a paraphrase.
   */
  readonly mmrLambda?: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Drop high-frequency function words so lexical overlap (and the RRF
// lexical rank) keys on CONTENT terms — otherwise a decoy sharing only
// "my"/"is" with the query would be falsely recalled.
const LEXICAL_STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am", "to", "of",
  "in", "on", "for", "and", "or", "my", "your", "our", "what", "who", "how",
  "do", "does", "did", "you", "it", "this", "that", "with", "at", "by", "as",
  "me", "we", "i", "if", "so", "no", "not", "from", "about", "into", "than"
]);

export function lexicalTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[^a-z0-9]+/iu)
      .filter((token) => token.length >= 2 && !LEXICAL_STOPWORDS.has(token))
  );
}

export function lexicalOverlap(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const textTokens = lexicalTokens(text);
  let shared = 0;
  for (const token of queryTokens) {
    if (textTokens.has(token)) shared += 1;
  }
  return shared;
}

/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Büttcher, SIGIR 2009:
 * "Reciprocal Rank Fusion outperforms Condorcet and individual Rank
 * Learning Methods"). Each key's fused score is the sum over the input
 * rankings of `1 / (k + rank)` (rank 1-based), so a key ranked highly
 * by EITHER list surfaces. Deterministic, no training, no extra deps.
 */
export function fuseByReciprocalRank(rankings: ReadonlyArray<readonly string[]>, k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((key, index) => {
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

/**
 * Maximal Marginal Relevance (Carbonell & Goldstein, SIGIR 1998: "The
 * Use of MMR, Diversity-Based Reranking for Reordering Documents and
 * Producing Summaries"). Greedily picks the candidate maximising
 * `λ·relevance − (1−λ)·max cosine-similarity to the already-picked`, so
 * a near-duplicate of an already-selected passage is penalised and a
 * distinct relevant one surfaces. Deterministic, no deps.
 */
export function selectByMmr(
  candidates: ReadonlyArray<{ readonly key: string; readonly relevance: number; readonly embedding: readonly number[] }>,
  lambda: number,
  topK: number
): string[] {
  const pool = [...candidates];
  const selected: typeof pool = [];
  while (selected.length < topK && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    pool.forEach((candidate, index) => {
      const maxSim = selected.length === 0
        ? 0
        : Math.max(...selected.map((picked) => cosineSimilarity(candidate.embedding, picked.embedding)));
      const mmr = lambda * candidate.relevance - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = index;
      }
    });
    selected.push(pool[bestIndex]!);
    pool.splice(bestIndex, 1);
  }
  return selected.map((candidate) => candidate.key);
}

/**
 * Rank `chunks` from multiple sources by cosine similarity to `query`.
 * Returns the top-K matches (each carrying its `source`), highest
 * score first. Empty query / corpus → no matches; sub-threshold
 * passages are dropped so an irrelevant corpus doesn't fabricate a
 * citation.
 */
export async function rankKnowledgeChunks(
  query: string,
  chunks: readonly KnowledgeChunk[],
  options: RankKnowledgeOptions
): Promise<KnowledgeMatch[]> {
  const topK = Math.max(1, Math.trunc(finiteOr(options.topK, 3)));
  const minScore = Math.max(0, finiteOr(options.minScore, 0.1));
  if (query.trim().length === 0 || chunks.length === 0) {
    return [];
  }
  const queryVec = await options.embed(query);

  if (options.hybrid === true) {
    const rrfK = Math.max(1, Math.trunc(finiteOr(options.rrfK, 60)));
    const queryTokens = lexicalTokens(query);
    const key = (chunk: KnowledgeChunk): string => `${chunk.source}\u0000${chunk.text}`;
    const cosByKey = new Map<string, number>();
    const lexByKey = new Map<string, number>();
    const embByKey = new Map<string, readonly number[]>();
    const byKey = new Map<string, KnowledgeChunk>();
    for (const chunk of chunks) {
      const k = key(chunk);
      byKey.set(k, chunk);
      const embedding = await options.embed(chunk.text);
      embByKey.set(k, embedding);
      cosByKey.set(k, cosineSimilarity(queryVec, embedding));
      lexByKey.set(k, lexicalOverlap(queryTokens, chunk.text));
    }
    const cosRanked = [...cosByKey.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const lexRanked = [...lexByKey.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const fused = fuseByReciprocalRank([cosRanked, lexRanked], rrfK);
    // A passage earns a citation only with a real signal: cosine above
    // threshold OR any lexical overlap — so an irrelevant corpus still
    // fabricates nothing.
    const eligible = [...byKey.keys()].filter((k) => (cosByKey.get(k) ?? 0) >= minScore || (lexByKey.get(k) ?? 0) > 0);
    eligible.sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0));
    const toMatch = (k: string): KnowledgeMatch => {
      const chunk = byKey.get(k)!;
      return { cosine: cosByKey.get(k) ?? 0, score: fused.get(k) ?? 0, source: chunk.source, text: chunk.text };
    };
    if (options.diversify === true && eligible.length > topK) {
      const lambda = Math.min(1, Math.max(0, finiteOr(options.mmrLambda, 0.5)));
      const order = selectByMmr(
        eligible.map((k) => ({ embedding: embByKey.get(k) ?? [], key: k, relevance: fused.get(k) ?? 0 })),
        lambda,
        topK
      );
      return order.map(toMatch);
    }
    return eligible.slice(0, topK).map(toMatch);
  }

  const scored: Array<{ readonly match: KnowledgeMatch; readonly embedding: readonly number[] }> = [];
  for (const chunk of chunks) {
    const embedding = await options.embed(chunk.text);
    const score = cosineSimilarity(queryVec, embedding);
    if (score < minScore) {
      continue;
    }
    scored.push({ embedding, match: { cosine: score, score, source: chunk.source, text: chunk.text } });
  }
  if (options.diversify === true && scored.length > topK) {
    const lambda = Math.min(1, Math.max(0, finiteOr(options.mmrLambda, 0.7)));
    const order = selectByMmr(
      scored.map((entry, index) => ({ embedding: entry.embedding, key: String(index), relevance: entry.match.score })),
      lambda,
      topK
    );
    return order.map((key) => scored[Number(key)]!.match);
  }
  scored.sort((a, b) => b.match.score - a.match.score);
  return scored.slice(0, topK).map((entry) => entry.match);
}

/**
 * Render matches for the agent as a passage list, each labelled with
 * its `[source]` and instructed to cite it. The labelling is what
 * lets a grounded answer attribute its claim to the right document.
 */
/**
 * Reorder relevance-ranked items so the MOST relevant sit at the
 * edges of the list (first + last) and the least relevant in the
 * middle, because language models attend best to the start and end of
 * their context and worst to the middle (Liu et al. 2023, "Lost in the
 * Middle: How Language Models Use Long Contexts", arXiv 2307.03172).
 * Input must be sorted best-first. Deterministic, no deps.
 */
export function edgeLoadByRelevance<T>(ranked: readonly T[]): T[] {
  const out = new Array<T>(ranked.length);
  let front = 0;
  let back = ranked.length - 1;
  ranked.forEach((item, index) => {
    if (index % 2 === 0) {
      out[front] = item;
      front += 1;
    } else {
      out[back] = item;
      back -= 1;
    }
  });
  return out;
}

export type RetrievalConfidence = "confident" | "ambiguous" | "none";

// Default top-cosine bar for "confident". Calibrated live on nomic-embed-text:
// a clearly-relevant personal note scored ~0.61 while personal distractors
// scored ~0.44–0.51, so 0.55 splits them. BEST-EFFORT only — nomic's cosine
// space is compressed (even unrelated encyclopedic text can score ~0.54), so
// this flags weak personal grounding, it is NOT a hard relevant/irrelevant cut.
const DEFAULT_CONFIDENT_AT = 0.55;

/**
 * CRAG (arXiv 2401.15884): a lightweight retrieval evaluator grades whether
 * the retrieved evidence is trustworthy. Deterministic local version — the
 * verdict comes from the TOP match's ABSOLUTE cosine (not the RRF score):
 * `confident` ≥ `confidentAt`, `ambiguous` when some match is present but
 * weak, `none` when nothing was retrieved. The caller frames/gates by it so a
 * weak match isn't presented to the small model as something to cite.
 */
export function classifyRetrievalConfidence(
  matches: readonly KnowledgeMatch[],
  options?: { readonly confidentAt?: number }
): RetrievalConfidence {
  if (matches.length === 0) {
    return "none";
  }
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const top = Math.max(...matches.map((match) => match.cosine ?? match.score));
  return top >= confidentAt ? "confident" : "ambiguous";
}

export function renderKnowledgeMatches(matches: readonly KnowledgeMatch[], options?: { readonly confidentAt?: number }): string {
  if (matches.length === 0) {
    return "No matching passages found in the personal corpus.";
  }
  const verdict = classifyRetrievalConfidence(matches, options);
  const header = verdict === "ambiguous"
    ? "Possibly-related passages (LOW confidence — verify before relying; do not cite as established fact):"
    : "Relevant passages — cite the [source] you use:";
  const lines = [header];
  // Edge-place the passages (strongest at the head + tail, weakest in the
  // middle) so the local model attends to the best grounding — same
  // "Lost in the Middle" reorder `muse ask` applies to its notes block.
  for (const match of reorderForLongContext(matches)) {
    lines.push(`— [${match.source}] ${match.text}`);
  }
  return lines.join("\n");
}

const CITATION_RE = /\[from\s+([^\]]+?)\s*\]/giu;

/** Every source the text cites via a `[from <source>]` token, trimmed, in order. */
export function citedSourcesIn(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const src = match[1]?.trim();
    if (src) out.push(src);
  }
  return out;
}

export interface CitationEnforcement {
  /** The answer with every invented `[from <source>]` citation removed. */
  readonly text: string;
  /** The invented sources that were stripped — cited but not among the real ones shown. */
  readonly stripped: readonly string[];
}

export interface AllowedCitations {
  /** `[from <source>]` — note files; exact match (filenames are identifiers). */
  readonly notes?: readonly string[];
  /** `[feed: <name>]` — subscribed feeds; exact match. */
  readonly feeds?: readonly string[];
  /** `[task: <title>]` — open tasks; content-token overlap (the model may reword the title). */
  readonly tasks?: readonly string[];
  /** `[event: <title>]` — upcoming events; content-token overlap. */
  readonly events?: readonly string[];
  /** `[reminder: <text>]` — pending reminders; content-token overlap. */
  readonly reminders?: readonly string[];
  /** `[session: <summary>]` — retrieved past-session summaries; content-token overlap (the model rewrites the recap). */
  readonly sessions?: readonly string[];
}

function resolvesExact(value: string, allowed: readonly string[]): boolean {
  const v = value.trim().toLowerCase();
  return allowed.some((item) => item.trim().toLowerCase() === v);
}

// Free-text citations (task/event/reminder titles): the model may PARAPHRASE
// the title, so an exact match would false-strip a real one. A citation
// resolves when it shares any CONTENT token with a real item of that type; a
// wholly-invented title (no overlap with anything the user has) is stripped.
function resolvesByOverlap(value: string, allowed: readonly string[]): boolean {
  const tokens = lexicalTokens(value);
  if (tokens.size === 0) {
    return false;
  }
  return allowed.some((item) => {
    const itemTokens = lexicalTokens(item);
    for (const token of tokens) {
      if (itemTokens.has(token)) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Output-side grounding gate for the recall WEDGE — the code-not-model half of
 * "shows its work". Strips ANY citation the answer makes — `[from <note>]`,
 * `[feed: <name>]`, `[task|event|reminder: <title>]` — whose target is NOT
 * among the real sources Muse actually showed the model, so a fabricated
 * citation to something the user doesn't have can never reach them BY CODE
 * (mirrors `parseReflections` / `parseCouncilAnswer`). Notes + feeds match
 * exactly (they are identifiers); the free-text title forms match on
 * content-token overlap so a paraphrased-but-real citation survives — including
 * `[session: …]`, matched against the retrieved past-session summaries.
 */
export function enforceAnswerCitations(answer: string, allowed: AllowedCitations): CitationEnforcement {
  let text = answer;
  const stripped: string[] = [];
  const strip = (re: RegExp, resolves: (value: string) => boolean): void => {
    text = text.replace(re, (match: string, raw: string) => {
      const value = raw.trim();
      if (resolves(value)) {
        return match;
      }
      stripped.push(value);
      return "";
    });
  };
  strip(CITATION_RE, (value) => resolvesExact(value, allowed.notes ?? []));
  strip(/\[feed:\s*([^\]]+?)\s*\]/giu, (value) => resolvesExact(value, allowed.feeds ?? []));
  strip(/\[task:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.tasks ?? []));
  strip(/\[event:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.events ?? []));
  strip(/\[reminder:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.reminders ?? []));
  strip(/\[session:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.sessions ?? []));
  text = text
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/[ \t]+([.,;!?])/gu, "$1")
    .replace(/[ \t]+\n/gu, "\n");
  return { stripped, text };
}

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

/**
 * Memoize an embedder by input text so repeated chunks (a corpus is
 * mostly stable across queries) are embedded ONCE, not on every
 * `knowledge_search` call — the responsiveness fix for embedding the
 * whole personal corpus per query. The cached value is the Promise
 * (so concurrent calls dedupe); a rejected embed is evicted so a
 * transient Ollama failure isn't cached forever. Bounded FIFO.
 */
export function createCachingEmbedder(
  embed: (text: string) => Promise<readonly number[]>,
  options: { readonly maxEntries?: number } = {}
): (text: string) => Promise<readonly number[]> {
  const maxEntries = Math.max(1, Math.trunc(finiteOr(options.maxEntries, 4_096)));
  const cache = new Map<string, Promise<readonly number[]>>();
  return (text: string) => {
    const hit = cache.get(text);
    if (hit) {
      return hit;
    }
    const pending = Promise.resolve().then(() => embed(text));
    pending.catch(() => cache.delete(text));
    cache.set(text, pending);
    if (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    return pending;
  };
}

export interface KnowledgeSearchToolOptions {
  readonly corpus: readonly KnowledgeChunk[];
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
}

/**
 * A read-only `knowledge_search` tool the agent can call to ground an
 * answer in the user's multi-document personal corpus. Returns the
 * matching passages with their `[source]` labels.
 */
export function createKnowledgeSearchTool(options: KnowledgeSearchToolOptions): MuseTool {
  return {
    definition: {
      description: "Search the user's personal knowledge corpus (notes + ingested documents). Returns matching passages, each labelled with its [source] — cite the source you use. Use when the user asks about something they may have written down or saved; do not use for general knowledge or live web data.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          query: {
            description: "What to look up, in natural language — e.g. 'my health insurance policy number' or 'notes from the Q3 launch'.",
            type: "string"
          }
        },
        required: ["query"],
        type: "object"
      },
      name: "knowledge_search",
      risk: "read"
    },
    execute: async (args) => {
      const query = typeof (args as { query?: unknown }).query === "string" ? (args as { query: string }).query : "";
      const matches = await rankKnowledgeChunks(query, options.corpus, {
        diversify: true,
        embed: options.embed,
        hybrid: true,
        ...(options.topK !== undefined ? { topK: options.topK } : {})
      });
      return renderKnowledgeMatches(edgeLoadByRelevance(matches));
    }
  };
}
