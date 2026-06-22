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
 *
 * The cohesive sub-domains live in sibling modules and are RE-EXPORTED here so
 * every existing `./knowledge-recall.js` import keeps resolving:
 * - `recall-lexical.js`     — shared lexical scoring primitives.
 * - `knowledge-ranking.js`  — the retrieval ranker family.
 * - `recall-confidence.js`  — the retrieval-confidence graders.
 * - `grounding-citations.js`— citation provenance + source-trust.
 * - `grounding-verifier.js` — the test-time grounding verifier.
 * - `recall-chunking.js`    — chunk-shaping utilities.
 * - `evidence-conflicts.js` — pairwise evidence analysis.
 */

import type { MuseTool } from "@muse/tools";

import { buildNoteLinkGraph, personalizedPageRank } from "./associative-recall.js";
import { cosineSimilarity } from "./episodic-recall.js";
import {
  type AllowedCitations,
  CITATION_RE,
  type CitationEnforcement
} from "./grounding-citations.js";
import {
  DEFAULT_ANSWERABILITY_FLOOR,
  DEFAULT_COVERAGE_FLOOR,
  type GroundingVerification,
  unionContentTokens,
  verifyGrounding,
  type VerifyGroundingOptions
} from "./grounding-verifier.js";
import {
  type KnowledgeChunk,
  type KnowledgeMatch,
  rankKnowledgeChunks,
  type RankKnowledgeOptions
} from "./knowledge-ranking.js";
import { reorderForLongContext } from "./recall-chunking.js";
import { classifyRetrievalConfidence, DEFAULT_CONFIDENT_AT } from "./recall-confidence.js";
import { finiteOr, fuseByReciprocalRank, LEXICAL_STOPWORDS, lexicalTokens } from "./recall-lexical.js";
import { comparableScript } from "./script-family.js";

// Re-exports preserving the original public surface (symbols NOT used in this
// module's body — locally-used moved symbols are re-exported at the end).
export {
  bm25Scores,
  lexicalOverlap
} from "./recall-lexical.js";
export {
  selectByMarginalValue,
  selectByMmr,
  selectByScoreGap
} from "./knowledge-ranking.js";
export {
  resolveRecallConfidentAt,
  type RetrievalConfidence
} from "./recall-confidence.js";
export {
  citedSourcesIn,
  evidenceIsUntrustedOnly,
  groundedOnUntrustedOnly,
  trustBySourceMap
} from "./grounding-citations.js";
export {
  type BestGroundedDraft,
  type GroundingRubric,
  type GroundingVerdict,
  selectBestGroundedDraft
} from "./grounding-verifier.js";
export {
  annotateNoteChunks,
  applyOverlap,
  chunkText,
  nearestHeading
} from "./recall-chunking.js";
export {
  type ContradictionPair,
  detectEvidenceContradictions,
  detectPairwiseContradictions
} from "./evidence-conflicts.js";

// Locally-used moved symbols re-exported so existing `./knowledge-recall.js`
// imports of them keep resolving.
export {
  CITATION_RE,
  classifyRetrievalConfidence,
  DEFAULT_CONFIDENT_AT,
  fuseByReciprocalRank,
  type GroundingVerification,
  type KnowledgeChunk,
  type KnowledgeMatch,
  lexicalTokens,
  rankKnowledgeChunks,
  type RankKnowledgeOptions,
  reorderForLongContext,
  verifyGrounding,
  type VerifyGroundingOptions
};
export type { AllowedCitations, CitationEnforcement };

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

/**
 * SET-LEVEL semantic sufficiency: a multi-part query is only covered when EVERY
 * sub-query has at least one passage above the coverage bar. A single strong
 * passage on sub-query A does not cover sub-query B — the top-cosine signal
 * misses this gap and the model fabricates the uncovered half.
 *
 * Sufficient Context (arXiv:2411.06037, Joren/Zhang/Ferng/Juan/Taly/Rashtchian,
 * ICLR 2025): sufficiency is a SET-LEVEL property orthogonal to per-passage
 * relevance; when context is insufficient, models fabricate instead of
 * abstaining.
 *
 * ADVISORY-ONLY: the result is never used to block an answer or relax the
 * citation gate. It powers one honest caveat naming the uncovered parts.
 * MULTI-PART-GATED: returns sufficient:true for single-intent queries — those
 * are the confidence gate's job.
 * FAIL-OPEN: degenerate/empty vecs → cosineSimilarity returns 0 → insufficient
 * → but empty subQueries or length<2 → sufficient:true.
 */
export interface SufficiencyVerdict {
  readonly sufficient: boolean;
  readonly coveredFraction: number;
  readonly uncovered: readonly string[];
}

export function assessContextSufficiency(
  subQueries: ReadonlyArray<{ readonly text: string; readonly vec: readonly number[] }>,
  evidenceVecs: readonly (readonly number[])[],
  options?: { readonly coverAt?: number; readonly sufficientAt?: number }
): SufficiencyVerdict {
  // Single-intent no-op: per-passage confidence gate already handles this.
  if (subQueries.length < 2) {
    return { sufficient: true, coveredFraction: 1, uncovered: [] };
  }
  // coverAt reuses DEFAULT_CONFIDENT_AT (0.55): calibrated on nomic-embed-text
  // against real personal notes — same bar used by classifyRetrievalConfidence.
  const coverAt = finiteOr(options?.coverAt, DEFAULT_CONFIDENT_AT);
  const sufficientAt = finiteOr(options?.sufficientAt, 1.0);

  const uncovered: string[] = [];
  for (const sq of subQueries) {
    let maxSim = 0;
    for (const ev of evidenceVecs) {
      const sim = cosineSimilarity(sq.vec as number[], ev as number[]);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim < coverAt) {
      uncovered.push(sq.text);
    }
  }

  const covered = subQueries.length - uncovered.length;
  const coveredFraction = covered / subQueries.length;
  return {
    sufficient: coveredFraction >= sufficientAt,
    coveredFraction,
    uncovered
  };
}

// Near-tie band (cosine units) for the clarify gate. Two DISTINCT sources whose
// top cosines sit within this band are "equally relevant" — the open question is
// WHICH the user meant, not whether the corpus covers it. Tight (vs
// CONFIDENCE_MIN_MARGIN's 0.08) so only a genuine tie fires, never a clear lead;
// calibrated against nomic's compressed cosine space.
const DEFAULT_CLARIFY_TIE_MARGIN = 0.03;

export interface RecallClarification {
  /** True when distinct sources are equally-strong enough that asking beats guessing. */
  readonly clarify: boolean;
  /** The distinct divergent sources to offer, strongest first (empty unless `clarify`). */
  readonly sources: readonly string[];
  /** Why it did or didn't fire — for logging / tests. */
  readonly reason: string;
}

