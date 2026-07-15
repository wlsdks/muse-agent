/**
 * CLI binding of `@muse/recall`'s notes retrieval stage — embeds through the
 * CLI's models.json-merged endpoint (the package default is env-only), and
 * optionally binds a local-LLM listwise reranker when MUSE_RECALL_RERANK
 * names an Ollama model (e.g. qwen3:8b). Measured 2026-07-15: cosine top-1
 * 3/8 on lexical-distractor queries vs 8/8 reranked, ~200ms warm on qwen3:8b.
 */

import {
  retrieveAndRankNotes as retrieveAndRankNotesCore,
  type NoteRetrievalResult
} from "@muse/recall";

import { resolveDefaultModel } from "@muse/autoconfigure";
import { isRecord } from "@muse/shared";

import { embed } from "./embed.js";
import { resolveOllamaUrl } from "./ollama-url.js";

export type { NoteRetrievalResult } from "@muse/recall";

type CoreParams = Parameters<typeof retrieveAndRankNotesCore>[0];

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

/** Extracts the best-first candidate indices from a reranker reply ("2, 4, 1" / "[2]" → zero-based). Undefined when no number survives. */
export function parseRerankReply(reply: string): readonly number[] | undefined {
  const nums = reply.match(/\d+/gu);
  if (!nums || nums.length === 0) {
    return undefined;
  }
  return nums.map((n) => Number(n) - 1);
}

async function ollamaRerank(query: string, candidateTexts: readonly string[], model: string): Promise<readonly number[] | undefined> {
  const base = resolveOllamaUrl(process.env).replace(/\/+$/u, "");
  const list = candidateTexts.map((text, i) => `[${(i + 1).toString()}] ${text}`).join("\n");
  const prompt = `Query: ${query}\n\nDocuments:\n${list}\n\nWhich documents best ANSWER the query (not just share words with it)? Reply with ONLY the numbers, comma-separated, best first.`;
  const res = await fetch(`${base}/api/generate`, {
    body: JSON.stringify({ model, options: { num_predict: 32, temperature: 0 }, prompt, stream: false, think: false }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(4000)
  });
  if (!res.ok) {
    return undefined;
  }
  const json = await res.json();
  if (!isRecord(json) || typeof json.response !== "string") {
    return undefined;
  }
  return parseRerankReply(json.response);
}

export async function retrieveAndRankNotes(
  params: Omit<CoreParams, "embedFn" | "rerankFn">
): Promise<NoteRetrievalResult> {
  const rerankModel = resolveRerankModel();
  return retrieveAndRankNotesCore({
    ...params,
    embedFn: embed,
    ...(rerankModel ? { rerankFn: (query: string, texts: readonly string[]) => ollamaRerank(query, texts, rerankModel) } : {})
  });
}
