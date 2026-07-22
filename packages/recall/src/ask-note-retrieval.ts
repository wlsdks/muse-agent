/**
 * The notes RAG core for `muse ask`, lifted out of the commands-ask god-file:
 * embed the query → cosine-rank the live (scope-filtered) note chunks → RAG-Fusion
 * per-clause + hybrid MMR selection → graph-augment from confident seeds' wiki-links
 * → confidence-gated second-hop augment. Fail-open by construction: any embed error
 * degrades to "no notes grounding" (notesUnavailable) and the caller still answers
 * from the other stores + general knowledge. Returns the ranked set plus the
 * pre-gap-cut distribution (for the confidence verdict) and the clause embeddings
 * (for the set-level sufficiency advisory).
 */

import { createHash } from "node:crypto";
import { classifyRetrievalConfidence, lexicalOverlap, lexicalTokens, resolveRecallConfidentAt, splitCompoundQuery } from "@muse/agent-core";
import { diversifyAskChunks, secondHopAugmentChunks, shouldSecondHop, type ScoredChunk } from "./chunks.js";
import { demoteStale, detectStaleMarker } from "./conflict.js";
import { filterNotesByScope, relativizeNoteSource } from "./present.js";
import { existsSync } from "node:fs";
import { errorMessage } from "@muse/shared";

import { filterLiveNoteIndexFiles } from "./live-files.js";
import { cosine } from "./notes-index.js";
import { linkExpandRefs } from "./notes-links.js";
import { NOTES_CHUNKER_VERSION } from "./notes-chunk.js";
import { NOTES_INDEX_SCHEMA_VERSION } from "./notes-index.js";
import {
  createTemporalClaimGraphV1,
  resolveNoteSpanIdentityV1FromIndex,
  type NoteSpanIdentityV1,
  type SupersedesRelationV1,
  type TemporalClaimGraphV1
} from "./temporal-claim-graph.js";


// Keep the package boundary aligned with the CLI's `--top` contract without
// introducing a package -> app dependency. This also bounds direct callers.
const MAX_RETRIEVAL_TOP_K = 20;

interface RetrievalFileEntry {
  readonly path: string;
  readonly sourceHash?: string;
  readonly chunkerVersion?: typeof NOTES_CHUNKER_VERSION;
  readonly chunks: readonly ScoredChunk["chunk"][];
}
const PAIR_AWARE_RERANK_WINDOW = 20;
const PAIR_AWARE_RELEVANT_SLOTS = 10;
const PAIR_SHORTLIST_SIDE_LIMIT = PAIR_AWARE_RELEVANT_SLOTS;
const PAIR_PRODUCTION_CURRENT_LIMIT = 10;
const PAIR_PRODUCTION_STALE_LIMIT = 8;
const PAIR_BRIDGE_STALE_POOL_LIMIT = 20;
const PAIR_PRODUCTION_COMPARISON_LIMIT = 100;
const PAIR_SHORTLIST_PROPOSAL_LIMIT = 6;
const PAIR_SHORTLIST_CANDIDATE_LIMIT = PAIR_SHORTLIST_PROPOSAL_LIMIT * 2;

export interface CorrectionPairShortlistCandidate {
  readonly embedding: ArrayLike<number>;
  readonly identity: NoteChunkIdentity;
  readonly queryScore: number;
  readonly stale: boolean;
}

export interface CorrectionPairShortlistDiagnostics {
  readonly candidateCount: number;
  readonly compatibilityComparisons: number;
  readonly proposalCount: number;
}

export interface CorrectionPairShortlist {
  readonly diagnostics: CorrectionPairShortlistDiagnostics;
  readonly proposals: readonly RecallRerankPairHint[];
  readonly windowIndices: readonly number[];
}

export type CorrectionPairShortlistOrder = "original" | "reversed-within-groups";

export type ResolvedCorrectionPairSelection =
  | { readonly outcome: "null" }
  | {
      readonly outcome: "pair";
      readonly rerankPair: RecallRerankPairHint;
      readonly verifiedCorrectionPair: VerifiedCorrectionPair;
    };

export interface NoteRetrievalResult {
  /** The selected (MMR + graph + second-hop) chunks for the prompt window. */
  scored: ScoredChunk[];
  /** The untrimmed top-K distribution — the confidence verdict reads THIS so a
   *  gap-cut to 1 chunk can't flip ambiguous→confident by zeroing the runner-up. */
  preGapScored: ScoredChunk[];
  /** Per-clause embeddings of a compound query (for the sufficiency advisory). */
  subqueryEmbeddings: ReadonlyArray<readonly number[]>;
  splitClauses: readonly string[];
  /** True when the embedding endpoint failed — degrade to no-notes grounding. */
  notesUnavailable: boolean;
  queryVec: number[] | undefined;
  /** Aggregate-safe reranker telemetry. Never contains query or candidate text. */
  rerankDecision?: RecallRerankDecision;
  /** Validated pair chosen by rerank order; candidate indices are local to the immutable rerank window. */
  rerankPair?: RecallRerankPairHint;
  /** Validated correction pair carried beyond the rerank window by exact opaque chunk identity. */
  verifiedCorrectionPair?: VerifiedCorrectionPair;
  /** Immutable first-retrieval snapshot for an identity-matching prepare seam. */
  snapshot?: NoteRetrievalSnapshot;
}

export interface NoteChunkIdentity {
  readonly file: string;
  readonly chunkIndex: number;
}

export interface VerifiedCorrectionPair {
  readonly current: NoteChunkIdentity;
  readonly stale: NoteChunkIdentity;
}

export interface TemporalClaimGraphActivationV1 {
  readonly relation: SupersedesRelationV1;
  readonly scored: readonly ScoredChunk[];
  readonly verifiedCorrectionPair: VerifiedCorrectionPair;
}

export type RecallRerankOutcome = "ineligible-window" | "success" | "empty" | "invalid" | "timeout" | "error";

export interface RecallRerankDecision {
  readonly eligible: boolean;
  readonly logicalInvocations: 0 | 1;
  readonly httpAttempts: number;
  readonly outcome: RecallRerankOutcome;
}

export interface RecallRerankExecution {
  readonly httpAttempts: number;
  readonly order?: readonly number[];
  readonly outcome: Exclude<RecallRerankOutcome, "ineligible-window">;
  readonly pairHints?: readonly RecallRerankPairHint[];
}

export interface RecallRerankPairHint {
  readonly current: number;
  readonly stale: number;
}

export interface RecallRerankContext {
  readonly allowedCorrectionPairs: readonly RecallRerankPairHint[];
  readonly diagnostics?: {
    readonly bridgeComparisons: number;
    readonly shortlistComparisons: number;
    readonly totalSemanticComparisons: number;
  };
}

export type RecallRerankResponse = readonly number[] | RecallRerankExecution | undefined;
export type RecallRerankMode = "correction-pair" | "ranking-only";
export interface RecallRerankFn {
  (query: string, candidateTexts: readonly string[], context?: RecallRerankContext): Promise<RecallRerankResponse>;
  readonly mode?: RecallRerankMode;
}

export interface NoteRetrievalSnapshotIdentity {
  readonly query: string;
  readonly embedModel: string;
  readonly topK: number;
  readonly scope: string | undefined;
  readonly notesDir: string;
  readonly notesIndexFile: string;
  readonly indexBuiltAtIso: string;
  readonly conflictAwareSelection: boolean;
  readonly candidateIndexDigest: string;
  readonly rerankResultHash: string;
  readonly temporalClaim?: TemporalClaimSnapshotIdentityV1;
}