/**
 * Expected-information-gain gate (Lindley 1956, "On a Measure of the Information
 * Provided by an Experiment"; Howard 1966, value of perfect information): when
 * several retrieved sources are each independently strong, come from DISTINCT
 * sources, and are nearly TIED, the residual uncertainty is over WHICH reading
 * the user meant — so a single clarifying question carries the highest expected
 * information gain, more than silently answering the top one (it may be the wrong
 * reading) or abstaining (the corpus DOES cover it). One dominant source ⇒ low
 * entropy ⇒ just answer; nothing strong ⇒ abstain. Pure + deterministic so the
 * small model can't flake the decision — the THIRD arm of the recall wedge
 * (answer / clarify / abstain), alongside `classifyRetrievalConfidence`.
 */
export function decideRecallClarification(
  matches: readonly KnowledgeMatch[],
  options?: { readonly confidentAt?: number; readonly tieMargin?: number; readonly maxSources?: number }
): RecallClarification {
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const tieMargin = Math.max(0, finiteOr(options?.tieMargin, DEFAULT_CLARIFY_TIE_MARGIN));
  const maxSources = Math.max(2, Math.trunc(finiteOr(options?.maxSources, 3)));
  // Best score per DISTINCT source: several chunks of the SAME note are one
  // candidate, not a tie — there is no ambiguity within a single source.
  const bestBySource = new Map<string, number>();
  for (const match of matches) {
    const value = match.cosine ?? match.score;
    const prev = bestBySource.get(match.source);
    if (prev === undefined || value > prev) bestBySource.set(match.source, value);
  }
  const strong = [...bestBySource.entries()]
    .filter(([, value]) => value >= confidentAt)
    .sort((left, right) => right[1] - left[1]);
  if (strong.length < 2) {
    return { clarify: false, reason: strong.length === 1 ? "one dominant source — answer it" : "no strong source — abstain", sources: [] };
  }
  const top = strong[0]![1];
  const tied = strong.filter(([, value]) => top - value <= tieMargin);
  if (tied.length < 2) {
    return { clarify: false, reason: "top source clearly leads — answer it", sources: [] };
  }
  return {
    clarify: true,
    reason: `${tied.length.toString()} distinct sources within ${tieMargin.toString()} of the top — high expected information gain from clarifying`,
    sources: tied.slice(0, maxSources).map(([source]) => source)
  };
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
 * Rewrite the local model's natural-but-wrong contact citations to the
 * canonical `[contact: <name>]` form the gate accepts — BEFORE
 * `enforceAnswerCitations` runs. A `<<contact N — id>>` wrapper is a structural
 * sibling of the `<<note N — file>>` wrapper the model cites as `[from file]`,
 * so qwen3:8b tends to cite a contact with the note verb or by slot/id —
 * `[from contact 1]`, `[from contact: mina]`, `[contact 1]` — which the
 * exact-match note gate then false-strips, firing a spurious "treat as
 * unverified" warning on a correctly-grounded answer about the user's OWN
 * address book. This maps every "contact"-anchored mis-form to
 * `[contact: <name>]` by code: an in-range slot number, or an id / name that
 * token-overlaps a real matched contact, resolves to that contact's name; an
 * unresolvable reference (`[from contact 9]`) is left untouched for the gate to
 * strip. Pure + deterministic; only touches a citation whose first token is
 * literally `contact`, so a real `[from contacts.md]` note citation is never
 * rewritten.
 */
export function normalizeContactCitations(
  answer: string,
  contacts: ReadonlyArray<{ readonly id: string; readonly name: string }>
): string {
  if (contacts.length === 0) {
    return answer;
  }
  const resolveName = (ref: string): string | undefined => {
    const trimmed = ref.trim();
    if (/^\d+$/u.test(trimmed)) {
      const slot = Number(trimmed);
      return slot >= 1 && slot <= contacts.length ? contacts[slot - 1]?.name : undefined;
    }
    const low = trimmed.toLowerCase();
    const exact = contacts.find((c) => c.id.toLowerCase() === low || c.name.toLowerCase() === low);
    if (exact) {
      return exact.name;
    }
    const refTokens = lexicalTokens(trimmed);
    if (refTokens.size === 0) {
      return undefined;
    }
    const overlap = contacts.find((c) => {
      const nameTokens = lexicalTokens(c.name);
      for (const token of refTokens) {
        if (nameTokens.has(token)) {
          return true;
        }
      }
      return false;
    });
    return overlap?.name;
  };
  const withContactVerb = answer.replace(
    /\[\s*(?:from\s+)?contact\s*(?:[:#-]\s*|\s+)([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => {
      const name = resolveName(ref);
      return name ? `[contact: ${name}]` : match;
    }
  );
  // Also catch the bare NOTE-verb form `[from <X>]` where <X> is the raw
  // `contact_<uuid>` id (or the full contact name) the model echoed — the
  // `contact`-anchored pass above misses it because the id is `contact_<uuid>`
  // (no "contact" + separator). Only an EXACT id / name match is rewritten
  // (separator- and case-insensitive, never a fuzzy token overlap), so a real
  // `[from note.md]` is never mistaken for a contact.
  const normRef = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  const exactContactName = (ref: string): string | undefined => {
    const low = ref.trim().toLowerCase();
    const n = normRef(ref);
    const hit = contacts.find((c) => c.id.toLowerCase() === low || normRef(c.id) === n || normRef(c.name) === n);
    return hit?.name;
  };
  return withContactVerb.replace(
    /\[from\s+([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => {
      const name = exactContactName(ref);
      return name ? `[contact: ${name}]` : match;
    }
  );
}

/**
 * Rewrite a remembered-fact cited with the NOTE verb to the canonical
 * `[memory: <key>]` form — the local model (especially in Korean, where the
 * `[memory: …]` hint block isn't injected because the query doesn't lexically
 * match the English fact key) tends to cite a fact it knows from the persona as
 * `[from car_license_plate]`, which the exact-match note gate then false-strips.
 * Only a `[from <X>]` whose `<X>` EXACTLY matches a known memory key (separator /
 * case-insensitive) is rewritten; a real `[from note.md]` is left untouched, so a
 * note citation is never mistaken for a memory.
 */
export function normalizeMemoryCitations(answer: string, memoryKeys: readonly string[]): string {
  if (memoryKeys.length === 0) {
    return answer;
  }
  const norm = (value: string): string => value.trim().toLowerCase().replace(/[\s_-]+/gu, " ");
  const keys = new Set(memoryKeys.map(norm));
  return answer.replace(
    /\[from\s+([^\]]+?)\s*\]/giu,
    (match: string, ref: string) => (keys.has(norm(ref)) ? `[memory: ${ref.trim()}]` : match)
  );
}

/**
 * Strip the redundant note-verb "from " the model sometimes prepends to a
 * STRUCTURED citation — `[from commit: …]`, `[from task: …]`, `[from event: …]` —
 * so it reads as the canonical `[commit: …]` / `[task: …]` the gate validates by
 * class. Without this, the note regex (`[from <X>]`) mis-catches it first and
 * false-strips a TRUE structured citation as a non-existent note. Only a KNOWN
 * class keyword + ":" is rewritten, so a real `[from note.md]` is never touched.
 */
export function normalizeFromPrefixedCitations(answer: string): string {
  return answer.replace(
    /\[from\s+(task|event|reminder|session|feed|contact|command|commit|memory|action)\s*:/giu,
    "[$1:"
  );
}

/**
 * Rewrite a STRUCTURED citation the model wrote by SLOT NUMBER — `[from session 1]`,
 * `[from event 2]` — into the canonical `[<class>: <that slot's content>]` the gate
 * validates by class. The grounding markers are slot-numbered (`<<session N — id>>`),
 * so a reasoning-off model often cites the slot rather than the title; without this
 * the note regex mis-catches `[from session 1]` and false-strips a TRUE recall.
 * `slotsByClass` maps each class to the ORDERED list shown to the model (slot N →
 * index N-1); an out-of-range slot is left untouched for the gate to judge.
 */
export function normalizeSlotCitations(
  answer: string,
  slotsByClass: Readonly<Record<string, readonly string[]>>
): string {
  return answer.replace(
    // `[from session 1]`, the bare `[feed 1]` (the model often drops "from" for the
    // slot-numbered markers `<<feed N — name>>`), or `[from session 1 — ep_001]`
    // when it echoes the marker whole — the optional "from " and trailing "— <id>"
    // are both ignored.
    /\[(?:from\s+)?(task|event|reminder|session|feed|contact|command|commit|memory|action)\s+(\d+)(?:\s*[—–-]\s*[^\]]*)?\s*\]/giu,
    (match: string, cls: string, num: string) => {
      const list = slotsByClass[cls.toLowerCase()];
      const content = list?.[Number.parseInt(num, 10) - 1];
      return content ? `[${cls.toLowerCase()}: ${content}]` : match;
    }
  );
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
  strip(/\[contact:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.contacts ?? []));
  strip(/\[command:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.commands ?? []));
  strip(/\[commit:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.commits ?? []));
  strip(/\[memory:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.memories ?? []));
  strip(/\[action:\s*([^\]]+?)\s*\]/giu, (value) => resolvesByOverlap(value, allowed.actions ?? []));
  // Only tidy whitespace when a citation marker was actually removed (the cleanup
  // exists to close the seam a stripped `[...]` leaves). Running it on a CLEAN
  // answer collapses multi-space runs and mangles code-block indentation / aligned
  // columns — so leave an un-stripped answer byte-for-byte verbatim.
  if (stripped.length > 0) {
    text = text
      .replace(/[ \t]{2,}/gu, " ")
      .replace(/[ \t]+([.,;!?])/gu, "$1")
      .replace(/[ \t]+\n/gu, "\n");
  }
  return { stripped, text };
}

/**
 * Embed a match's text for dedup comparison, preferring the input chunk's
 * `embedText` (the same embedding space used during ranking — a cache hit).
 * Returns null on any embed failure so the dedup stays fail-open.
 */
async function embedChunkVec(
  inputChunk: KnowledgeChunk | undefined,
  match: KnowledgeMatch,
  embed: (text: string) => Promise<readonly number[]>
): Promise<readonly number[] | null> {
  try {
    return await embed(inputChunk?.embedText ?? match.text);
  } catch {
    return null;
  }
}

/**
 * Drop a candidate bridge/addition that is a near-duplicate of a chunk already
 * kept (a primary hit OR an earlier-kept addition). Mirrors the ask-window
 * `dedupNearDuplicateChunks` (@muse/recall) on the ENGINE path: a hop/PPR
 * bridge can surface a chunk near-identical to a primary (same fact across two
 * notes, or a bridge adjacent to a seed) and pad the small model's grounding
 * window with redundancy. Greedy first-wins so the higher-ranked chunk survives.
 *
 * AUGMENT-never-displace + FAIL-OPEN: only candidate ADDITIONS are filtered —
 * the primary ranking is never touched. Each chunk's embedding is fetched via
 * the (caching) embedder; a degenerate/length-mismatched vec yields cosine 0
 * (< threshold) so it never registers as a duplicate, and an embed FAILURE
 * keeps the candidate. Redundancy is dropped only on a confident match.
 */
async function dropNearDuplicateAdditions(
  kept: readonly KnowledgeMatch[],
  additions: readonly KnowledgeMatch[],
  embedFor: (match: KnowledgeMatch) => Promise<readonly number[] | null>,
  threshold = 0.985
): Promise<KnowledgeMatch[]> {
  if (additions.length === 0) return [];
  const keptVecs: (readonly number[])[] = [];
  for (const match of kept) {
    const vec = await embedFor(match);
    if (vec !== null) keptVecs.push(vec);
  }
  const survivors: KnowledgeMatch[] = [];
  for (const candidate of additions) {
    const vec = await embedFor(candidate);
    const isNearDup =
      vec !== null && keptVecs.some((kv) => cosineSimilarity(vec, kv) >= threshold);
    if (!isNearDup) {
      survivors.push(candidate);
      if (vec !== null) keptVecs.push(vec);
    }
  }
  return survivors;
}

/**
 * Append up to 2 associative bridges to `primary` using PPR over the
 * note-link graph (HippoRAG 2, arXiv:2502.14802). Seed weights = primary
 * match scores; appended bridges carry a query-relative cosine (or 0 on
 * embed failure). Primary list is never mutated.
 */
async function appendAssociativeBridges(
  query: string,
  primary: readonly KnowledgeMatch[],
  notes: readonly KnowledgeChunk[],
  options: RankKnowledgeOptions
): Promise<KnowledgeMatch[]> {
  if (primary.length === 0) {
    return [...primary];
  }
  const keyOf = (chunk: KnowledgeChunk | KnowledgeMatch): string =>
    `${chunk.source}|${chunk.text}`;

  const graph = buildNoteLinkGraph(notes);
  const seeds = new Map<string, number>();
  for (const match of primary) {
    seeds.set(keyOf(match), Math.max(match.cosine ?? match.score, 0));
  }

  const pprScores = personalizedPageRank(graph, seeds);
  const primaryKeys = new Set(primary.map((m) => keyOf(m)));

  // arXiv:2502.14802 §3.2: only nodes genuinely reached by the PPR walk
  // (score > 0) qualify as bridges; zero-score nodes were never traversed.
  const bridgeCandidates = [...pprScores.entries()]
    .filter(([key, score]) => !primaryKeys.has(key) && score > 1e-9)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key]) => key);

  const inputByKey = new Map<string, KnowledgeChunk>();
  for (const chunk of notes) {
    inputByKey.set(keyOf(chunk), chunk);
  }

  let queryVec: readonly number[] | null = null;
  try {
    queryVec = await options.embed(query);
  } catch {
    // fail-safe: bridges get cosine=0
  }

  const additions: KnowledgeMatch[] = [];
  for (const key of bridgeCandidates) {
    const chunk = inputByKey.get(key);
    if (!chunk) continue;
    let queryCosine = 0;
    if (queryVec !== null) {
      try {
        const chunkVec = await options.embed(chunk.embedText ?? chunk.text);
        queryCosine = cosineSimilarity(queryVec, chunkVec);
      } catch {
        queryCosine = 0;
      }
    }
    additions.push({ cosine: queryCosine, score: queryCosine, source: chunk.source, text: chunk.text });
  }

  const deduped = await dropNearDuplicateAdditions(primary, additions, (match) =>
    embedChunkVec(inputByKey.get(keyOf(match)), match, options.embed)
  );
  return [...primary, ...deduped];
}

/**
 * Deterministic second-hop retrieval (pseudo-relevance feedback, Rocchio
 * lineage): a two-hop question ("the team of the person who recommended the
 * book") names only hop 1 — the bridging note shares no tokens with the
 * query, so single-shot recall measured 2/6 joint@4 on the multi-hop battery.
 * Re-query with the TOP primary hits' own text (the bridge entity lives
 * there), then RRF-merge primary + hop lists. Zero model calls — two extra
 * embeds; `secondHop` is opt-in so the base path is byte-identical without it.
 */
export async function rankKnowledgeChunksWithHop(
  query: string,
  notes: readonly KnowledgeChunk[],
  options: RankKnowledgeOptions & { readonly secondHop?: boolean; readonly associative?: boolean }
): Promise<KnowledgeMatch[]> {
  const primary = await rankKnowledgeChunks(query, notes, options);
  if (options.secondHop !== true && options.associative !== true) {
    return primary;
  }
  if (options.secondHop !== true && options.associative === true) {
    return appendAssociativeBridges(query, primary, notes, options);
  }
  if (primary.length === 0) {
    return primary;
  }
  const keyOf = (match: KnowledgeMatch): string => `${match.source}|${match.text}`;
  const byKey = new Map<string, KnowledgeMatch>();
  const lists: string[][] = [primary.map((match) => { byKey.set(keyOf(match), match); return keyOf(match); })];
  for (const seed of primary.slice(0, 2)) {
    try {
      const hop = await rankKnowledgeChunks(seed.text, notes, options);
      lists.push(hop.map((match) => {
        const key = keyOf(match);
        const known = byKey.get(key);
        if (!known || (match.cosine ?? 0) > (known.cosine ?? 0)) byKey.set(key, match);
        return key;
      }));
    } catch {
      // hop retrieval is best-effort — a failed hop keeps the primary list
    }
  }
  // AUGMENT, never displace: the primary ranking is the measured single-hop
  // optimum (hit@1 15/15), so it keeps its exact order; hop-only bridges are
  // APPENDED (best-fused first, max 2) — multi-hop gains joint coverage while
  // single-hop behavior stays byte-identical.
  const fused = fuseByReciprocalRank(lists);
  const primaryKeys = new Set(primary.map((match) => keyOf(match)));

  // Recompute cosine for appended bridges against the ORIGINAL QUERY so
  // additions carry query-relative confidence, not seed-relative (inflated) cosine.
  // The caching embedder makes these cache hits — the same texts were already
  // embedded during the primary and hop ranking passes above.
  let queryVec: readonly number[] | null = null;
  try {
    queryVec = await options.embed(query);
  } catch {
    // If the query embed fails, fall back: all additions get cosine=0 (fail-safe below).
  }

  const inputByKey = new Map<string, KnowledgeChunk>();
  for (const chunk of notes) {
    inputByKey.set(`${chunk.source}|${chunk.text}`, chunk);
  }

  const additionKeys = [...byKey.keys()]
    .filter((key) => !primaryKeys.has(key))
    .sort((a, b) => (fused.get(b) ?? 0) - (fused.get(a) ?? 0))
    .slice(0, 2);

  const additions: KnowledgeMatch[] = [];
  for (const key of additionKeys) {
    const match = byKey.get(key)!;
    let queryCosine = 0;
    if (queryVec !== null) {
      try {
        // Prefer the input chunk's embedText (same embedding space used during ranking);
        // fall back to the match's display text.
        const inputChunk = inputByKey.get(key);
        const chunkVec = await options.embed(inputChunk?.embedText ?? match.text);
        queryCosine = cosineSimilarity(queryVec, chunkVec);
      } catch {
        // Fail-safe: an appended bridge must NEVER inflate retrieval confidence.
        queryCosine = 0;
      }
    }
    additions.push({ ...match, cosine: queryCosine });
  }

  const deduped = await dropNearDuplicateAdditions(primary, additions, (match) =>
    embedChunkVec(inputByKey.get(keyOf(match)), match, options.embed)
  );
  return [...primary, ...deduped];
}

export interface GroundingExplanationOptions {
  /** The top match's ABSOLUTE cosine — the rubric stores the categorical confidence, not the raw value. */
  readonly topCosine?: number;
  readonly confidentAt?: number;
  readonly coverageFloor?: number;
  readonly answerabilityFloor?: number;
}

/**
 * Plain-language WHY behind a non-`grounded` verdict — the "shows its work" edge
 * applied to the REFUSAL itself (`muse ask --why`). Names each rubric criterion
 * that fell short and the measured value vs its threshold, turning an opaque
 * "I'm not sure" into an inspectable, actionable judgement (rephrase, reindex,
 * add a note). Returns `[]` for a `grounded` verdict — silent on the happy path
 * (a targeted trust affordance, not a debug firehose). Pure: the caller passes
 * the top match's cosine, since the rubric carries the categorical confidence
 * (1/0.5/0), not the raw cosine the user wants to see.
 */
export function explainGroundingVerdict(
  verification: GroundingVerification,
  options?: GroundingExplanationOptions
): string[] {
  if (verification.verdict === "grounded") {
    return [];
  }
  const confidentAt = finiteOr(options?.confidentAt, DEFAULT_CONFIDENT_AT);
  const coverageFloor = finiteOr(options?.coverageFloor, DEFAULT_COVERAGE_FLOOR);
  const answerabilityFloor = finiteOr(options?.answerabilityFloor, DEFAULT_ANSWERABILITY_FLOOR);
  const { answerability, confidence, coverage } = verification.rubric;
  const cosineNote = typeof options?.topCosine === "number"
    ? ` (best match ${options.topCosine.toFixed(2)}, I need ${confidentAt.toFixed(2)})`
    : "";
  const lines: string[] = [];
  if (confidence === 0) {
    lines.push(`no notes came close enough to the question${cosineNote} — confidence criterion`);
  } else if (confidence < 1) {
    lines.push(`the closest notes are only loosely related${cosineNote} — confidence criterion (low)`);
  }
  if (verification.invalidCitations.length > 0) {
    lines.push(`the answer cited ${verification.invalidCitations.length.toString()} source(s) you don't have (${verification.invalidCitations.join(", ")}) — citation criterion`);
  }
  if (coverage < coverageFloor) {
    lines.push(`the evidence covers only ${(coverage * 100).toFixed(0)}% of the answer's wording (I need ${(coverageFloor * 100).toFixed(0)}%) — coverage criterion`);
  }
  if (answerability < answerabilityFloor) {
    lines.push(`your notes address only ${(answerability * 100).toFixed(0)}% of the question (I need ${(answerabilityFloor * 100).toFixed(0)}%) — answerability criterion`);
  }
  if (lines.length === 0) {
    lines.push(verification.reason);
  }
  return lines;
}

export interface GroundingReverifyInput {
  readonly answer: string;
  /** The grounded passages, joined — the evidence the judge checks against. */
  readonly evidence: string;
  readonly query: string;
}

/**
 * Injected one-shot judge: returns `true` iff the answer is supported by the
 * evidence. Kept as a plain function so this package stays model-agnostic — the
 * caller wires a local-Qwen `generate` + `parseGroundingReverifyVerdict`.
 */
export type GroundingReverify = (input: GroundingReverifyInput) => Promise<boolean>;

/**
 * How k judge verdicts are collapsed into one decision.
 * - "unanimous-pass"  — upgrade to `grounded` ONLY if every sample agrees (YES).
 * - "unanimous-keep"  — keep `grounded` ONLY if every sample agrees (YES).
 * Both are the SAME reducer; the two names document call-site intent and leave
 * room for future divergence (arXiv:2203.11171 self-consistency; arXiv:2510.27106
 * "Rating Roulette" — single-judge verdicts have near-arbitrary intra-rater variance).
 */
export type JudgeConsensusMode = "unanimous-pass" | "unanimous-keep";

/**
 * Aggregate k boolean judge verdicts by a fail-close unanimous rule.
 * Returns true ONLY when every sample is true (empty → false).
 */
export function judgeConsensus(verdicts: readonly boolean[], _mode: JudgeConsensusMode): boolean {
  return verdicts.length > 0 && verdicts.every((v) => v);
}

export const REVERIFY_SYSTEM_PROMPT =
  "You are a strict grounding judge. Given a user QUESTION, an ANSWER, and the EVIDENCE the answer was drawn from, decide whether the EVIDENCE actually supports the ANSWER's factual claims. The QUESTION, ANSWER, and EVIDENCE may be in DIFFERENT languages — judge whether the underlying FACTS match (a value, number, name, or term that appears in the EVIDENCE supports the same fact in the ANSWER even when the surrounding words are translated), NOT whether the wording matches. A value the EVIDENCE does NOT contain is still unsupported, in any language. Reply with a single word: YES if the evidence supports it, NO if it does not or you are unsure. Do not explain.";

export function buildGroundingReverifyPrompt(input: GroundingReverifyInput): string {
  return [
    `QUESTION: ${input.query}`,
    `ANSWER: ${input.answer}`,
    "EVIDENCE:",
    input.evidence,
    "",
    "Does the EVIDENCE support the ANSWER's claims? Reply YES or NO."
  ].join("\n");
}

/**
 * Deterministic, fail-close parse of the judge's reply: supported ONLY on a
 * clear leading YES. Anything else — NO, hedging, empty — is unsupported, so a
 * confused small model can never UPGRADE a weak answer by accident.
 */
export function parseGroundingReverifyVerdict(output: string): boolean {
  return /^\s*(yes|y|true|supported)\b/iu.test(output.trim());
}

/**
 * Schema for Ollama's `format` constrained decoding on the reverify judge —
 * the verdict can no longer be lost to parse drift (a hedge, an explanation,
 * an empty completion). Safe here because the judge call carries NO tools
 * (Ollama can't compose format+tools — #6002; tool calls stay unconstrained).
 */
export const REVERIFY_RESPONSE_FORMAT = {
  properties: { supported: { type: "boolean" } },
  required: ["supported"],
  type: "object"
};

/**
 * Parse the format-constrained verdict; a non-JSON reply (older runtime, env
 * without format support) degrades to the legacy YES-word parse. Both layers
 * fail-close — anything unclear is unsupported.
 */
export function parseGroundingReverifyJson(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output.trim());
    if (parsed && typeof parsed === "object" && "supported" in parsed) {
      return (parsed as { supported: unknown }).supported === true;
    }
    return false;
  } catch {
    return parseGroundingReverifyVerdict(output);
  }
}

