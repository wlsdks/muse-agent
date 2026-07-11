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

import {
  citedSourcesIn,
  detectEvidenceContradictions,
  enforceAnswerCitations,
  reorderForLongContext,
  withUngroundableFallback,
  type AllowedCitations
} from "@muse/agent-core";
import { composeSurfacePrompt } from "@muse/prompts";

import { CITATION_INSTRUCTION_LINES } from "./ask-prompt-constants.js";
import { createCitationStreamFilter } from "./citation-stream.js";
import { retrieveAndRankNotes } from "./ask-note-retrieval.js";
import { dedupNearDuplicateChunks, notesGroundingFraming, type ScoredChunk } from "./chunks.js";
export type { ScoredChunk } from "./chunks.js";
import { demoteStale } from "./conflict.js";
import { cosine, loadIndex, type ReindexSummary } from "./notes-index.js";
import { buildNoteContextBlock } from "./context-blocks.js";
import { formatSourceReceipts, groundingSectionLines, relativizeNoteSource } from "./present.js";
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
  /**
   * Token-delta streaming, when the caller's provider supports it. Optional —
   * absent, `streamGroundedRecall` degrades to one gate-clean delta after the
   * buffered generation.
   */
  readonly streamAnswer?: (args: {
    readonly system: string;
    readonly user: string;
    readonly model: string;
    readonly temperature?: number;
  }) => AsyncIterable<string>;
}

/** One optional block appended after the notes block, mirroring the CLI's
 *  `optionalGroundingSections` idiom (header/body/footer + a presence flag so a
 *  caller can pass an always-shaped section and let it drop out when empty). */
export interface GroundedRecallExtraSection {
  readonly header: string;
  readonly body: string;
  readonly footer: string;
  readonly present: boolean;
}

export interface GroundedRecallExtras {
  /**
   * Extra context sections (tasks/calendar/memory/…), rendered after the notes
   * block in the exact order given. A section is dropped when `present` is
   * false or `body` is blank — same rule `optionalGroundingSections` applies —
   * so a caller can always pass its full fixed set without a header ever
   * appearing over empty content.
   */
  readonly contextSections?: readonly GroundedRecallExtraSection[];
  /**
   * Merged into the citation gate alongside `{ notes: [...] }`. Fail-close by
   * construction: a category NOT listed here (or a source not in its list)
   * still resolves to `enforceAnswerCitations`'s own `?? []` default and is
   * stripped exactly like a fabricated note citation — declaring a category
   * is the only way a citation in it can survive.
   */
  readonly allowedCitations?: Omit<AllowedCitations, "notes">;
  /**
   * CLI-grade chunk refinement — dedup near-duplicates, "Lost in the Middle"
   * reorder, then a SECOND stale-demotion pass (the reorder re-sorts by raw
   * cosine and can put an explicitly-superseded chunk back ahead of its
   * current counterpart — see the comment on `refineChunks` in `prepareRecall`).
   * Off by default: an extras-free caller gets the exact prior chunk order.
   */
  readonly refineChunks?: boolean;
  /** Forwarded to `buildNoteContextBlock`'s conflict marker so a conflict
   *  against an externally-ingested note reads as untrusted, not neutral. */
  readonly untrustedNoteSources?: ReadonlySet<string>;
  /**
   * Extra note-class chunks folded into the retrieved set BEFORE dedup —
   * for a caller-side ad-hoc grounding source (a `--file`/`--url`/clipboard
   * passage) that must be cited exactly like a retrieved note, not rendered
   * as a separate labelled section. Absent/empty ⇒ byte-identical to today
   * (only the index's own retrieval feeds the notes block).
   */
  readonly extraChunks?: readonly ScoredChunk[];
  /**
   * Full override of the system-prompt string, given the SAME framing +
   * contextBlock + extraSections `composeDefaultRecallSystemPrompt` would
   * otherwise use — lets a caller with its own richer prompt shape (persona,
   * path-specific instructions, a stable-prefix ordering for KV-cache reuse)
   * reuse the seam's retrieval/dedup/context-block work without inheriting
   * this module's generic wording. Absent ⇒ the built-in
   * `composeDefaultRecallSystemPrompt`, which now composes through
   * `composeSurfacePrompt("recall", …)` (docs/strategy/prompt-architecture.md).
   */
  readonly composeSystemPrompt?: (args: {
    readonly framing: { readonly header: string; readonly guidance?: string };
    readonly contextBlock: string;
    readonly extraSections: readonly GroundedRecallExtraSection[];
  }) => string;
  /**
   * Applied to the raw answer AFTER `stripEchoedCiteAs` and BEFORE the
   * citation gate (in both the buffered result and the live stream's final
   * `result` event — never the per-delta live text, which stays gate-only so
   * a normalization pass never runs on a split-mid-token fragment). Lets a
   * caller fold its own pre-gate citation-shape rewrites (e.g. normalizing a
   * slot/contact/memory reference into the canonical bracket form the gate
   * validates) in ahead of the fabrication check. Absent ⇒ no-op (byte-identical).
   */
  readonly normalizeAnswer?: (text: string) => string;
}

