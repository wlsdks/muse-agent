/**
 * CLI binding of `@muse/recall`'s notes retrieval stage — embeds through the
 * CLI's models.json-merged endpoint (the package default is env-only), and
 * optionally binds a local-LLM listwise reranker when MUSE_RECALL_RERANK
 * names an Ollama model (e.g. qwen3:8b). Eligible correction-aware retrieval
 * defers one bounded empty preload until explicit temporal-edge activation is
 * known to be inert, then keeps the selector's independent 4-second ceiling.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import {
  detectStaleMarker,
  filterNotesByScope,
  retrieveAndRankNotes as retrieveAndRankNotesCore,
  type NoteRetrievalResult,
  type RecallRerankContext,
  type RecallRerankExecution,
  type RecallRerankFn,
  type RecallRerankPairHint,
  type TemporalClaimContextV1,
  type TemporalClaimSnapshotAuthorityV1
} from "@muse/recall";

import { resolveDefaultModel } from "@muse/autoconfigure";

import { embed } from "./embed.js";
import { resolveOllamaUrl } from "./ollama-url.js";
import { auditNoteRelationsStore, temporalClaimGraphFromAuditV1 } from "./note-relations-audit.js";
import { resolveNoteRelationsPathSnapshot } from "./note-relations-store.js";

export type { NoteRetrievalResult } from "@muse/recall";

type CoreParams = Parameters<typeof retrieveAndRankNotesCore>[0];
type CliRetrievalParams = Omit<CoreParams, "embedFn" | "env">;
const PRODUCTION_RERANK_TIMEOUT_MS = 4000;
const PRODUCTION_RERANK_PRELOAD_TIMEOUT_MS = 30_000;
const PRODUCTION_RERANK_KEEP_ALIVE = "5m";

type FetchFn = typeof globalThis.fetch;

export interface RecallRetrievalRuntime {
  /** Authoritative environment snapshot for URL/model resolution. */
  readonly env?: NodeJS.ProcessEnv;
  /** One transport seam shared by preload, selector, and embeddings. */
  readonly fetchFn?: FetchFn;
}

export interface RecallRerankOptions {
  /** Request timeout; bounded by the unchanged 4,000ms production ceiling. */
  readonly timeoutMs?: number;
  /** Injectable transport used by audited evaluation runners. */
  readonly fetchFn?: FetchFn;
}

export interface RecallRerankWarmup {
  readonly candidateTexts: readonly [string, ...string[]];
  readonly query: string;
}

export interface WarmedRecallReranker {
  readonly rerankFn: RecallRerankFn;
  readonly warmup: RecallRerankExecution;
}

/**
 * The Ollama model reranking runs on. DEFAULT ON for local-model users:
 * with MUSE_RECALL_RERANK unset (or "true"), the ask's own local default
 * model reranks — it is about to be loaded for the answer anyway, so the
 * cost is ~350-600ms warm and zero extra memory (pass^3-verified 8/8 on
 * the distractor golden set, 2026-07-15). A cloud default model disables
 * reranking (the reranker only speaks local Ollama — never egress).
 * MUSE_RECALL_RERANK=false opts out; a model name overrides the choice.
 */
export function resolveRerankModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.MUSE_RECALL_RERANK ?? "").trim();
  if (raw === "false" || raw === "0") {
    return undefined;
  }
  if (raw.length > 0 && raw !== "true") {
    return raw;
  }
  const defaultModel = resolveDefaultModel(env);
  return defaultModel?.startsWith("ollama/") ? defaultModel.slice("ollama/".length) : undefined;
}

export interface ParsedPairAwareRerankReply {
  readonly order: readonly number[];
  readonly pairHints?: readonly RecallRerankPairHint[];
}

export interface ParsedCorrectionPairReply {
  readonly pair: RecallRerankPairHint | null;
}