/**
 * Build the canonical one-shot grounding judge ({@link GroundingReverify}) from a
 * minimal text-generation provider — the SAME reverify the reflection + proactive-
 * notice faithfulness gates inject, so every "free LLM prose over a known source"
 * surface verifies identically. Relies on the free-text YES/NO fallback in
 * {@link parseGroundingReverifyJson}, so it works even with a narrow provider that
 * has no structured-output capability. Pure over the provider.
 */
export function buildGroundingReverify(
  provider: {
    generate(request: {
      readonly model: string;
      readonly messages: readonly { readonly role: "system" | "user" | "assistant"; readonly content: string }[];
      readonly maxOutputTokens?: number;
      readonly temperature?: number;
    }): Promise<{ readonly output?: string }>;
  },
  model: string
): GroundingReverify {
  return async ({ answer, evidence, query }) => {
    const judged = await provider.generate({
      maxOutputTokens: 24,
      messages: [
        { content: REVERIFY_SYSTEM_PROMPT, role: "system" },
        { content: buildGroundingReverifyPrompt({ answer, evidence, query }), role: "user" }
      ],
      model,
      temperature: 0
    });
    return parseGroundingReverifyJson(judged.output ?? "");
  };
}

// Month / day names: a correct date answer renders "September" for an evidence
// "09" token, so they are excluded from the named-entity check below to avoid a
// needless escalation on a faithful date.
const VALUE_WORD_STOPLIST = new Set([
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"
]);