export interface TemporalClaimSnapshotAuthorityV1 {
  readonly schema: "muse.temporal-claim-snapshot-authority.v1";
  readonly storeState: "absent" | "empty" | "valid" | "unavailable";
  readonly storeRevision: number;
  readonly rawStoreDigest: string | null;
  readonly graphDigest: string | null;
  readonly indexDigest: string | null;
  readonly chunkerVersion: typeof NOTES_CHUNKER_VERSION;
  readonly sourceProvenanceDigest: string | null;
}

export interface TemporalClaimSnapshotIdentityV1 {
  readonly authority?: TemporalClaimSnapshotAuthorityV1;
  readonly selectedRelation?: SupersedesRelationV1;
}

export interface TemporalClaimContextV1 {
  readonly authority: TemporalClaimSnapshotAuthorityV1;
  readonly graph?: TemporalClaimGraphV1;
}

export function temporalClaimSnapshotMatchesContextV1(
  snapshot: NoteRetrievalSnapshot,
  context: TemporalClaimContextV1 | undefined
): boolean {
  const identity = snapshot.identity.temporalClaim;
  if (!identity && !context) return true;
  if (!identity?.authority || !context) return false;
  if (identity.authority.storeState === "unavailable" || context.authority.storeState === "unavailable") return false;
  if (JSON.stringify(identity.authority) !== JSON.stringify(context.authority)) return false;
  if (!identity.selectedRelation) return true;
  return context.graph?.relations.some((relation) => JSON.stringify(relation) === JSON.stringify(identity.selectedRelation)) === true;
}

export function retrievalIndexSnapshotDigestV1(indexFiles: readonly RetrievalFileEntry[]): string {
  return createHash("sha256").update(JSON.stringify(indexFiles.map((file) => ({
    chunkerVersion: file.chunkerVersion ?? null,
    chunks: file.chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      embedding: Array.from(chunk.embedding),
      file: chunk.file,
      text: chunk.text
    })),
    path: file.path,
    sourceHash: file.sourceHash ?? null
  })))).digest("hex");
}

export interface NoteRetrievalSnapshot {
  readonly identity: NoteRetrievalSnapshotIdentity;
  readonly rerankFn: RecallRerankFn | undefined;
  readonly result: Omit<NoteRetrievalResult, "snapshot">;
}

const MAX_TEMPORAL_GRAPH_RELATIONS = 1_024;
const MAX_TEMPORAL_GRAPH_CANDIDATES = 65_536;

function temporalCandidateKey(sourcePath: string, chunkIndex: number): string {
  return JSON.stringify([sourcePath, chunkIndex]);
}

/** Pure, bounded activation of one already-validated explicit temporal edge. */
export function activateTemporalClaimGraphV1(input: {
  readonly candidates: readonly ScoredChunk[];
  readonly confidentAt: number;
  readonly graph: TemporalClaimGraphV1;
  readonly indexFiles: readonly RetrievalFileEntry[];
  readonly notesDir: string;
  readonly query: string;
  readonly topK: number;
}): TemporalClaimGraphActivationV1 | undefined {
  try {
    if (input.topK < 2 || input.candidates.length === 0 || input.candidates.length > MAX_TEMPORAL_GRAPH_CANDIDATES
      || !Number.isFinite(input.confidentAt) || detectStaleMarker(input.query)) return undefined;
    const graph = createTemporalClaimGraphV1({ relations: input.graph.relations });
    if (graph.relations.length === 0 || graph.relations.length > MAX_TEMPORAL_GRAPH_RELATIONS) return undefined;
    const ranked = [...input.candidates].sort((left, right) => right.score - left.score);
    const top = ranked[0];
    if (!top || top.score < input.confidentAt || (ranked[1] !== undefined && ranked[1]!.score === top.score)) return undefined;

    const candidateMap = new Map<string, ScoredChunk[]>();
    for (const candidate of input.candidates) {
      const sourcePath = relativizeNoteSource(candidate.file, input.notesDir);
      const key = temporalCandidateKey(sourcePath, candidate.chunk.chunkIndex);
      const values = candidateMap.get(key) ?? [];
      values.push(candidate);
      candidateMap.set(key, values);
    }
    const fileMap = new Map<string, RetrievalFileEntry[]>();
    for (const file of input.indexFiles) {
      const sourcePath = relativizeNoteSource(file.path, input.notesDir);
      const values = fileMap.get(sourcePath) ?? [];
      values.push(file);
      fileMap.set(sourcePath, values);
    }
    const endpoint = (identity: NoteSpanIdentityV1) => {
      const candidates = candidateMap.get(temporalCandidateKey(identity.sourcePath, identity.chunkIndex));
      const files = fileMap.get(identity.sourcePath);
      if (candidates?.length !== 1 || files?.length !== 1) return undefined;
      const file = files[0]!;
      if (file.sourceHash === undefined || file.chunkerVersion !== NOTES_CHUNKER_VERSION) return undefined;
      const resolution = resolveNoteSpanIdentityV1FromIndex(identity, {
        chunkerVersion: NOTES_CHUNKER_VERSION,
        chunks: file.chunks.map((chunk) => ({ chunkIndex: chunk.chunkIndex, text: chunk.text })),
        notesIndexSchema: NOTES_INDEX_SCHEMA_VERSION,
        sourceHash: file.sourceHash,
        sourcePath: identity.sourcePath
      });
      return resolution.status === "resolved"
        ? { candidate: candidates[0]!, identity, span: resolution.span }
        : undefined;
    };
    const matches = graph.relations.flatMap((relation) => {
      const current = endpoint(relation.current);
      const stale = endpoint(relation.stale);
      if (!current || !stale || current.candidate === stale.candidate) return [];
      return [{ current, relation, stale }];
    }).filter(({ current, stale }) => current.candidate === top || stale.candidate === top);
    if (matches.length !== 1) return undefined;
    const selected = matches[0]!;
    const queryTokens = lexicalTokens(input.query);
    const currentTokens = lexicalTokens(selected.current.span);
    const staleTokens = lexicalTokens(selected.stale.span);
    if (![...queryTokens].some((token) => currentTokens.has(token) && staleTokens.has(token))) return undefined;
    const baseline = diversifyAskChunks(input.candidates, input.topK, undefined, input.query);
    const rest = baseline.filter((candidate) => candidate !== selected.current.candidate && candidate !== selected.stale.candidate);
    return Object.freeze({
      relation: selected.relation,
      scored: Object.freeze([selected.current.candidate, selected.stale.candidate, ...rest].slice(0, input.topK)),
      verifiedCorrectionPair: Object.freeze({
        current: Object.freeze({ chunkIndex: selected.current.candidate.chunk.chunkIndex, file: selected.current.candidate.file }),
        stale: Object.freeze({ chunkIndex: selected.stale.candidate.chunk.chunkIndex, file: selected.stale.candidate.file })
      })
    });
  } catch {
    return undefined;
  }
}

