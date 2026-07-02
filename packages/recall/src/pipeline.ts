/**
 * `runGroundedRecall` — the deep entry point of the grounded-recall wedge
 * (docs/recall-extraction-design.md phase 3): one call that retrieves from the
 * notes corpus, builds the citation-contracted prompt, generates through an
 * injected model callback, and passes the answer through the SAME deterministic
 * gates every Muse surface must sit behind — `enforceAnswerCitations` (a
 * fabricated source is removed by code), refusal citation-stripping (an honest
 * "I'm not sure" never carries a citation), and the embedder-aware retrieval
 * confidence verdict.
 *
 * Provider-neutral and I/O-injected: the caller supplies `embedFn` and
 * `generateAnswer` (the CLI binds its models.json-merged Ollama; the API binds
 * the server's ModelProvider; tests bind deterministic fakes), so the pipeline
 * itself never resolves credentials or vendors.
 */

import { citedSourcesIn, detectEvidenceContradictions, enforceAnswerCitations } from "@muse/agent-core";

import { CITATION_INSTRUCTION_LINES } from "./ask-prompt-constants.js";
import { retrieveAndRankNotes } from "./ask-note-retrieval.js";
import { notesGroundingFraming, type ScoredChunk } from "./chunks.js";
import { loadIndex, type ReindexSummary } from "./notes-index.js";
import { buildNoteContextBlock, formatSourceReceipts, relativizeNoteSource } from "./present.js";
import { answerIsRefusal, stripEchoedCiteAs } from "./text.js";

export interface GroundedRecallSources {
  /** The notes corpus root — cited paths are shown relative to it. */
  readonly notesDir: string;
  /** The prebuilt vector index (`muse notes reindex` / `reindexNotes` output). */
  readonly notesIndexFile: string;
}

export interface GroundedRecallOptions {
  /** Omitted ⇒ the index's own model (the only model its cosines are valid for). */
  readonly embedModel?: string;
  readonly answerModel: string;
  readonly topK?: number;
  /** Restrict grounding to notes under this corpus subfolder. */
  readonly scope?: string;
  readonly temperature?: number;
}

export interface GroundedRecallRuntime {
  /** Embed via the caller's resolved endpoint. */
  readonly embedFn: (text: string, model: string) => Promise<number[]>;
  /** One buffered completion; the caller adapts its ModelProvider. */
  readonly generateAnswer: (args: {
    readonly system: string;
    readonly user: string;
    readonly model: string;
    readonly temperature?: number;
  }) => Promise<string>;
}

export interface GroundedRecallInput {
  readonly query: string;
  readonly sources: GroundedRecallSources;
  readonly options: GroundedRecallOptions;
  readonly runtime: GroundedRecallRuntime;
}

export interface GroundedRecallResult {
  /** The citation-enforced answer (fabricated sources already removed by code). */
  readonly answer: string;
  /** Embedder-aware retrieval confidence over the pre-gap-cut distribution. */
  readonly verdict: "confident" | "ambiguous" | "none";
  /** Sources the surviving answer actually cites (relative note paths). */
  readonly citations: readonly string[];
  /** Fabricated citations the gate stripped — non-empty means the model invented a source. */
  readonly strippedCitations: readonly string[];
  /** "from your note of …" receipt block, when the answer cited something. */
  readonly receipts?: string;
  /** True when the answer is an honest abstention (carries no citation by construction). */
  readonly refusal: boolean;
  /** True when the embedding endpoint failed and the corpus contributed nothing. */
  readonly notesUnavailable: boolean;
  /** How many corpus chunks were in the prompt window (grounding breadth signal). */
  readonly groundedChunkCount: number;
}

/**
 * Resolve the corpus + the embed model together: an explicit `embedModel` must
 * match the index (a cross-model cosine is meaningless — mismatch ⇒ empty
 * corpus); omitted, the index's own model is used.
 */
async function resolveIndexForModel(
  indexFile: string,
  requestedEmbedModel: string | undefined
): Promise<{ readonly files: ReindexSummary["index"]["files"]; readonly embedModel: string | undefined }> {
  const index = await loadIndex(indexFile);
  if (!index) {
    return { embedModel: requestedEmbedModel, files: [] };
  }
  const embedModel = requestedEmbedModel ?? index.model;
  return { embedModel, files: index.model === embedModel ? index.files : [] };
}

function buildSystemPrompt(args: {
  readonly framing: { readonly header: string; readonly guidance?: string };
  readonly contextBlock: string;
}): string {
  return [
    "You are Muse, the user's personal AI. Answer the user's question ONLY from the context below.",
    ...CITATION_INSTRUCTION_LINES,
    ...(args.framing.guidance ? [args.framing.guidance] : []),
    "",
    args.framing.header,
    args.contextBlock
  ].join("\n");
}

export async function runGroundedRecall(input: GroundedRecallInput): Promise<GroundedRecallResult> {
  const { query, sources, options, runtime } = input;
  const topK = options.topK ?? 6;

  const { embedModel, files: indexFiles } = await resolveIndexForModel(sources.notesIndexFile, options.embedModel);
  const retrieval = await retrieveAndRankNotes({
    embedFn: runtime.embedFn,
    embedModel: embedModel ?? "",
    indexFiles,
    json: true,
    notesDir: sources.notesDir,
    onStderr: () => {},
    query,
    scope: options.scope,
    topK
  });

  const framing = notesGroundingFraming(retrieval.scored, query, retrieval.preGapScored, embedModel);
  const contradictions = await detectEvidenceContradictions(
    retrieval.scored.map((s: ScoredChunk) => ({ cosine: s.score, score: s.score, source: s.file, text: s.chunk.text })),
    (text) => runtime.embedFn(text, embedModel ?? "")
  ).catch(() => [] as const);
  const contextBlock = buildNoteContextBlock(retrieval.scored, contradictions, sources.notesDir);

  const raw = await runtime.generateAnswer({
    model: options.answerModel,
    system: buildSystemPrompt({ contextBlock, framing }),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    user: query
  });

  const allowedNotes = [...new Set(retrieval.scored.map((s) => relativizeNoteSource(s.file, sources.notesDir)))];
  const enforced = enforceAnswerCitations(stripEchoedCiteAs(raw), { notes: allowedNotes });
  let answer = enforced.text.trim();
  const strippedCitations = [...enforced.stripped];

  // An honest abstention must not carry a citation — a model that says
  // "I'm not sure [from x.md]" is laundering confidence it doesn't have.
  const refusal = answerIsRefusal(answer);
  if (refusal && citedSourcesIn(answer).length > 0) {
    const strippedRefusal = enforceAnswerCitations(answer, { notes: [] });
    strippedCitations.push(...strippedRefusal.stripped);
    answer = strippedRefusal.text.trim();
  }

  const citations = [...new Set(citedSourcesIn(answer))];
  const receipts = formatSourceReceipts(
    answer,
    sources.notesDir,
    retrieval.scored.map((s) => ({ file: relativizeNoteSource(s.file, sources.notesDir), text: s.chunk.text })),
    query
  );

  return {
    answer,
    citations,
    groundedChunkCount: retrieval.scored.length,
    notesUnavailable: retrieval.notesUnavailable,
    ...(receipts !== undefined ? { receipts } : {}),
    refusal,
    strippedCitations,
    verdict: framing.verdict
  };
}