// Sentence-opener / connective words a chatty model capitalizes only because
// they start a sentence — NOT named entities. Excluded so "However, …" /
// "Based on your notes, …" don't trigger a needless value-escalation judge pass.
const SENTENCE_OPENER_STOPLIST = new Set([
  "however", "based", "according", "additionally", "moreover", "furthermore",
  "therefore", "thus", "hence", "consequently", "meanwhile", "instead",
  "otherwise", "nonetheless", "nevertheless", "although", "though", "because",
  "since", "while", "when", "where", "whereas", "also", "finally", "firstly",
  "secondly", "next", "then", "overall", "generally", "specifically", "note",
  "here", "there", "currently", "recently", "unfortunately", "fortunately",
  "importantly", "notably", "similarly", "conversely", "regarding", "given",
  "considering", "despite", "besides", "alternatively", "basically",
  "essentially", "ultimately", "first", "second", "third",
  "yes", "sure", "okay", "well"
]);

/**
 * The VALUE tokens the answer asserts that the evidence does NOT contain — a
 * pure-digit NUMBER ("MTU 9000" vs the note's "1380"), a whole EMAIL ADDRESS
 * ("jane@acme.com" vs the note's "jane@globex.com"), OR a capitalized NAMED
 * ENTITY ("Dr. Kim" vs "Dr. Patel"). The rubric's `coverage` is whole-answer
 * token overlap, so a single wrong value barely dents coverage and the answer
 * still reads `grounded` — the documented wrong-value hole. This flags exactly
 * that case so re-verification can escalate it to the judge (claim-level
 * grounding — Self-RAG ISSUP arXiv:2310.11511; Chain-of-Note arXiv:2311.09210).
 * Citations are stripped first (a `[from 2026-…]` source is never an asserted
 * value); month/day names are excluded. The call site is FAIL-OPEN, so a false
 * flag only costs one judge pass that upholds a correct answer, never a refusal.
 */