export async function retrieveAndRankNotes(params: {
  readonly query: string;
  readonly embedModel: string;
  readonly indexFiles: readonly RetrievalFileEntry[];
  readonly notesDir: string;
  readonly topK: number;
  readonly scope: string | undefined;
  readonly json: boolean;
  readonly onStderr: (text: string) => void;
  /** Embed via the caller's resolved endpoint (the CLI binds the models.json merge). */
  readonly embedFn: (text: string, model: string) => Promise<number[]>;
  /** Optional frozen environment view. Omitted direct callers preserve ambient behavior. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Optional listwise reranker over the candidate window (the CLI binds a
   * local-LLM picker behind MUSE_RECALL_RERANK). Receives the query + candidate
   * texts, returns candidate indices best-first — or undefined to fail open.
   */
  readonly rerankFn?: RecallRerankFn;
  /** Deferred local-model preparation, invoked once only after explicit-edge activation is inert. */
  readonly prepareRerankFn?: () => Promise<RecallRerankFn | undefined>;
  /** Internal diagnostic/development switch. Production bindings default ON; direct core callers opt in explicitly. */
  readonly conflictAwareSelection?: boolean;
  /** Index generation identity required to mint a reusable first-retrieval snapshot. */
  readonly snapshotIdentity?: { readonly notesIndexFile: string; readonly indexBuiltAtIso: string };
  /** Already validated immutable explicit temporal graph. Never reads owner state here. */
  readonly temporalClaimGraph?: TemporalClaimGraphV1;
  /** Frozen local authority metadata captured by the CLI at the first retrieval boundary. */
  readonly temporalClaimAuthority?: TemporalClaimSnapshotAuthorityV1;
}): Promise<NoteRetrievalResult> {
  const { query, embedModel, indexFiles, notesDir, scope, json, onStderr, embedFn } = params;
  let rerankFn = params.rerankFn;
  const topK = normalizeRetrievalTopK(params.topK);
  const env = params.env ?? process.env;

  let scored: ScoredChunk[] = [];
  let preGapScored: ScoredChunk[] = [];
  let subqueryEmbeddings: ReadonlyArray<readonly number[]> = [];
  let splitClauses: readonly string[] = [];
  let notesUnavailable = false;
  let queryVec: number[] | undefined;
  let rerankDecision: RecallRerankDecision | undefined;
  let rerankPair: RecallRerankPairHint | undefined;
  let verifiedCorrectionPair: VerifiedCorrectionPair | undefined;
  let rerankWindow: readonly ScoredChunk[] = [];
  let temporalActivated = false;
  let selectedTemporalRelation: SupersedesRelationV1 | undefined;
  try {
    // S3 narrate-the-wait: a REAL stage delta before the embed — on a 10-40s local
    // model the pre-answer gap reads as a hang; this makes it read as thinking.
    if (!json) {
      onStderr("🔎 searching your notes…\n");
    }
    queryVec = await embedFn(query, embedModel);
    const liveNoteFiles = filterLiveNoteIndexFiles(indexFiles, existsSync);
    const scopedNoteFiles = scope ? filterNotesByScope(liveNoteFiles, notesDir, scope) : liveNoteFiles;
    if (scope && liveNoteFiles.length > 0 && scopedNoteFiles.length === 0 && !json) {
      onStderr(`muse: no notes under '${scope}/' — grounding on nothing for this question.\n`);
    }
    const allScored = scopedNoteFiles.flatMap((f) => f.chunks.map((chunk) => ({
      chunk,
      file: f.path,
      score: cosine(queryVec!, chunk.embedding)
    })));
    preGapScored = [...allScored].sort((a, b) => b.score - a.score).slice(0, topK);
    const candidateSnapshot = Object.freeze(allScored.map((candidate) => Object.freeze(candidate)));
    const temporalActivation = params.temporalClaimGraph
      ? activateTemporalClaimGraphV1({
          candidates: candidateSnapshot,
          confidentAt: resolveRecallConfidentAt(env, embedModel),
          graph: params.temporalClaimGraph,
          indexFiles: scopedNoteFiles,
          notesDir,
          query,
          topK
        })
      : undefined;
    if (temporalActivation) {
      temporalActivated = true;
      selectedTemporalRelation = temporalActivation.relation;
      scored = [...temporalActivation.scored];
      verifiedCorrectionPair = cloneVerifiedCorrectionPair(temporalActivation.verifiedCorrectionPair);
    } else {
    if (!rerankFn && params.prepareRerankFn) {
      try {
        rerankFn = await params.prepareRerankFn();
      } catch {
        rerankFn = undefined;
      }
    }
    // RAG-Fusion (arXiv:2402.03367): for a compound question each clause gets its
    // own embedding → its own cosine ranking → all rankings fused via RRF. Fail-open:
    // any embed error leaves clause vectors empty (byte-identical to non-compound).
    try {
      const clauses = splitCompoundQuery(query);
      if (clauses.length >= 2) {
        splitClauses = clauses;
        subqueryEmbeddings = await Promise.all(clauses.map((c) => embedFn(c, embedModel)));
      }
    } catch {
      subqueryEmbeddings = [];
      splitClauses = [];
    }
    // Hybrid (cosine + lexical + per-clause RRF) MMR selection. With a reranker
    // bound, MMR gathers a wider window and a local LLM picks which chunks make
    // the prompt — cosine ranking is fooled by lexical-overlap distractors
    // (measured 2026-07-15: cosine top-1 3/8 vs LLM-reranked 8/8 at ~200-540ms).
    if (rerankFn) {
      const requestedWindow = rerankFn.mode === "correction-pair" ? PAIR_AWARE_RERANK_WINDOW : topK + 4;
      const windowLimit = Math.min(requestedWindow, allScored.length);
      const window = diversifyAskChunks(allScored, windowLimit, undefined, query, subqueryEmbeddings);
      const shouldBackfillWindow = rerankFn.mode === "correction-pair"
        ? window.length < windowLimit
        : window.length <= topK && allScored.length > topK;
      if (shouldBackfillWindow) {
        for (const candidate of [...allScored].sort((a, b) => b.score - a.score)) {
          if (window.length >= windowLimit) break;
          if (!window.includes(candidate)) window.push(candidate);
        }
      }
      let bridgeComparisons = 0;
      if (rerankFn.mode === "correction-pair") {
        const cosineRanked = [...allScored].sort((a, b) => b.score - a.score);
        const coverage = buildCorrectionPairCoverage(window, cosineRanked);
        bridgeComparisons = coverage?.bridgeComparisons ?? 0;
        window.splice(
          0,
          window.length,
          ...(coverage ? [...coverage.current, ...coverage.stale] : [])
        );
      }
      rerankWindow = window;
      const pairAwareFallback = rerankFn.mode === "correction-pair"
        ? diversifyAskChunks(allScored, topK, undefined, query, subqueryEmbeddings)
        : undefined;
      scored = pairAwareFallback ?? window.slice(0, topK);
      const correctionPairCandidates = rerankFn.mode === "correction-pair"
        ? toCorrectionPairShortlistCandidates(window)
        : undefined;
      const pairShortlist = correctionPairCandidates
        ? buildCorrectionPairShortlist(correctionPairCandidates)
        : undefined;
      const pairRerankContext = pairShortlist
        ? buildCorrectionPairRerankContext(pairShortlist, bridgeComparisons)
        : undefined;
      const selectorWindow = pairShortlist
        ? pairShortlist.windowIndices.map((index) => window[index]!)
        : window;
      const canInvokeReranker = rerankFn.mode !== "correction-pair" || pairRerankContext !== undefined;
      if (window.length > topK && canInvokeReranker) {
        try {
          const rawResponse = await rerankFn(query, selectorWindow.map((s) => s.chunk.text), pairRerankContext);
          const rawExecution = isRerankExecution(rawResponse) ? rawResponse : undefined;
          const response = pairShortlist
            ? reverseMapRerankResponse(rawResponse, pairShortlist.windowIndices)
            : rawResponse;
          const execution = isRerankExecution(response) ? response : undefined;
          const order = execution?.order ?? (Array.isArray(response) ? response : undefined);
          const valid = [...new Set((order ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < window.length))];
          const outcome = execution
            ? (execution.outcome === "success" && valid.length === 0 ? "invalid" : execution.outcome)
            : (valid.length > 0 ? "success" : (order?.length ? "invalid" : "empty"));
          rerankDecision = {
            eligible: true,
            httpAttempts: execution && Number.isSafeInteger(execution.httpAttempts) && execution.httpAttempts >= 0
              ? execution.httpAttempts
              : 0,
            logicalInvocations: 1,
            outcome
          };
          if (outcome === "success" && valid.length > 0) {
            if (rerankFn.mode === "correction-pair") {
              const selection = correctionPairCandidates && pairShortlist && rawExecution
                ? resolveCorrectionPairSelection(correctionPairCandidates, pairShortlist, rawExecution)
                : undefined;
              if (!selection) {
                rerankDecision = { ...rerankDecision, outcome: "invalid" };
              } else if (selection.outcome === "pair") {
                rerankPair = selection.rerankPair;
                verifiedCorrectionPair = selection.verifiedCorrectionPair;
              }
            } else {
              rerankPair = selectHighestValidRerankPair(execution?.pairHints, window, valid);
              verifiedCorrectionPair = rerankPair ? toVerifiedCorrectionPair(rerankPair, window) : undefined;
            }
            if (rerankFn.mode !== "correction-pair" || rerankPair) {
              const chosen = valid.slice(0, topK).map((i) => window[i]!);
              for (const s of window) {
                if (chosen.length >= topK) break;
                if (!chosen.includes(s)) chosen.push(s);
              }
              scored = chosen;
            }
          }
        } catch {
          rerankDecision = { eligible: true, httpAttempts: 0, logicalInvocations: 1, outcome: "error" };
          // reranker is best-effort — a dead model never fails the ask
        }
      } else {
        if (window.length <= topK && canInvokeReranker) {
          rerankDecision = { eligible: false, httpAttempts: 0, logicalInvocations: 0, outcome: "ineligible-window" };
        }
      }
    } else {
      scored = diversifyAskChunks(allScored, topK, undefined, query, subqueryEmbeddings);
    }
    }
    if (!temporalActivated && params.conflictAwareSelection === true) {
      scored = preserveConflictPairs(scored, allScored, topK);
    }
    if (!temporalActivated && rerankPair) {
      scored = preserveRerankPair(scored, rerankWindow, topK, rerankPair);
    }
    // Graph-augmented recall (HippoRAG / GraphRAG): pull in chunks from notes 1-hop
    // LINKED from the CONFIDENT matches. Fabrication-SAFE: only the user's own real
    // notes, fires ONLY from a confident seed, the linked chunk keeps its real cosine.
    const confidentAt = resolveRecallConfidentAt(env, embedModel);
    const singleHopVerdict = classifyRetrievalConfidence(
      scored.map((s) => ({ cosine: s.score, score: s.score, source: relativizeNoteSource(s.file, notesDir), text: s.chunk.text })),
      { confidentAt }
    );
    const graphHopEnabled = env.MUSE_RECALL_GRAPH_HOP !== "false";
    try {
      const seedMatches = scored.map((s) => ({ cosine: s.score, score: s.score, source: relativizeNoteSource(s.file, notesDir), text: s.chunk.text }));
      // From a CONFIDENT seed any linked neighbor may ride along; from an
      // AMBIGUOUS seed the graph hop is exactly the independent signal the
      // failed cosine ranking needs, but only a neighbor clearing the floor
      // is promoted. Floor = bar − 0.2 (min 0.2): measured 2026-07-15 on
      // nomic-v2-moe, same-topic neighbors sit at 0.35-0.42 vs ≤0.21 for
      // off-topic, so bar 0.45 → floor 0.25 splits the two populations.
      const ambiguousFloor = Math.max(0.2, confidentAt - 0.2);
      if (graphHopEnabled && (singleHopVerdict === "confident" || singleHopVerdict === "ambiguous")) {
        const noteBodies = scopedNoteFiles
          .map((f) => ({ body: f.chunks.map((c) => c.text).join("\n"), id: relativizeNoteSource(f.path, notesDir) }));
        const seen = new Set(seedMatches.map((m) => m.source));
        // Gather wide (both link directions), then promote by REAL query cosine
        // — document order of a hub note's links is not a relevance signal.
        const promoted = linkExpandRefs({ noteBodies, seedRefs: seedMatches.map((m) => m.source), cap: 8 })
          .filter((ref) => !seen.has(ref))
          .map((ref) => allScored
            .filter((s) => relativizeNoteSource(s.file, notesDir) === ref)
            .sort((a, b) => b.score - a.score)[0])
          .filter((best): best is NonNullable<typeof best> => best !== undefined && !scored.includes(best))
          .filter((best) => singleHopVerdict === "confident" || best.score >= ambiguousFloor)
          .sort((a, b) => b.score - a.score)
          .slice(0, 2);
        scored = [...scored, ...promoted];
      }
    } catch {
      // graph expansion is best-effort — a malformed graph never fails the ask
    }
    // Second-hop AUGMENT (pseudo-relevance feedback): from the top seed(s) re-rank the
    // SAME in-memory chunks by cosine to the seed's embedding and APPEND the best
    // non-present chunk(s). CONFIDENCE-GATED (skipped when single-hop is confident);
    // MUSE_RECALL_SECOND_HOP=false overrides; the citation gate is the hard backstop.
    const secondHopEnabled = env.MUSE_RECALL_SECOND_HOP !== "false";
    if (secondHopEnabled && shouldSecondHop(singleHopVerdict) && queryVec && scored.length > 0) {
      try {
        const additions = secondHopAugmentChunks(queryVec, cosine, allScored, scored.slice(0, 2), scored, 2);
        for (const add of additions) {
          if (!scored.includes(add)) scored = [...scored, add];
        }
      } catch {
        // second-hop is best-effort — never fails the ask
      }
    }
  } catch (cause) {
    notesUnavailable = true;
    const detail = errorMessage(cause);
    onStderr(
      `(notes search unavailable — embedding via '${embedModel}' failed: ${detail}. ` +
      `Answering without notes context. To restore RAG grounding: ` +
      `\`ollama pull ${embedModel}\` (and ensure Ollama is running).)\n`
    );
  }

  // A note that explicitly marks itself superseded ("used to …", "예전에 …")
  // must not outrank its current counterpart in the answer evidence — demote it
  // below, never drop it. Confidence classification reads `preGapScored`
  // (untouched), so this only reorders which chunk the model sees/cites first.
  const result: Omit<NoteRetrievalResult, "snapshot"> = {
    notesUnavailable,
    preGapScored: [...preGapScored],
    queryVec: queryVec ? [...queryVec] : undefined,
    ...(rerankDecision ? { rerankDecision } : {}),
    ...(rerankPair ? { rerankPair: { ...rerankPair } } : {}),
    ...(verifiedCorrectionPair ? { verifiedCorrectionPair: cloneVerifiedCorrectionPair(verifiedCorrectionPair) } : {}),
    scored: demoteStale(scored, (s) => s.chunk.text),
    splitClauses: [...splitClauses],
    subqueryEmbeddings: subqueryEmbeddings.map((embedding) => [...embedding])
  };
  if (!params.snapshotIdentity) return result;
  const snapshotResult: Omit<NoteRetrievalResult, "snapshot"> = {
    ...result,
    preGapScored: [...result.preGapScored],
    queryVec: result.queryVec ? [...result.queryVec] : undefined,
    scored: [...result.scored],
    splitClauses: [...result.splitClauses],
    subqueryEmbeddings: result.subqueryEmbeddings.map((embedding) => [...embedding]),
    ...(result.verifiedCorrectionPair ? { verifiedCorrectionPair: cloneVerifiedCorrectionPair(result.verifiedCorrectionPair) } : {})
  };
  const identity: NoteRetrievalSnapshotIdentity = {
    candidateIndexDigest: retrievalIndexSnapshotDigestV1(indexFiles),
    conflictAwareSelection: params.conflictAwareSelection === true,
    embedModel,
    indexBuiltAtIso: params.snapshotIdentity.indexBuiltAtIso,
    notesDir,
    notesIndexFile: params.snapshotIdentity.notesIndexFile,
    query,
    rerankResultHash: noteRetrievalResultHash(snapshotResult),
    ...((params.temporalClaimAuthority || selectedTemporalRelation) ? {
      temporalClaim: Object.freeze({
        ...(params.temporalClaimAuthority ? { authority: params.temporalClaimAuthority } : {}),
        ...(selectedTemporalRelation ? { selectedRelation: selectedTemporalRelation } : {})
      })
    } : {}),
    scope: normalizedScope(scope),
    topK
  };
  Object.freeze(snapshotResult.preGapScored);
  if (snapshotResult.queryVec) Object.freeze(snapshotResult.queryVec);
  Object.freeze(snapshotResult.scored);
  Object.freeze(snapshotResult.splitClauses);
  if (snapshotResult.rerankPair) Object.freeze(snapshotResult.rerankPair);
  if (snapshotResult.verifiedCorrectionPair) {
    Object.freeze(snapshotResult.verifiedCorrectionPair.current);
    Object.freeze(snapshotResult.verifiedCorrectionPair.stale);
    Object.freeze(snapshotResult.verifiedCorrectionPair);
  }
  for (const embedding of snapshotResult.subqueryEmbeddings) Object.freeze(embedding);
  Object.freeze(snapshotResult.subqueryEmbeddings);
  Object.freeze(snapshotResult);
  if (identity.temporalClaim?.authority) Object.freeze(identity.temporalClaim.authority);
  if (identity.temporalClaim?.selectedRelation) Object.freeze(identity.temporalClaim.selectedRelation);
  const snapshot = Object.freeze({ identity: Object.freeze(identity), rerankFn, result: snapshotResult });
  return { ...result, snapshot };
}