/** Parses the correction selector's exact single-pair/null closed response. */
export function parseCorrectionPairReply(
  reply: string,
  candidateCount: number,
  allowedCorrectionPairs?: readonly RecallRerankPairHint[]
): ParsedCorrectionPairReply | undefined {
  if (!Number.isSafeInteger(candidateCount) || candidateCount <= 0) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(reply.trim()); }
  catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !("pair" in parsed)) return undefined;
  if (parsed.pair === null) return { pair: null };
  if (typeof parsed.pair !== "object" || Array.isArray(parsed.pair)) return undefined;
  const keys = Object.keys(parsed.pair).sort();
  if (keys.length !== 2 || keys[0] !== "current" || keys[1] !== "stale") return undefined;
  const raw = parsed.pair as { readonly current?: unknown; readonly stale?: unknown };
  if (!Number.isSafeInteger(raw.current) || !Number.isSafeInteger(raw.stale)) return undefined;
  const current = (raw.current as number) - 1;
  const stale = (raw.stale as number) - 1;
  if (current < 0 || stale < 0 || current >= candidateCount || stale >= candidateCount || current === stale) return undefined;
  if (
    allowedCorrectionPairs
    && !allowedCorrectionPairs.some((pair) => pair.current === current && pair.stale === stale)
  ) return undefined;
  return { pair: { current, stale } };
}

/** Parses a structured ranking with optional closed correction-pair hints; legacy numeric replies remain ranking-only. */
export function parsePairAwareRerankReply(reply: string, candidateCount: number): ParsedPairAwareRerankReply | undefined {
  if (!Number.isSafeInteger(candidateCount) || candidateCount <= 0) return undefined;
  const trimmed = reply.trim();
  if (!trimmed) return undefined;
  let values: unknown;
  let pairs: unknown;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      values = parsed;
    } else if (typeof parsed === "object" && parsed !== null) {
      const keys = Object.keys(parsed);
      if (!keys.includes("ranking") || keys.some((key) => key !== "ranking" && key !== "pairs")) return undefined;
      values = "ranking" in parsed ? parsed.ranking : undefined;
      pairs = "pairs" in parsed ? parsed.pairs : undefined;
    }
  } catch {
    if (!/^\d+(?:\s*,\s*\d+)*$/u.test(trimmed)) return undefined;
    values = trimmed.split(",").map((value) => Number(value.trim()));
  }
  if (!Array.isArray(values)) return undefined;
  const order = [...new Set(values
    .filter((value): value is number => Number.isSafeInteger(value))
    .map((value) => value - 1)
    .filter((value) => value >= 0 && value < candidateCount))];
  if (order.length === 0) return undefined;
  const seenPairs = new Set<string>();
  const pairHints = Array.isArray(pairs) ? pairs.flatMap((pair): RecallRerankPairHint[] => {
    if (typeof pair !== "object" || pair === null || Array.isArray(pair)) return [];
    const keys = Object.keys(pair).sort();
    if (keys.length !== 2 || keys[0] !== "current" || keys[1] !== "stale") return [];
    const raw = pair as { readonly current?: unknown; readonly stale?: unknown };
    if (!Number.isSafeInteger(raw.current) || !Number.isSafeInteger(raw.stale)) return [];
    const current = (raw.current as number) - 1;
    const stale = (raw.stale as number) - 1;
    if (current < 0 || stale < 0 || current >= candidateCount || stale >= candidateCount || current === stale) return [];
    const key = `${current.toString()}:${stale.toString()}`;
    if (seenPairs.has(key)) return [];
    seenPairs.add(key);
    return [{ current, stale }];
  }) : [];
  return pairHints.length > 0 ? { order, pairHints } : { order };
}

/** Backward-compatible ranking-only view used by older direct callers. */
export function parseRerankReply(reply: string, candidateCount: number): readonly number[] | undefined {
  return parsePairAwareRerankReply(reply, candidateCount)?.order;
}