const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/gu;
const DATE_MONTH_NUMBER: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
// Case-sensitive (initial-cap) so the modal verb "may" in prose isn't a false May date.
const EN_PROSE_DATE_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/gu;
const KO_DATE_RE = /(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu;

/**
 * Script-neutral `month-day` keys ("9-14") from every date form in `text` — ISO
 * ("2026-09-14"), English prose ("September 14"), Korean ("9월 14일"). Binds month+day
 * as ONE key so a drifted calendar/deadline DAY can't be waved through by an unrelated
 * same-digit elsewhere in the evidence (the bare-number guard's blind spot). Year is
 * dropped (the number guard owns it). The chat date gate (fire 31) shares this one copy.
 */
export function monthDayKeys(text: string): Set<string> {
  const out = new Set<string>();
  for (const d of text.match(ISO_DATE_RE) ?? []) {
    const [, m, day] = d.split("-");
    out.add(`${Number(m).toString()}-${Number(day).toString()}`);
  }
  for (const m of text.matchAll(EN_PROSE_DATE_RE)) {
    const month = DATE_MONTH_NUMBER[m[1]!.toLowerCase()];
    if (month) out.add(`${month.toString()}-${Number(m[2]).toString()}`);
  }
  for (const m of text.matchAll(KO_DATE_RE)) {
    out.add(`${Number(m[1]).toString()}-${Number(m[2]).toString()}`);
  }
  return out;
}

function answerAssertsUnsupportedValue(answer: string, matches: readonly KnowledgeMatch[]): boolean {
  const stripped = answer.replace(/\[[^\]]*\]/gu, " ");
  const evidence = unionContentTokens(matches);
  // DATE drift (ask-path counterpart of the chat date gate): bind month+day so
  // a calendar/renewal date that drifts by a day (Sep 14 vs the note's Sep 13) flags even
  // when the day "14" appears elsewhere in evidence. Month names are stoplisted from the
  // bare-number path, so this is the only place a drifted prose/KO date can be caught.
  const answerDates = monthDayKeys(stripped);
  if (answerDates.size > 0) {
    const evidenceDates = monthDayKeys(matches.map((m) => m.text).join(" "));
    if (evidenceDates.size > 0 && [...answerDates].some((d) => !evidenceDates.has(d))) {
      return true;
    }
  }
  // Strip date expressions before the bare-number check so a date's DAY digit isn't
  // re-judged as a loose number (which would false-fire when the evidence carries the
  // same day only inside an ISO date — "September 13" vs "2026-09-13").
  const numStripped = stripped.replace(ISO_DATE_RE, " ").replace(EN_PROSE_DATE_RE, " ").replace(KO_DATE_RE, " ");
  const numbers = [...lexicalTokens(numStripped)].filter((token) => /^\d+$/u.test(token));
  if (numbers.some((number) => !evidence.has(number))) {
    return true;
  }
  // Structured identifiers — an EMAIL ADDRESS the answer asserts must appear
  // VERBATIM in the evidence. The token rules above are blind to these: an email
  // tokenises to lowercase parts (jane@acme.com → jane/acme/com), so a drifted
  // DOMAIN ("acme" for the note's "globex") is neither a pure digit nor a
  // capitalised entity and a WRONG contact email passes as "grounded" — the most
  // dangerous drift for a contact / outbound surface. Compare whole addresses
  // against the raw evidence text, case-insensitively (local part + domain are
  // both copied verbatim from a note, never reformatted).
  const evidenceText = matches.map((m) => m.text).join(" ").toLowerCase();
  const emails = stripped.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/giu) ?? [];
  if (emails.some((address) => !evidenceText.includes(address.toLowerCase()))) {
    return true;
  }
  const namedEntities = (stripped.match(/\b[A-Z][a-zA-Z]{2,}\b/gu) ?? [])
    .map((word) => word.toLowerCase())
    .filter((word) => !LEXICAL_STOPWORDS.has(word) && !VALUE_WORD_STOPLIST.has(word) && !SENTENCE_OPENER_STOPLIST.has(word));
  return namedEntities.some((entity) => !evidence.has(entity));
}