export function noteRetrievalResultHash(result: Omit<NoteRetrievalResult, "snapshot">): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

export function buildCorrectionPairShortlist(
  candidates: readonly CorrectionPairShortlistCandidate[],
  order: CorrectionPairShortlistOrder = "original"
): CorrectionPairShortlist | undefined {
  try {
    if (
      candidates.length === 0
      || candidates.length > PAIR_AWARE_RERANK_WINDOW
      || (order !== "original" && order !== "reversed-within-groups")
    ) return undefined;
    const embeddingDimension = candidates[0]?.embedding.length;
    if (!embeddingDimension || candidates.some((candidate) => candidate.embedding.length !== embeddingDimension)) {
      return undefined;
    }
    const identityKeys = candidates.map((candidate) => {
      if (
        candidate.identity.file.length === 0
        || !Number.isSafeInteger(candidate.identity.chunkIndex)
        || candidate.identity.chunkIndex < 0
        || !Number.isFinite(candidate.queryScore)
        || candidate.embedding.length === 0
        || !isFiniteEmbedding(candidate.embedding)
      ) return undefined;
      return JSON.stringify([candidate.identity.file, candidate.identity.chunkIndex]);
    });
    if (identityKeys.some((identity) => identity === undefined)) return undefined;
    if (new Set(identityKeys).size !== identityKeys.length) return undefined;

    const currentIndices = candidates.flatMap((candidate, index) => candidate.stale ? [] : [index])
      .slice(0, PAIR_SHORTLIST_SIDE_LIMIT);
    const staleIndices = candidates.flatMap((candidate, index) => candidate.stale ? [index] : [])
      .slice(0, PAIR_SHORTLIST_SIDE_LIMIT);
    if (currentIndices.length === 0 || staleIndices.length === 0) return undefined;

    const proposals = currentIndices.flatMap((currentIndex) => staleIndices.map((staleIndex) => {
      const current = candidates[currentIndex]!;
      const stale = candidates[staleIndex]!;
      const queryRelevance = clampUnitInterval(Math.min(current.queryScore, stale.queryScore));
      const semanticCompatibility = clampUnitInterval(cosine(current.embedding, stale.embedding));
      return {
        compatibility: queryRelevance * semanticCompatibility,
        currentIndex,
        higherQueryScore: clampUnitInterval(Math.max(current.queryScore, stale.queryScore)),
        lowerQueryScore: queryRelevance,
        staleIndex
      };
    })).filter((proposal) => proposal.compatibility > 0)
      .sort((left, right) =>
        right.compatibility - left.compatibility
        || right.lowerQueryScore - left.lowerQueryScore
        || right.higherQueryScore - left.higherQueryScore
        || left.currentIndex - right.currentIndex
        || left.staleIndex - right.staleIndex)
      .slice(0, PAIR_SHORTLIST_PROPOSAL_LIMIT);
    if (proposals.length === 0 || proposals.length > PAIR_SHORTLIST_PROPOSAL_LIMIT) return undefined;

    const selectedCurrentIndices = [...new Set(proposals.map((proposal) => proposal.currentIndex))];
    const selectedStaleIndices = [...new Set(proposals.map((proposal) => proposal.staleIndex))];
    const windowIndices = order === "reversed-within-groups"
      ? [[...selectedCurrentIndices].reverse(), [...selectedStaleIndices].reverse()].flat()
      : [...selectedCurrentIndices, ...selectedStaleIndices];
    if (
      windowIndices.length === 0
      || windowIndices.length > PAIR_SHORTLIST_CANDIDATE_LIMIT
      || new Set(windowIndices).size !== windowIndices.length
      || windowIndices.some((index) => index < 0 || index >= candidates.length)
    ) return undefined;
    for (const index of windowIndices) {
      const identity = identityKeys[index];
      if (identity === undefined || identityKeys.filter((candidateIdentity) => candidateIdentity === identity).length !== 1) {
        return undefined;
      }
    }
    return {
      diagnostics: {
        candidateCount: windowIndices.length,
        compatibilityComparisons: currentIndices.length * staleIndices.length,
        proposalCount: proposals.length
      },
      proposals: proposals.map((proposal) => ({ current: proposal.currentIndex, stale: proposal.staleIndex })),
      windowIndices
    };
  } catch {
    return undefined;
  }
}