export interface GroundedRecallInput {
  readonly query: string;
  readonly sources: GroundedRecallSources;
  readonly options: GroundedRecallOptions;
  readonly runtime: GroundedRecallRuntime;
  /** Absent or `{}` ⇒ byte-identical to the extras-free pipeline (the API and
   *  MCP callers pass none). See `GroundedRecallExtras`. */
  readonly extras?: GroundedRecallExtras;
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
  /**
   * The same stripped-citation set BEFORE the refusal pass runs (a refusal
   * strips again, unconditionally, over ALL categories). A caller that
   * surfaces "N citation(s) removed" as a warning on the FIRST pass only
   * (suppressing the message on a refusal, which asserts no claim) needs
   * this narrower count/list rather than the refusal-inclusive `strippedCitations`.
   */
  readonly preRefusalStrippedCitations: readonly string[];
  /** "from your note of …" receipt block, when the answer cited something. */
  readonly receipts?: string;
  /** True when the answer is an honest abstention (carries no citation by construction). */
  readonly refusal: boolean;
  /** True when the embedding endpoint failed and the corpus contributed nothing. */
  readonly notesUnavailable: boolean;
  /** How many corpus chunks were in the prompt window (grounding breadth signal). */
  readonly groundedChunkCount: number;
  /** The chunks actually in the prompt window — a caller that needs the raw
   *  file/text/score (receipts, a follow-up verdict pass, a grounded-source
   *  summary banner) doesn't have to re-retrieve. */
  readonly scored: readonly ScoredChunk[];
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

/**
 * The DEFAULT system-prompt composition (docs/strategy/prompt-architecture.md
 * Phase 2) — routed through the seam: identity-core + `SURFACE_ROLES.recall`
 * lead the stable prefix, then the stable citation contract
 * (`CITATION_INSTRUCTION_LINES`), then a single cache boundary, then the
 * per-turn retrieval framing/context/extra sections. `input.extras?.composeSystemPrompt`
 * (see its doc above) stays the override hook a caller can supply instead.
 */
function composeDefaultRecallSystemPrompt(args: {
  readonly framing: { readonly header: string; readonly guidance?: string };
  readonly contextBlock: string;
  readonly extraSections?: readonly GroundedRecallExtraSection[];
}): string {
  const extraLines = groundingSectionLines(
    (args.extraSections ?? []).map((section) => ({ ...section, present: section.present && section.body.trim().length > 0 }))
  );
  return composeSurfacePrompt("recall", {
    basePrompt: CITATION_INSTRUCTION_LINES.join("\n"),
    providerDynamicSuffix: [
      ...(args.framing.guidance ? [args.framing.guidance] : []),
      "",
      args.framing.header,
      args.contextBlock,
      ...extraLines
    ].join("\n")
  });
}

/**
 * The live event stream of `streamGroundedRecall`. `answer-delta` text has
 * already passed the LIVE citation filter — a fabricated `[from …]` never
 * reaches a display, not even for a flash (the buffered gate then remains the
 * authoritative pass on the full answer). The final event is always `result`.
 */
export type GroundedRecallEvent =
  | {
    readonly type: "retrieval";
    readonly groundedChunkCount: number;
    readonly verdict: "confident" | "ambiguous" | "none";
    readonly notesUnavailable: boolean;
    /** Same array `GroundedRecallResult.scored` carries — exposed here too so a
     *  streaming caller can render a pre-generation "grounded on …" summary
     *  before the model has produced a single token. */
    readonly scored: readonly ScoredChunk[];
  }
  | { readonly type: "answer-delta"; readonly text: string }
  | { readonly type: "result"; readonly result: GroundedRecallResult };

interface PreparedRecall {
  readonly systemPrompt: string;
  readonly allowedNotes: readonly string[];
  readonly scored: readonly ScoredChunk[];
  readonly verdict: "confident" | "ambiguous" | "none";
  readonly notesUnavailable: boolean;
}

/** Retrieval + context + prompt — everything before the model speaks. */
async function prepareRecall(input: GroundedRecallInput): Promise<PreparedRecall> {
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

  // Ad-hoc/caller-supplied chunks (a --file/--url/clipboard-style passage)
  // fold into the retrieved set BEFORE dedup, exactly like a real retrieval
  // hit — they must be cited as note-class evidence, not a separate section.
  // Absent/empty ⇒ `rawScored` is the exact `retrieval.scored` reference.
  const extraChunks = input.extras?.extraChunks ?? [];
  const rawScored = extraChunks.length > 0 ? [...retrieval.scored, ...extraChunks] : retrieval.scored;

  // Drop provable near-duplicates first (highest-ranked survives) before the
  // confidence framing reads the set — mirrors the CLI's `commands-ask.ts`
  // composition. Off by default so an extras-free caller's framing input is
  // the exact `retrieval.scored` it always was.
  const dedupedScored = input.extras?.refineChunks
    ? dedupNearDuplicateChunks(rawScored, cosine)
    : rawScored;
  const framing = notesGroundingFraming(dedupedScored, query, retrieval.preGapScored, embedModel);
  // `reorderForLongContext` re-sorts by raw cosine score, which would put a
  // higher-scoring but explicitly-superseded chunk back ahead of its current
  // counterpart — so the stale demotion `retrieveAndRankNotes` already applied
  // once must run again on the reorder's OUTPUT, not before it.
  const contextChunks = input.extras?.refineChunks
    ? demoteStale(reorderForLongContext(dedupedScored), (c) => c.chunk.text)
    : dedupedScored;
  const contradictions = await detectEvidenceContradictions(
    contextChunks.map((s: ScoredChunk) => ({ cosine: s.score, score: s.score, source: s.file, text: s.chunk.text })),
    (text) => runtime.embedFn(text, embedModel ?? "")
  ).catch(() => [] as const);
  const contextBlock = buildNoteContextBlock(contextChunks, contradictions, sources.notesDir, input.extras?.untrustedNoteSources);
  const extraSections = input.extras?.contextSections ?? [];

  return {
    allowedNotes: [...new Set(contextChunks.map((s) => relativizeNoteSource(s.file, sources.notesDir)))],
    // Ad-hoc chunks are note-class evidence found THIS turn — notes are no
    // longer "unavailable" once any (index retrieval OR ad-hoc) contributed.
    notesUnavailable: retrieval.notesUnavailable && extraChunks.length === 0,
    scored: contextChunks,
    systemPrompt: (input.extras?.composeSystemPrompt ?? composeDefaultRecallSystemPrompt)({ contextBlock, extraSections, framing }),
    verdict: framing.verdict
  };
}

/** The deterministic gates over the full raw answer — shared by both entry points. */
function finalizeRecall(raw: string, prepared: PreparedRecall, input: GroundedRecallInput): GroundedRecallResult {
  // Only a category the caller EXPLICITLY declared here can survive the gate —
  // an undeclared category falls back to `enforceAnswerCitations`'s own `?? []`,
  // so a citation in it is stripped exactly like a fabricated note citation.
  const allowedCitations: AllowedCitations = { notes: [...prepared.allowedNotes], ...input.extras?.allowedCitations };
  const stripped = stripEchoedCiteAs(raw);
  const normalized = input.extras?.normalizeAnswer ? input.extras.normalizeAnswer(stripped) : stripped;
  const enforced = enforceAnswerCitations(normalized, allowedCitations);
  // Every sentence can be dropped as un-groundable (the citation-gate clause-leak
  // fix) — an empty string there would read as a silent bug, not an honest
  // abstention, so surface the SAME fixed hedge every other refusal uses.
  let answer = withUngroundableFallback(enforced).trim();
  const preRefusalStrippedCitations = [...enforced.stripped];
  const strippedCitations = [...enforced.stripped];

  // An honest abstention must not carry a citation — a model that says
  // "I'm not sure [from x.md]" is laundering confidence it doesn't have.
  // Unconditional on refusal (not gated on `citedSourcesIn`, which only sees
  // `[from …]`-style note citations): an extra category — `[task: …]` etc —
  // must be stripped from a refusal exactly like a note citation would be.
  // A no-citation refusal round-trips through this unchanged (no-op).
  const refusal = answerIsRefusal(answer);
  if (refusal) {
    const strippedRefusal = enforceAnswerCitations(answer, { notes: [] });
    strippedCitations.push(...strippedRefusal.stripped);
    answer = withUngroundableFallback(strippedRefusal).trim();
  }

  const citations = [...new Set(citedSourcesIn(answer))];
  const receipts = formatSourceReceipts(
    answer,
    input.sources.notesDir,
    prepared.scored.map((s) => ({ file: relativizeNoteSource(s.file, input.sources.notesDir), text: s.chunk.text })),
    input.query
  );

  return {
    answer,
    citations,
    groundedChunkCount: prepared.scored.length,
    notesUnavailable: prepared.notesUnavailable,
    preRefusalStrippedCitations,
    ...(receipts !== undefined ? { receipts } : {}),
    refusal,
    scored: prepared.scored,
    strippedCitations,
    verdict: prepared.verdict
  };
}

/**
 * The streaming form of the seam. Deltas pass through the LIVE citation filter
 * (`createCitationStreamFilter` over the same `enforceAnswerCitations` set), so
 * a fabricated citation never flashes on a display; the buffered gate then runs
 * over the FULL answer and the final `result` event is the authoritative one
 * (identical to `runGroundedRecall`'s). Without `runtime.streamAnswer`, the
 * buffered generation is used and the single delta is the already-gated answer.
 */
export async function* streamGroundedRecall(input: GroundedRecallInput): AsyncGenerator<GroundedRecallEvent> {
  const prepared = await prepareRecall(input);
  yield {
    groundedChunkCount: prepared.scored.length,
    notesUnavailable: prepared.notesUnavailable,
    scored: prepared.scored,
    type: "retrieval",
    verdict: prepared.verdict
  };

  const generateArgs = {
    model: input.options.answerModel,
    system: prepared.systemPrompt,
    ...(input.options.temperature !== undefined ? { temperature: input.options.temperature } : {}),
    user: input.query
  };

  let raw = "";
  if (input.runtime.streamAnswer) {
    // Must accept the SAME categories the buffered gate in `finalizeRecall`
    // does — otherwise a valid extra-category citation would flash-strip live
    // and then reappear in the final `result`, breaking stream/buffered parity.
    const liveAllowedCitations: AllowedCitations = { notes: [...prepared.allowedNotes], ...input.extras?.allowedCitations };
    const filter = createCitationStreamFilter(
      (span) => enforceAnswerCitations(span, liveAllowedCitations).text
    );
    for await (const delta of input.runtime.streamAnswer(generateArgs)) {
      raw += delta;
      const safe = filter.push(delta);
      if (safe.length > 0) {
        yield { text: safe, type: "answer-delta" };
      }
    }
    const tail = filter.flush();
    if (tail.length > 0) {
      yield { text: tail, type: "answer-delta" };
    }
    const result = finalizeRecall(raw, prepared, input);
    yield { result, type: "result" };
    return;
  }

  raw = await input.runtime.generateAnswer(generateArgs);
  const result = finalizeRecall(raw, prepared, input);
  if (result.answer.length > 0) {
    yield { text: result.answer, type: "answer-delta" };
  }
  yield { result, type: "result" };
}

export async function runGroundedRecall(input: GroundedRecallInput): Promise<GroundedRecallResult> {
  // Single implementation: the buffered form consumes the stream and returns
  // its authoritative final event.
  let final: GroundedRecallResult | undefined;
  for await (const event of streamGroundedRecall(input)) {
    if (event.type === "result") {
      final = event.result;
    }
  }
  if (!final) {
    throw new Error("streamGroundedRecall ended without a result event");
  }
  return final;
}