/**
 * Test-time verification scaling for the WEAK verdict (Memory-aware Test-Time
 * Scaling — ReasoningBank MaTTS, arXiv:2509.25140; rubric-guided verification,
 * arXiv:2601.15808). The deterministic `verifyGrounding` core decides
 * `grounded` / `ungrounded` outright — only the ambiguous `weak` band spends a
 * second inference: one injected judge re-checks the answer against the
 * evidence. Fail-close — the weak answer is UPGRADED to `grounded` ONLY on an
 * explicit supported verdict; an unsupported verdict OR any re-verifier error
 * DEMOTES it to `ungrounded` (a weak answer never silently survives on a failed
 * check).
 *
 * Claim-level value escalation: a `grounded` answer that still asserts a NUMBER
 * or a NAMED ENTITY absent from the evidence (the wrong-value hole the lexical
 * rubric is blind to) also spends ONE judge pass — but FAIL-OPEN, since `base`
 * already cleared every deterministic criterion: a judge ERROR must not demote a
 * passing answer, only an explicit unsupported verdict does. A `grounded` answer
 * whose values all check out, and any `ungrounded` verdict, never call the judge.
 */
export async function verifyGroundingWithReverify(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  reverify: GroundingReverify,
  options?: VerifyGroundingOptions
): Promise<GroundingVerification> {
  const base = verifyGrounding(answer, matches, query, options);
  const evidence = matches.map((m) => m.text).join("\n");
  // Empty evidence is unverifiable BY DEFINITION — a high-cosine match with empty
  // text gives confidence>0 yet evidence="". No band may escalate UP to grounded
  // by asking the judge about nothing (a YES on "" would be a fabrication-floor
  // leak — the exact hole fail-closed for council/reflection). Fail-close WITHOUT
  // consulting the judge; a `grounded` base is left to the value band below (which
  // can only tighten), so a grounded refusal is never demoted here.
  if (evidence.trim().length === 0 && base.verdict !== "grounded") {
    return { ...base, reason: "empty evidence — unverifiable, fail-closed", verdict: "ungrounded" };
  }
  const samples = Math.min(5, Math.max(1, options?.reverifySamples ?? 1));

  /** Collect up to `samples` verdicts, short-circuiting on the first false (unanimous). */
  async function collectVerdicts(input: GroundingReverifyInput): Promise<boolean[]> {
    const verdicts: boolean[] = [];
    for (let i = 0; i < samples; i++) {
      const v = await reverify(input);
      verdicts.push(v);
      if (!v) break;
    }
    return verdicts;
  }

  if (base.verdict === "weak") {
    let verdicts: boolean[];
    try {
      verdicts = await collectVerdicts({ answer, evidence, query });
    } catch {
      return { ...base, reason: "weak retrieval + re-verification failed — fail-closed to ungrounded", verdict: "ungrounded" };
    }
    return judgeConsensus(verdicts, "unanimous-pass")
      ? { ...base, reason: "weak retrieval upheld by re-verification", verdict: "grounded" }
      : { ...base, reason: "weak retrieval rejected by re-verification", verdict: "ungrounded" };
  }
  // Coverage-ONLY failure: retrieval succeeded (confidence > 0) and every citation
  // is valid (no invalid source), but the answer's lexical token-coverage is below
  // the floor. That is exactly the band the token proxy gets WRONG — a CROSS-LINGUAL
  // answer (Korean prose over English evidence) or a terse structured fact scores low
  // coverage yet states a value the evidence DOES contain. Defer to the SAME judge as
  // the weak band rather than hard-failing; a real drift / wrong value is still
  // rejected (it stays "NO" in any language). Fail-closed to the original ungrounded
  // verdict if there is no judge or it errors.
  if (base.verdict === "ungrounded" && base.rubric.confidence > 0 && base.invalidCitations.length === 0) {
    let verdicts: boolean[];
    try {
      verdicts = await collectVerdicts({ answer, evidence, query });
    } catch {
      return base;
    }
    return judgeConsensus(verdicts, "unanimous-pass")
      ? { ...base, reason: "low coverage upheld by re-verification", verdict: "grounded" }
      : { ...base, reason: "low coverage rejected by re-verification", verdict: "ungrounded" };
  }
  if (base.verdict === "grounded" && answerAssertsUnsupportedValue(answer, matches)) {
    let verdicts: boolean[];
    try {
      verdicts = await collectVerdicts({ answer, evidence, query });
    } catch {
      return base;
    }
    return judgeConsensus(verdicts, "unanimous-keep")
      ? base
      : { ...base, reason: "answer asserts a value the evidence does not support", verdict: "ungrounded" };
  }
  return base;
}