function clampUnitInterval(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function buildCorrectionPairRerankContext(
  shortlist: CorrectionPairShortlist,
  bridgeComparisons = 0
): RecallRerankContext | undefined {
  try {
    const shortlistComparisons = shortlist.diagnostics.compatibilityComparisons;
    const totalSemanticComparisons = bridgeComparisons + shortlistComparisons;
    if (
      !Array.isArray(shortlist.windowIndices)
      || shortlist.windowIndices.length === 0
      || shortlist.windowIndices.length > PAIR_SHORTLIST_CANDIDATE_LIMIT
      || shortlist.windowIndices.length !== shortlist.diagnostics.candidateCount
      || new Set(shortlist.windowIndices).size !== shortlist.windowIndices.length
      || shortlist.windowIndices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= PAIR_AWARE_RERANK_WINDOW)
      || !Array.isArray(shortlist.proposals)
      || shortlist.proposals.length === 0
      || shortlist.proposals.length > PAIR_SHORTLIST_PROPOSAL_LIMIT
      || shortlist.proposals.length !== shortlist.diagnostics.proposalCount
      || !Number.isSafeInteger(bridgeComparisons)
      || bridgeComparisons < 0
      || bridgeComparisons > PAIR_BRIDGE_STALE_POOL_LIMIT
      || !Number.isSafeInteger(shortlistComparisons)
      || shortlistComparisons <= 0
      || shortlistComparisons > PAIR_SHORTLIST_SIDE_LIMIT ** 2
      || totalSemanticComparisons > PAIR_PRODUCTION_COMPARISON_LIMIT
    ) return undefined;
    const selectorIndexByWindowIndex = new Map(shortlist.windowIndices.map((windowIndex, selectorIndex) => [windowIndex, selectorIndex]));
    const seen = new Set<string>();
    const allowedCorrectionPairs: RecallRerankPairHint[] = [];
    for (const proposal of shortlist.proposals) {
      if (!isClosedRerankPairHint(proposal)) return undefined;
      const current = selectorIndexByWindowIndex.get(proposal.current);
      const stale = selectorIndexByWindowIndex.get(proposal.stale);
      if (current === undefined || stale === undefined || current === stale) return undefined;
      const key = `${current.toString()}:${stale.toString()}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      allowedCorrectionPairs.push({ current, stale });
    }
    return {
      allowedCorrectionPairs,
      diagnostics: { bridgeComparisons, shortlistComparisons, totalSemanticComparisons }
    };
  } catch {
    return undefined;
  }
}

export function resolveCorrectionPairSelection(
  candidates: readonly CorrectionPairShortlistCandidate[],
  shortlist: CorrectionPairShortlist,
  execution: RecallRerankExecution
): ResolvedCorrectionPairSelection | undefined {
  try {
    if (execution.outcome !== "success" || !Array.isArray(execution.order)) {
      return undefined;
    }
    const identityKeys = candidates.map((candidate) => correctionPairIdentityKey(candidate));
    if (identityKeys.some((identity) => identity === undefined) || new Set(identityKeys).size !== identityKeys.length) {
      return undefined;
    }
    if (
      shortlist.windowIndices.length === 0
      || shortlist.windowIndices.length > PAIR_SHORTLIST_CANDIDATE_LIMIT
      || shortlist.windowIndices.length !== shortlist.diagnostics.candidateCount
      || !Array.isArray(shortlist.proposals)
      || shortlist.proposals.length !== shortlist.diagnostics.proposalCount
      || shortlist.diagnostics.proposalCount <= 0
      || shortlist.diagnostics.proposalCount > PAIR_SHORTLIST_PROPOSAL_LIMIT
      || shortlist.diagnostics.compatibilityComparisons <= 0
      || shortlist.diagnostics.compatibilityComparisons > PAIR_SHORTLIST_SIDE_LIMIT ** 2
      || new Set(shortlist.windowIndices).size !== shortlist.windowIndices.length
    ) return undefined;
    let reachedStaleGroup = false;
    for (const windowIndex of shortlist.windowIndices) {
      const candidate = candidates[windowIndex];
      if (!candidate) return undefined;
      if (candidate.stale) {
        reachedStaleGroup = true;
      } else if (reachedStaleGroup) {
        return undefined;
      }
    }
    const allowedPairKeys = new Set<string>();
    for (const proposal of shortlist.proposals) {
      if (!isClosedRerankPairHint(proposal)) return undefined;
      const current = candidates[proposal.current];
      const stale = candidates[proposal.stale];
      if (
        !current
        || !stale
        || current.stale
        || !stale.stale
        || !shortlist.windowIndices.includes(proposal.current)
        || !shortlist.windowIndices.includes(proposal.stale)
      ) return undefined;
      const key = `${proposal.current.toString()}:${proposal.stale.toString()}`;
      if (allowedPairKeys.has(key)) return undefined;
      allowedPairKeys.add(key);
    }

    const validOrder = [...new Set(execution.order.filter((index) =>
      Number.isSafeInteger(index) && index >= 0 && index < shortlist.windowIndices.length))];
    if (validOrder.length === 0) return undefined;
    if (execution.pairHints === undefined) return { outcome: "null" };
    if (!Array.isArray(execution.pairHints) || execution.pairHints.length !== 1) return undefined;
    const rank = new Map(validOrder.map((candidateIndex, position) => [candidateIndex, position]));
    const pair = execution.pairHints[0];
    if (
      !isClosedRerankPairHint(pair)
      || pair.current === pair.stale
      || pair.current < 0
      || pair.stale < 0
      || pair.current >= shortlist.windowIndices.length
      || pair.stale >= shortlist.windowIndices.length
      || !rank.has(pair.current)
      || !rank.has(pair.stale)
    ) return undefined;
    const localCurrent = candidates[shortlist.windowIndices[pair.current]!];
    const localStale = candidates[shortlist.windowIndices[pair.stale]!];
    if (!localCurrent || !localStale || localCurrent.stale || !localStale.stale) return undefined;

    const currentIndex = shortlist.windowIndices[pair.current];
    const staleIndex = shortlist.windowIndices[pair.stale];
    if (currentIndex === undefined || staleIndex === undefined) return undefined;
    const current = candidates[currentIndex];
    const stale = candidates[staleIndex];
    if (
      !current
      || !stale
      || current.stale
      || !stale.stale
      || sameNoteChunkIdentity(current.identity, stale.identity)
      || !allowedPairKeys.has(`${currentIndex.toString()}:${staleIndex.toString()}`)
    ) {
      return undefined;
    }
    return {
      outcome: "pair",
      rerankPair: { current: currentIndex, stale: staleIndex },
      verifiedCorrectionPair: {
        current: { ...current.identity },
        stale: { ...stale.identity }
      }
    };
  } catch {
    return undefined;
  }
}

function correctionPairIdentityKey(candidate: CorrectionPairShortlistCandidate): string | undefined {
  if (
    candidate.identity.file.length === 0
    || !Number.isSafeInteger(candidate.identity.chunkIndex)
    || candidate.identity.chunkIndex < 0
  ) return undefined;
  return JSON.stringify([candidate.identity.file, candidate.identity.chunkIndex]);
}

function toCorrectionPairShortlistCandidates(
  window: readonly ScoredChunk[]
): CorrectionPairShortlistCandidate[] | undefined {
  try {
    const candidates: CorrectionPairShortlistCandidate[] = [];
    for (const candidate of window) {
      const identity = toNoteChunkIdentity(candidate);
      if (!identity) return undefined;
      candidates.push({
        embedding: candidate.chunk.embedding,
        identity,
        queryScore: candidate.score,
        stale: detectStaleMarker(candidate.chunk.text)
      });
    }
    return candidates;
  } catch {
    return undefined;
  }
}

function selectCorrectionPairCoverage(
  hybridWindow: readonly ScoredChunk[],
  cosineBackfill: readonly ScoredChunk[],
  stale: boolean,
  limit: number
): ScoredChunk[] | undefined {
  const selected: ScoredChunk[] = [];
  const candidateByIdentity = new Map<string, ScoredChunk>();
  for (const candidate of [...hybridWindow, ...cosineBackfill]) {
    if (detectStaleMarker(candidate.chunk.text) !== stale) continue;
    const identity = toNoteChunkIdentity(candidate);
    if (!identity) continue;
    const key = JSON.stringify([identity.file, identity.chunkIndex]);
    const existing = candidateByIdentity.get(key);
    if (existing) {
      if (existing !== candidate) return undefined;
      continue;
    }
    candidateByIdentity.set(key, candidate);
    if (selected.length < limit) selected.push(candidate);
  }
  return selected;
}

function buildCorrectionPairCoverage(
  hybridWindow: readonly ScoredChunk[],
  cosineBackfill: readonly ScoredChunk[]
): { readonly bridgeComparisons: number; readonly current: readonly ScoredChunk[]; readonly stale: readonly ScoredChunk[] } | undefined {
  const current = selectCorrectionPairCoverage(hybridWindow, cosineBackfill, false, PAIR_PRODUCTION_CURRENT_LIMIT);
  const stalePool = selectCorrectionPairCoverage(hybridWindow, cosineBackfill, true, PAIR_BRIDGE_STALE_POOL_LIMIT);
  if (!current || !stalePool) return undefined;
  const anchor = current.reduce<ScoredChunk | undefined>((best, candidate) => {
    if (!Number.isFinite(candidate.score)) return best;
    return !best || candidate.score > best.score ? candidate : best;
  }, undefined);
  if (!anchor || stalePool.length === 0) return { bridgeComparisons: 0, current, stale: stalePool.slice(0, PAIR_PRODUCTION_STALE_LIMIT) };
  if (anchor.chunk.embedding.length === 0 || !isFiniteEmbedding(anchor.chunk.embedding)) return undefined;
  const bridged: Array<{ readonly candidate: ScoredChunk; readonly index: number; readonly score: number }> = [];
  for (let index = 0; index < stalePool.length; index += 1) {
    const candidate = stalePool[index]!;
    if (
      candidate.chunk.embedding.length !== anchor.chunk.embedding.length
      || !isFiniteEmbedding(candidate.chunk.embedding)
    ) return undefined;
    const score = cosine(anchor.chunk.embedding, candidate.chunk.embedding);
    if (!Number.isFinite(score)) return undefined;
    bridged.push({ candidate, index, score });
  }
  const stale = bridged
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, PAIR_PRODUCTION_STALE_LIMIT)
    .map((item) => item.candidate);
  return { bridgeComparisons: stalePool.length, current, stale };
}

function isFiniteEmbedding(embedding: ArrayLike<number>): boolean {
  for (let index = 0; index < embedding.length; index += 1) {
    if (!Number.isFinite(embedding[index])) return false;
  }
  return true;
}

function reverseMapRerankResponse(
  response: RecallRerankResponse,
  windowIndices: readonly number[]
): RecallRerankResponse {
  const mapIndex = (index: number): number => Number.isSafeInteger(index) && index >= 0 && index < windowIndices.length
    ? windowIndices[index]!
    : -1;
  if (Array.isArray(response)) return response.map(mapIndex);
  if (!isRerankExecution(response)) return response;
  return {
    ...response,
    ...(Array.isArray(response.order) ? { order: response.order.map(mapIndex) } : {}),
    ...(Array.isArray(response.pairHints)
      ? {
          pairHints: response.pairHints.map((hint) => isClosedRerankPairHint(hint)
            ? { current: mapIndex(hint.current), stale: mapIndex(hint.stale) }
            : hint)
        }
      : {})
  };
}

function normalizedScope(scope: string | undefined): string | undefined {
  const value = scope?.trim();
  return value ? value : undefined;
}

function selectHighestValidRerankPair(
  hints: readonly RecallRerankPairHint[] | undefined,
  window: readonly ScoredChunk[],
  order: readonly number[]
): RecallRerankPairHint | undefined {
  if (!Array.isArray(hints)) return undefined;
  const rank = new Map(order.map((candidateIndex, position) => [candidateIndex, position]));
  const seen = new Set<string>();
  return hints
    .filter((hint): hint is RecallRerankPairHint => {
      if (!isClosedRerankPairHint(hint)) return false;
      if (hint.current === hint.stale || hint.current < 0 || hint.stale < 0 || hint.current >= window.length || hint.stale >= window.length) return false;
      if (!rank.has(hint.current) || !rank.has(hint.stale)) return false;
      if (detectStaleMarker(window[hint.current]!.chunk.text) || !detectStaleMarker(window[hint.stale]!.chunk.text)) return false;
      const key = `${hint.current.toString()}:${hint.stale.toString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => pairRank(a, rank) - pairRank(b, rank))[0];
}

function isClosedRerankPairHint(value: unknown): value is RecallRerankPairHint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "current" || keys[1] !== "stale") return false;
  const hint = value as { readonly current?: unknown; readonly stale?: unknown };
  return Number.isSafeInteger(hint.current) && Number.isSafeInteger(hint.stale);
}

