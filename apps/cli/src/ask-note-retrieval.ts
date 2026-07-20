/**
 * CLI binding of `@muse/recall`'s notes retrieval stage — embeds through the
 * CLI's models.json-merged endpoint (the package default is env-only), and
 * optionally binds a local-LLM listwise reranker when MUSE_RECALL_RERANK
 * names an Ollama model (e.g. qwen3:8b). Measured 2026-07-15: cosine top-1
 * 3/8 on lexical-distractor queries vs 8/8 reranked, ~200ms warm on qwen3:8b.
 */

import {
  detectStaleMarker,
  retrieveAndRankNotes as retrieveAndRankNotesCore,
  type NoteRetrievalResult,
  type RecallRerankExecution,
  type RecallRerankFn,
  type RecallRerankPairHint
} from "@muse/recall";

import { resolveDefaultModel } from "@muse/autoconfigure";

import { embed } from "./embed.js";
import { resolveOllamaUrl } from "./ollama-url.js";

export type { NoteRetrievalResult } from "@muse/recall";

type CoreParams = Parameters<typeof retrieveAndRankNotesCore>[0];
const PRODUCTION_RERANK_TIMEOUT_MS = 4000;

export interface RecallRerankOptions {
  /** Request timeout; bounded by the unchanged 4,000ms production ceiling. */
  readonly timeoutMs?: number;
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
export function parseCorrectionPairReply(reply: string, candidateCount: number): ParsedCorrectionPairReply | undefined {
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
  model: string,
  timeoutMs: number
): Promise<RecallRerankExecution> {
  const base = resolveOllamaUrl(process.env).replace(/\/+$/u, "");
  const firstStaleIndex = candidateTexts.findIndex((text) => detectStaleMarker(text));
  const currentCount = firstStaleIndex === -1 ? candidateTexts.length : firstStaleIndex;
  const currentList = candidateTexts
    .slice(0, currentCount)
    .map((text, index) => `[${(index + 1).toString()}] ${text}`)
    .join("\n");
  const staleList = candidateTexts
    .slice(currentCount)
    .map((text, index) => `[${(currentCount + index + 1).toString()}] ${text}`)
    .join("\n");
  const staleRange = currentCount < candidateTexts.length
    ? `${(currentCount + 1).toString()}-${candidateTexts.length.toString()}`
    : "none";
  const pairShape = currentCount > 0 && currentCount < candidateTexts.length
    ? `Return ONLY one exact JSON shape: {"pair":null} or {"pair":{"current":1,"stale":${(currentCount + 1).toString()}}}. No prose and no other keys.`
    : "Return ONLY the exact JSON shape {\"pair\":null}. No prose and no other keys.";
  const prompt = [
    "Choose the pair that most directly answers the query. Select at most one correction pair only when two documents state the same fact.",
    "질문에 가장 직접 답하는 같은 사실의 최신/과거 문서 한 쌍만 선택하세요.",
    "Ignore correction pairs about any other topic.",
    "For a valid pair, stale must contain an explicit old or superseded marker; current must not.",
    `The current index MUST be in 1-${currentCount.toString()}; the stale index MUST be in ${staleRange}.`,
    "If uncertain, same-index, or either field would be null, return exactly {\"pair\":null}.",
    pairShape,
    `Query / 질문: ${query}`,
    `CURRENT / NON-STALE CANDIDATES (allowed current indices: 1-${currentCount.toString()})\n${currentList}`,
    currentCount < candidateTexts.length
      ? `EXPLICIT-STALE CANDIDATES (allowed stale indices: ${staleRange})\n${staleList}`
      : "EXPLICIT-STALE CANDIDATES (allowed stale indices: none)\nNo explicit-stale candidate is available; return exactly {\"pair\":null}.",
    "Choose the pair that most directly answers the query; otherwise return exactly {\"pair\":null}."
  ].join("\n\n");
  try {
    const res = await fetch(`${base}/api/generate`, {
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
    const parsed = parseCorrectionPairReply(response, candidateTexts.length);
    const identityOrder = candidateTexts.map((_text, index) => index);
    return parsed
      ? { httpAttempts: 1, order: identityOrder, outcome: "success", ...(parsed.pair ? { pairHints: [parsed.pair] } : {}) }
      : { httpAttempts: 1, outcome: "invalid" };
  } catch (cause) {
    const name = typeof cause === "object" && cause !== null && "name" in cause ? cause.name : undefined;
    return { httpAttempts: 1, outcome: name === "AbortError" || name === "TimeoutError" ? "timeout" : "error" };
  }
}

/** Select one local-only reranker function for the entire ask turn. */
export function createRecallRerankFn(env: NodeJS.ProcessEnv = process.env, options: RecallRerankOptions = {}): RecallRerankFn | undefined {
  const rerankModel = resolveRerankModel(env);
  const timeoutMs = options.timeoutMs ?? PRODUCTION_RERANK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PRODUCTION_RERANK_TIMEOUT_MS) return undefined;
  return rerankModel
    ? Object.assign(
        (query: string, texts: readonly string[]) => ollamaRerank(query, texts, rerankModel, timeoutMs),
        { mode: "correction-pair" as const }
      )
    : undefined;
}

/**
 * Constructs and explicitly warms the reranker. Callers choose when to invoke
 * this seam, typically only after their embedder preflight/model switch has
 * completed; normal command construction never issues a warmup request.
 */
export async function createWarmedRecallRerankFn(
  env: NodeJS.ProcessEnv,
  warmup: RecallRerankWarmup,
  options: RecallRerankOptions = {}
): Promise<WarmedRecallReranker | undefined> {
  const rerankFn = createRecallRerankFn(env, options);
  if (!rerankFn) return undefined;
  const response = await rerankFn(warmup.query, warmup.candidateTexts);
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
  params: Omit<CoreParams, "embedFn">
): Promise<NoteRetrievalResult> {
  const selectedRerankFn = Object.hasOwn(params, "rerankFn") ? params.rerankFn : createRecallRerankFn();
  return retrieveAndRankNotesCore({
    ...params,
    conflictAwareSelection: params.conflictAwareSelection !== false,
    embedFn: embed,
    ...(selectedRerankFn ? { rerankFn: selectedRerankFn } : {})
  });
}