/** A right-hand fragment is a CLAUSE (worth judging on its own) only if it
 *  carries a value (a digit) or is long enough to be a predicate — NOT a short
 *  noun continuation ("Sarah and Bob"), which would shred a list into garbage
 *  claims and risk false drops. Conservative on purpose. */
function isClauseFragment(text: string): boolean {
  const trimmed = text.trim();
  if (/\d/u.test(trimmed)) {
    return true;
  }
  return trimmed.split(/\s+/u).filter(Boolean).length >= 5;
}

function splitClausalConjunctions(text: string): string[] {
  const raw = text.split(/\s*,?\s+(?:and|but)\s+/iu);
  if (raw.length <= 1) {
    return [text];
  }
  const merged: string[] = [raw[0]!];
  for (let i = 1; i < raw.length; i += 1) {
    if (isClauseFragment(raw[i]!)) {
      merged.push(raw[i]!);
    } else {
      // A noun continuation, not a new clause — re-join so a list never splits.
      merged[merged.length - 1] = `${merged[merged.length - 1]} and ${raw[i]!}`;
    }
  }
  return merged;
}

/**
 * Segment a grounded answer into atomic CLAIMS for per-claim verification
 * (Self-RAG ISSUP, arXiv:2310.11511): split on sentence terminators and
 * semicolons, then on `and`/`but` ONLY when the right side is a real clause
 * (carries a value or ≥5 words), so "Mina owns pricing and the budget was
 * 2,000,000 KRW" yields TWO claims while "Sarah and Bob report to Mina" stays
 * ONE. Citation markers ride along with their clause. Empty fragments dropped.
 * Conservative by design — under-segmenting only degrades to whole-answer
 * checking; over-segmenting risks dropping a true clause. Pure.
 */
export function segmentClaims(answer: string): readonly string[] {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const sentence of trimmed.split(/(?<=[.!?])\s+/u)) {
    for (const bySemicolon of sentence.split(/\s*;\s*/u)) {
      out.push(...splitClausalConjunctions(bySemicolon));
    }
  }
  return out.map((claim) => claim.trim()).filter((claim) => claim.length > 0);
}

export interface PerClaimVerdict {
  readonly claim: string;
  readonly supported: boolean;
}

export interface PerClaimRefinement {
  /** The answer with unsupported claims removed + an honest "I'm not sure" note. Equals the input when nothing was dropped. */
  readonly answer: string;
  readonly verdicts: readonly PerClaimVerdict[];
  readonly dropped: number;
}