function pairRank(pair: RecallRerankPairHint, rank: ReadonlyMap<number, number>): number {
  return Math.min(rank.get(pair.current) ?? Number.POSITIVE_INFINITY, rank.get(pair.stale) ?? Number.POSITIVE_INFINITY);
}

function toVerifiedCorrectionPair(
  pair: RecallRerankPairHint,
  window: readonly ScoredChunk[]
): VerifiedCorrectionPair | undefined {
  const current = toNoteChunkIdentity(window[pair.current]);
  const stale = toNoteChunkIdentity(window[pair.stale]);
  if (!current || !stale || sameNoteChunkIdentity(current, stale)) return undefined;
  const identities = window.map((candidate) => toNoteChunkIdentity(candidate));
  if (identities.filter((identity) => identity && sameNoteChunkIdentity(identity, current)).length !== 1) return undefined;
  if (identities.filter((identity) => identity && sameNoteChunkIdentity(identity, stale)).length !== 1) return undefined;
  return { current, stale };
}

function toNoteChunkIdentity(candidate: ScoredChunk | undefined): NoteChunkIdentity | undefined {
  if (!candidate || candidate.file.length === 0 || !Number.isSafeInteger(candidate.chunk.chunkIndex) || candidate.chunk.chunkIndex < 0) {
    return undefined;
  }
  return { chunkIndex: candidate.chunk.chunkIndex, file: candidate.file };
}