async function ollamaRerank(
  query: string,
  candidateTexts: readonly string[],
  context: RecallRerankContext | undefined,
  model: string,
  timeoutMs: number,
  base: string,
  fetchFn: FetchFn
): Promise<RecallRerankExecution> {
  const firstStaleIndex = candidateTexts.findIndex((text) => detectStaleMarker(text));
  const currentCount = firstStaleIndex === -1 ? candidateTexts.length : firstStaleIndex;
  const allowedCorrectionPairs = normalizeAllowedCorrectionPairs(context, candidateTexts, currentCount);
  if (!allowedCorrectionPairs) return { httpAttempts: 0, outcome: "invalid" };
  const oneBasedAllowedPairs = allowedCorrectionPairs.map((pair) => ({ current: pair.current + 1, stale: pair.stale + 1 }));
  const pairCards = allowedCorrectionPairs.map((pair, index) => [
    `PAIR CARD ${(index + 1).toString()}`,
    `exact tuple: ${JSON.stringify(oneBasedAllowedPairs[index])}`,
    `current text [${(pair.current + 1).toString()}]: ${candidateTexts[pair.current]}`,
    `stale text [${(pair.stale + 1).toString()}]: ${candidateTexts[pair.stale]}`
  ].join("\n")).join("\n\n");
  const pairShape = oneBasedAllowedPairs.length > 0
    ? "Return ONLY one JSON object. Its pair must be null or an object with exactly the integer keys current and stale. When non-null, those integers must exactly equal one tuple from the allowed list. No prose and no other keys."
    : "Return ONLY the exact JSON shape {\"pair\":null}. No prose and no other keys.";
  const prompt = [
    "Choose the pair that most directly answers the query. Select at most one correction pair only when two documents state the same fact.",
    "질문에 가장 직접 답하는 같은 사실의 최신/과거 문서 한 쌍만 선택하세요.",
    "Ignore correction pairs about any other topic.",
    "For a valid pair, stale must contain an explicit old or superseded marker; current must not.",
    "Each card is one complete allowed proposal. Compare cards as units; never combine the current text from one card with the stale text from another.",
    "Any pair not exactly shown as a card tuple is invalid; return {\"pair\":null}.",
    "If uncertain, same-index, or either field would be null, return exactly {\"pair\":null}.",
    pairShape,
    `Query / 질문: ${query}`,
    pairCards || "NO ALLOWED PAIR CARDS. Return exactly {\"pair\":null}.",
    "Choose the pair that most directly answers the query; otherwise return exactly {\"pair\":null}."
  ].join("\n\n");
  try {
    const res = await fetchFn(`${base}/api/generate`, {
      body: JSON.stringify({ format: "json", model, options: { num_predict: 64, temperature: 0 }, prompt, stream: false, think: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      return { httpAttempts: 1, outcome: "error" };
    }
    let response: string;
    try {
      const json = await res.json() as { readonly response?: unknown };
      response = typeof json.response === "string" ? json.response : "";
    } catch {
      return { httpAttempts: 1, outcome: "invalid" };
    }
    if (!response.trim()) return { httpAttempts: 1, outcome: "empty" };
    const parsed = parseCorrectionPairReply(response, candidateTexts.length, allowedCorrectionPairs);
    const identityOrder = candidateTexts.map((_text, index) => index);
    return parsed
      ? { httpAttempts: 1, order: identityOrder, outcome: "success", ...(parsed.pair ? { pairHints: [parsed.pair] } : {}) }
      : { httpAttempts: 1, outcome: "invalid" };
  } catch (cause) {
    const name = typeof cause === "object" && cause !== null && "name" in cause ? cause.name : undefined;
    return { httpAttempts: 1, outcome: name === "AbortError" || name === "TimeoutError" ? "timeout" : "error" };
  }
}

function normalizeAllowedCorrectionPairs(
  context: RecallRerankContext | undefined,
  candidateTexts: readonly string[],
  currentCount: number
): readonly RecallRerankPairHint[] | undefined {
  const pairs = context?.allowedCorrectionPairs ?? [];
  if (!Array.isArray(pairs) || pairs.length > 6) return undefined;
  const seen = new Set<string>();
  const normalized: RecallRerankPairHint[] = [];
  for (const pair of pairs) {
    if (typeof pair !== "object" || pair === null || Array.isArray(pair)) return undefined;
    const keys = Object.keys(pair).sort();
    if (keys.length !== 2 || keys[0] !== "current" || keys[1] !== "stale") return undefined;
    if (
      !Number.isSafeInteger(pair.current)
      || !Number.isSafeInteger(pair.stale)
      || pair.current < 0
      || pair.stale < 0
      || pair.current >= currentCount
      || pair.stale < currentCount
      || pair.stale >= candidateTexts.length
      || detectStaleMarker(candidateTexts[pair.current] ?? "")
      || !detectStaleMarker(candidateTexts[pair.stale] ?? "")
    ) return undefined;
    const key = `${pair.current.toString()}:${pair.stale.toString()}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    normalized.push({ current: pair.current, stale: pair.stale });
  }
  return normalized.sort((left, right) => left.current - right.current || left.stale - right.stale);
}

interface RecallRerankBinding {
  readonly base: string;
  readonly fetchFn: FetchFn;
  readonly model: string;
  readonly rerankFn: RecallRerankFn;
}

function defaultFetch(input: string | URL | Request, init?: RequestInit): ReturnType<FetchFn> {
  return globalThis.fetch(input, init);
}

function createRecallRerankBinding(env: NodeJS.ProcessEnv, options: RecallRerankOptions): RecallRerankBinding | undefined {
  const rerankModel = resolveRerankModel(env);
  const timeoutMs = options.timeoutMs ?? PRODUCTION_RERANK_TIMEOUT_MS;
  if (!rerankModel || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PRODUCTION_RERANK_TIMEOUT_MS) return undefined;
  const base = resolveOllamaUrl(env).replace(/\/+$/u, "");
  const fetchFn = options.fetchFn ?? defaultFetch;
  const rerankFn = Object.assign(
    (query: string, texts: readonly string[], context?: RecallRerankContext) =>
      ollamaRerank(query, texts, context, rerankModel, timeoutMs, base, fetchFn),
    { mode: "correction-pair" as const }
  );
  return { base, fetchFn, model: rerankModel, rerankFn };
}

async function preloadRecallRerankBinding(binding: RecallRerankBinding): Promise<boolean> {
  try {
    const response = await binding.fetchFn(`${binding.base}/api/generate`, {
      body: JSON.stringify({ keep_alive: PRODUCTION_RERANK_KEEP_ALIVE, model: binding.model, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(PRODUCTION_RERANK_PRELOAD_TIMEOUT_MS)
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return typeof body === "object"
      && body !== null
      && !Array.isArray(body)
      && "done" in body
      && body.done === true
      && "done_reason" in body
      && body.done_reason === "load"
      && "model" in body
      && body.model === binding.model
      && "response" in body
      && body.response === "";
  } catch {
    return false;
  }
}

function isRecallRerankPreloadEligible(params: CliRetrievalParams): boolean {
  if (params.conflictAwareSelection === false) return false;
  const liveFiles = params.indexFiles.filter((file) => existsSync(file.path));
  const eligibleFiles = params.scope
    ? filterNotesByScope(liveFiles, params.notesDir, params.scope)
    : liveFiles;
  const texts = eligibleFiles.flatMap((file) => file.chunks.map((chunk) => chunk.text));
  return texts.length > params.topK
    && texts.some((text) => detectStaleMarker(text))
    && texts.some((text) => !detectStaleMarker(text));
}

/** Select one local-only reranker function for the entire ask turn. */
export function createRecallRerankFn(env: NodeJS.ProcessEnv = process.env, options: RecallRerankOptions = {}): RecallRerankFn | undefined {
  const envSnapshot = Object.freeze({ ...env });
  return createRecallRerankBinding(envSnapshot, options)?.rerankFn;
}

/**
 * Legacy diagnostic seam that invokes the selector itself with supplied text.
 * Production ask retrieval uses the private empty preload above so no query or
 * candidate content is sent during model loading.
 */
export async function createWarmedRecallRerankFn(
  env: NodeJS.ProcessEnv,
  warmup: RecallRerankWarmup,
  options: RecallRerankOptions = {}
): Promise<WarmedRecallReranker | undefined> {
  const rerankFn = createRecallRerankFn(env, options);
  if (!rerankFn) return undefined;
  const response = await rerankFn(warmup.query, warmup.candidateTexts, { allowedCorrectionPairs: [] });
  const execution: RecallRerankExecution = typeof response === "object"
    && response !== null
    && !Array.isArray(response)
    && "outcome" in response
    ? response as RecallRerankExecution
    : Array.isArray(response) && response.length > 0
      ? { httpAttempts: 0, order: response, outcome: "success" }
      : { httpAttempts: 0, outcome: "empty" };
  return { rerankFn, warmup: execution };
}

export async function retrieveAndRankNotes(
  params: CliRetrievalParams,
  runtime: RecallRetrievalRuntime = {}
): Promise<NoteRetrievalResult> {
  const envSnapshot = Object.freeze({ ...(runtime.env ?? process.env) });
  const fetchFn = runtime.fetchFn ?? defaultFetch;
  let temporalClaimGraph = (params as CoreParams).temporalClaimGraph;
  let temporalClaimAuthority = (params as CoreParams & { readonly temporalClaimAuthority?: TemporalClaimSnapshotAuthorityV1 }).temporalClaimAuthority;
  if (!Object.hasOwn(params, "temporalClaimGraph")) {
    const context = await captureTemporalClaimContext(envSnapshot);
    temporalClaimGraph = context.graph;
    temporalClaimAuthority = context.authority;
  }
  const hasExplicitRerankFn = Object.hasOwn(params, "rerankFn");
  const binding = hasExplicitRerankFn ? undefined : createRecallRerankBinding(envSnapshot, { fetchFn });
  const selectedRerankFn = hasExplicitRerankFn ? params.rerankFn : undefined;
  const prepareRerankFn = binding && isRecallRerankPreloadEligible(params)
    ? async () => await preloadRecallRerankBinding(binding) ? binding.rerankFn : undefined
    : undefined;
  return retrieveAndRankNotesCore({
    ...params,
    conflictAwareSelection: params.conflictAwareSelection !== false,
    embedFn: (text, model) => embed(text, model, { fetchImpl: fetchFn }, envSnapshot),
    env: envSnapshot,
    ...(temporalClaimGraph ? { temporalClaimGraph } : {}),
    ...(temporalClaimAuthority ? { temporalClaimAuthority } : {}),
    ...(selectedRerankFn ? { rerankFn: selectedRerankFn } : {}),
    ...(prepareRerankFn ? { prepareRerankFn } : {})
  } as CoreParams);
}

/** Capture a complete fail-closed authority even when the local store cannot be audited. */
export async function captureTemporalClaimContext(
  env: NodeJS.ProcessEnv = process.env
): Promise<TemporalClaimContextV1> {
  try {
    const audit = await auditNoteRelationsStore(resolveNoteRelationsPathSnapshot(Object.freeze({ ...env })));
    const graph = temporalClaimGraphFromAuditV1(audit);
    const sourceProvenanceDigest = graph
      ? createHash("sha256").update(JSON.stringify(graph.relations.map(({ current, stale }) => ({ current, stale })))).digest("hex")
      : null;
    const authority = Object.freeze({
      chunkerVersion: "muse.notes.chunk-text.v1",
      graphDigest: audit.semanticDigest,
      indexDigest: audit.indexRawDigest,
      rawStoreDigest: audit.rawDigest,
      schema: "muse.temporal-claim-snapshot-authority.v1",
      sourceProvenanceDigest,
      storeRevision: audit.revision,
      storeState: audit.state
    } satisfies TemporalClaimSnapshotAuthorityV1);
    return Object.freeze({ authority, ...(graph ? { graph } : {}) });
  } catch {
    return Object.freeze({
      authority: Object.freeze({
        chunkerVersion: "muse.notes.chunk-text.v1",
        graphDigest: null,
        indexDigest: null,
        rawStoreDigest: null,
        schema: "muse.temporal-claim-snapshot-authority.v1",
        sourceProvenanceDigest: null,
        storeRevision: 0,
        storeState: "unavailable"
      })
    });
  }
}