/**
 * Per-claim grounding refinement (Self-RAG ISSUP). Runs the SAME one-shot judge
 * on EACH atomic claim of an answer the whole-answer gate already passed as
 * `grounded`, and SURGICALLY drops only the unsupported claims — keeping the
 * cited true clauses and appending an honest "I'm not sure about …" note —
 * instead of the all-or-nothing whole-answer verdict (which either lets one
 * fabricated clause ride through or refuses the entire answer).
 *
 * Safety (the reason this strictly tightens, never over-refuses a passing
 * answer): it is meant to run ONLY on an already-`grounded` answer, it FAILS
 * OPEN per claim (a judge error KEEPS the claim, matching the value-escalation
 * fail-open), a 0/1-claim answer is returned untouched, and claims beyond
 * `maxClaims` are kept verbatim (never dropped unchecked). So the worst case is
 * an occasional false-drop on an opt-in surface, never a new refusal.
 */
export async function verifyGroundingPerClaim(
  answer: string,
  matches: readonly KnowledgeMatch[],
  query: string,
  reverify: GroundingReverify,
  options?: { readonly maxClaims?: number; readonly suspectClaims?: ReadonlySet<string>; readonly reverifySamples?: number }
): Promise<PerClaimRefinement> {
  const claims = segmentClaims(answer);
  if (claims.length <= 1) {
    return { answer, dropped: 0, verdicts: claims.map((claim) => ({ claim, supported: true })) };
  }
  const evidence = matches.map((m) => m.text).join("\n");
  const cap = Math.max(1, options?.maxClaims ?? 6);
  const samples = Math.min(5, Math.max(1, options?.reverifySamples ?? 1));
  const checked = claims.slice(0, cap);
  const overflow = claims.slice(cap);
  const verdicts: PerClaimVerdict[] = [];
  for (const claim of checked) {
    // When a pre-filter screen has already classified non-suspect claims,
    // skip the judge for them (only embed cost, not a model call).
    if (options?.suspectClaims !== undefined && !options.suspectClaims.has(claim)) {
      verdicts.push({ claim, supported: true });
      continue;
    }
    let supported: boolean;
    try {
      // k-sample judge consensus (arXiv:2203.11171 self-consistency;
      // arXiv:2510.27106 "Rating Roulette" — a single judge sample has
      // near-arbitrary intra-rater variance). FAIL-OPEN polarity: a claim is
      // DROPPED only when EVERY sample says NO (unanimous-NO); ANY yes keeps it.
      // Reuses `judgeConsensus` on the INVERTED verdicts — unanimous-keep over
      // {is-this-claim-unsupported?} is true iff all samples agree NO, i.e. the
      // unanimous-drop condition. Short-circuits on the first YES (one keep
      // settles it). So raising samples can only convert a single-sample DROP→KEEP
      // on disagreement — strictly fewer false-drops, never a new drop.
      const noVerdicts: boolean[] = [];
      for (let i = 0; i < samples; i += 1) {
        const yes = await reverify({ answer: claim, evidence, query });
        if (yes) {
          noVerdicts.length = 0; // any yes keeps — clear so it is not a unanimous-NO drop
          break;
        }
        noVerdicts.push(true);
      }
      supported = !judgeConsensus(noVerdicts, "unanimous-keep");
    } catch {
      supported = true; // judge error → keep the claim (fail-open)
    }
    verdicts.push({ claim, supported });
  }
  const droppedVerdicts = verdicts.filter((v) => !v.supported);
  if (droppedVerdicts.length === 0) {
    return { answer, dropped: 0, verdicts };
  }
  const kept = verdicts.filter((v) => v.supported).map((v) => v.claim);
  const subjects = droppedVerdicts.map((v) => v.claim.replace(/\[[^\]]*\]/gu, "").trim()).filter((s) => s.length > 0);
  const body = [...kept, ...overflow].join(" ").trim();
  const note = subjects.length > 0 ? `${body ? "\n\n" : ""}I'm not sure about: ${subjects.join("; ")}.` : "";
  return { answer: `${body}${note}`.trim(), dropped: droppedVerdicts.length, verdicts };
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

const REDUNDANCY_TOPIC_SIM_MIN = 0.86;
// Near-IDENTICAL token sets: union ≈ intersection. The INVERSE of the contradiction
// detector's neither-subset gate (which excludes identical sets). "Q1 sales 5억" vs
// "Q2 sales 7억" have Jaccard ≈ 0.2 (distinct value tokens) → not redundant; a verbatim
// / stopword-only-differing echo has Jaccard ≈ 1.0 → redundant. The high floor keeps an
// elaboration (one side adds real content, lowering Jaccard) from firing.
const REDUNDANCY_OVERLAP_MIN = 0.9;

export interface RedundantPair {
  readonly aIndex: number;
  readonly bIndex: number;
  readonly overlap: number;
}

/**
 * Pairwise REDUNDANCY (step-repetition) detection — the complement of
 * {@link detectPairwiseContradictions}. Returns index pairs that are SAME-TOPIC
 * (cosine ≥ topicSimMin) AND near-identical in content (lexical Jaccard ≥ overlapMin),
 * i.e. one text restates the other adding nothing new. Same-script guard + fail-open on
 * embed error. Catches MAST FM-1.3 Step Repetition (arXiv:2503.13657) at the OUTPUT
 * level — distinct sub-tasks whose workers converged to the same answer, or a sequenced
 * step that just echoes its upstream. Pure over the injected embed; never throws.
 */
export async function detectRedundantPairs(
  texts: readonly string[],
  embed: (text: string) => Promise<readonly number[]>,
  opts?: { readonly topicSimMin?: number; readonly overlapMin?: number }
): Promise<readonly RedundantPair[]> {
  const topicSimMin = opts?.topicSimMin ?? REDUNDANCY_TOPIC_SIM_MIN;
  const overlapMin = opts?.overlapMin ?? REDUNDANCY_OVERLAP_MIN;

  if (texts.length < 2) return [];

  let embeddings: Array<readonly number[] | null>;
  try {
    embeddings = await Promise.all(texts.map((t) => embed(t).catch(() => null)));
  } catch {
    return [];
  }

  const pairs: RedundantPair[] = [];

  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i]!;
      const b = texts[j]!;

      if (!comparableScript(a, b)) continue;

      const embA = embeddings[i];
      const embB = embeddings[j];
      if (!embA || !embB) continue;

      if (cosineSimilarity(embA, embB) < topicSimMin) continue;

      const tokA = lexicalTokens(a);
      const tokB = lexicalTokens(b);
      const unionSize = new Set([...tokA, ...tokB]).size;
      if (unionSize === 0) continue;
      let intersect = 0;
      for (const t of tokA) {
        if (tokB.has(t)) intersect++;
      }
      const overlap = intersect / unionSize;
      if (overlap < overlapMin) continue;

      pairs.push({ aIndex: i, bIndex: j, overlap });
    }
  }

  return pairs;
}