function sameNoteChunkIdentity(left: NoteChunkIdentity, right: NoteChunkIdentity): boolean {
  return left.file === right.file && left.chunkIndex === right.chunkIndex;
}

function cloneVerifiedCorrectionPair(pair: VerifiedCorrectionPair): VerifiedCorrectionPair {
  return { current: { ...pair.current }, stale: { ...pair.stale } };
}

function preserveRerankPair(
  selected: readonly ScoredChunk[],
  window: readonly ScoredChunk[],
  topK: number,
  pair: RecallRerankPairHint
): ScoredChunk[] {
  const current = window[pair.current];
  const stale = window[pair.stale];
  if (!current || !stale) return [...selected];
  if (topK < 2) return topK === 1 ? [current] : [];
  const rest = selected.filter((candidate) => candidate !== current && candidate !== stale);
  return [current, ...rest.slice(0, topK - 2), stale];
}

function preserveConflictPairs(selected: readonly ScoredChunk[], candidates: readonly ScoredChunk[], topK: number): ScoredChunk[] {
  const out = [...selected];
  const protectedItems = new Set<ScoredChunk>();
  const tokensByCandidate = new Map(candidates.map((candidate) => [candidate, lexicalTokens(candidate.chunk.text)]));
  const documentsByToken = new Map<string, Set<string>>();
  for (const [candidate, tokens] of tokensByCandidate) {
    for (const token of tokens) {
      const files = documentsByToken.get(token) ?? new Set<string>();
      files.add(candidate.file);
      documentsByToken.set(token, files);
    }
  }
  const documentFrequency = new Map([...documentsByToken].map(([token, files]) => [token, files.size]));
  const corpusDocumentCount = new Set(candidates.map((candidate) => candidate.file)).size;
  const proposals = selected.flatMap((anchor) => {
    const anchorIsStale = detectStaleMarker(anchor.chunk.text);
    const match = candidates
      .filter((candidate) => !out.includes(candidate) && detectStaleMarker(candidate.chunk.text) !== anchorIsStale)
      .map((candidate) => ({
        candidate,
        semantic: cosine(anchor.chunk.embedding, candidate.chunk.embedding),
        topicOverlap: lexicalOverlap(tokensByCandidate.get(anchor) ?? new Set(), candidate.chunk.text),
        topicSpecific: hasSpecificLexicalTopic(anchor, candidate, tokensByCandidate, documentFrequency, corpusDocumentCount)
      }))
      .filter(({ candidate, semantic, topicOverlap, topicSpecific }) =>
        (semantic >= 0.92 && topicOverlap >= 2 && topicSpecific)
        || isPortableConflictPair(anchor, candidate, candidates, tokensByCandidate, documentFrequency, corpusDocumentCount, semantic, topicOverlap))
      .sort((a, b) => b.semantic - a.semantic || b.candidate.score - a.candidate.score)[0];
    return match ? [{ anchor, counterpart: match.candidate, semantic: match.semantic }] : [];
  }).sort((a, b) =>
    (b.anchor.score + b.counterpart.score) - (a.anchor.score + a.counterpart.score)
    || b.semantic - a.semantic);

  for (const { anchor, counterpart } of proposals) {
    if (!out.includes(anchor) || out.includes(counterpart)) continue;
    if (out.length < topK) {
      out.push(counterpart);
    } else {
      let replaceAt = out.findLastIndex((candidate) =>
        candidate !== anchor
        && !protectedItems.has(candidate)
        && detectStaleMarker(candidate.chunk.text) === detectStaleMarker(counterpart.chunk.text));
      if (replaceAt < 0) {
        replaceAt = out.findLastIndex((candidate) => candidate !== anchor && !protectedItems.has(candidate));
      }
      if (replaceAt < 0) continue;
      out[replaceAt] = counterpart;
    }
    if (detectStaleMarker(anchor.chunk.text) && !detectStaleMarker(counterpart.chunk.text)) {
      const anchorAt = out.indexOf(anchor);
      const counterpartAt = out.indexOf(counterpart);
      if (anchorAt >= 0 && counterpartAt >= 0) {
        out[anchorAt] = counterpart;
        out[counterpartAt] = anchor;
      }
    }
    protectedItems.add(anchor);
    protectedItems.add(counterpart);
  }
  return out;
}

