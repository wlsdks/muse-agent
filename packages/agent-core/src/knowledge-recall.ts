/**
 * Multi-document knowledge recall (RAG) with source attribution — the public
 * surface. This module is a thin re-export hub; the implementation lives in
 * cohesive siblings so every existing `./knowledge-recall.js` import keeps
 * resolving:
 *
 *   - `recall-lexical`      — shared lexical scoring primitives (tokeniser,
 *     stopwords, BM25 / overlap, rank fusion).
 *   - `knowledge-ranking`   — the retrieval ranker family + selection strategies.
 *   - `recall-confidence`   — the retrieval-confidence graders + thresholds.
 *   - `grounding-citations` — citation provenance + source-trust maps.
 *   - `grounding-verifier`  — the deterministic grounding verifier + rubric.
 *   - `recall-chunking`     — chunk-shaping / long-context reorder utilities.
 *   - `evidence-conflicts`  — pairwise evidence contradiction analysis.
 *   - `recall-scoring`      — recall shaping on top of the ranker: edge-load,
 *     sufficiency, clarify gate, rendering, second-hop / associative bridges.
 *   - `recall-citations`    — output-side citation enforcement + normalisation.
 *   - `recall-verdict`      — test-time grounding verdict: explain, reverify
 *     judge, weak-band / per-claim escalation, unsupported-value detection.
 *   - `recall-search-tool`  — the `knowledge_search` tool, caching embedder,
 *     redundancy detection.
 */

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
  isCalibratedEmbedder,
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

// Leaf symbols the split modules moved to (or share with) their source modules,
// re-exported so existing `./knowledge-recall.js` imports of them keep resolving.
export {
  classifyRetrievalConfidence,
  DEFAULT_CONFIDENT_AT
} from "./recall-confidence.js";
export {
  fuseByReciprocalRank,
  lexicalTokens
} from "./recall-lexical.js";
export {
  type KnowledgeChunk,
  type KnowledgeMatch,
  rankKnowledgeChunks,
  type RankKnowledgeOptions
} from "./knowledge-ranking.js";
export { reorderForLongContext } from "./recall-chunking.js";
export {
  type GroundingVerification,
  verifyGrounding,
  type VerifyGroundingOptions
} from "./grounding-verifier.js";
export type { AllowedCitations, CitationEnforcement } from "./grounding-citations.js";

export * from "./recall-scoring.js";
export * from "./recall-citations.js";
export * from "./recall-verdict.js";
export * from "./recall-search-tool.js";