function hasSpecificLexicalTopic(
  anchor: ScoredChunk,
  candidate: ScoredChunk,
  tokensByCandidate: ReadonlyMap<ScoredChunk, ReadonlySet<string>>,
  documentFrequency: ReadonlyMap<string, number>,
  corpusDocumentCount: number
): boolean {
  const anchorTokens = tokensByCandidate.get(anchor) ?? new Set<string>();
  const candidateTokens = tokensByCandidate.get(candidate) ?? new Set<string>();
  const shared = [...anchorTokens].filter((token) => candidateTokens.has(token));
  const shorterSize = Math.min(anchorTokens.size, candidateTokens.size);
  return shorterSize > 0
    && shared.length * 2 >= shorterSize
    && shared.some((token) => (documentFrequency.get(token) ?? 0) <= Math.max(2, Math.ceil(corpusDocumentCount * 0.05)));
}

function isPortableConflictPair(
  anchor: ScoredChunk,
  candidate: ScoredChunk,
  corpus: readonly ScoredChunk[],
  tokensByCandidate: ReadonlyMap<ScoredChunk, ReadonlySet<string>>,
  documentFrequency: ReadonlyMap<string, number>,
  corpusDocumentCount: number,
  semantic: number,
  topicOverlap: number
): boolean {
  if (topicOverlap < 3) return false;
  if (!hasSpecificLexicalTopic(anchor, candidate, tokensByCandidate, documentFrequency, corpusDocumentCount)) return false;

  const anchorIsStale = detectStaleMarker(anchor.chunk.text);
  const uniquelyBestForAnchor = corpus
    .filter((other) => other !== anchor && detectStaleMarker(other.chunk.text) !== anchorIsStale)
    .filter((other) => lexicalOverlap(new Set(tokensByCandidate.get(anchor) ?? []), other.chunk.text) >= 3)
    .filter((other) => hasSpecificLexicalTopic(anchor, other, tokensByCandidate, documentFrequency, corpusDocumentCount))
    .every((other) => other === candidate || semantic > cosine(anchor.chunk.embedding, other.chunk.embedding));
  const candidateIsStale = detectStaleMarker(candidate.chunk.text);
  const uniquelyBestForCandidate = corpus
    .filter((other) => other !== candidate && detectStaleMarker(other.chunk.text) !== candidateIsStale)
    .filter((other) => lexicalOverlap(new Set(tokensByCandidate.get(candidate) ?? []), other.chunk.text) >= 3)
    .filter((other) => hasSpecificLexicalTopic(candidate, other, tokensByCandidate, documentFrequency, corpusDocumentCount))
    .every((other) => other === anchor || semantic > cosine(candidate.chunk.embedding, other.chunk.embedding));
  if (!uniquelyBestForAnchor || !uniquelyBestForCandidate) return false;

  const anchorBackground = corpus.filter((other) => other !== anchor && other !== candidate)
    .map((other) => cosine(anchor.chunk.embedding, other.chunk.embedding));
  const candidateBackground = corpus.filter((other) => other !== anchor && other !== candidate)
    .map((other) => cosine(candidate.chunk.embedding, other.chunk.embedding));
  if (anchorBackground.length === 0 || candidateBackground.length === 0) return false;
  return semantic > mean(anchorBackground) && semantic > mean(candidateBackground);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isRerankExecution(response: RecallRerankResponse): response is RecallRerankExecution {
  return typeof response === "object" && response !== null && !Array.isArray(response) && "outcome" in response;
}

function normalizeRetrievalTopK(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, MAX_RETRIEVAL_TOP_K);
}
