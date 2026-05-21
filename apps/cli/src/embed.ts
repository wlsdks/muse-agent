/**
 * Goal 090 — shared embedding helper. Both `commands-notes-rag.ts`
 * and the new episode-index pipeline (goal 090) + cross-store
 * recall (goal 091) hit the same Ollama `/api/embeddings` endpoint
 * with the same body shape; one source of truth.
 *
 * No new dep — wraps Node's global `fetch`. `resolveOllamaUrl`
 * stays the single env-aware base-URL resolver.
 */

import { resolveOllamaUrl } from "./ollama-url.js";

export const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

export interface EmbedOptions {
  /** Override fetch impl in tests; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Override the resolver in tests; defaults to `resolveOllamaUrl()`. */
  readonly baseUrlResolver?: () => string;
  /**
   * Hard wall-clock cap on the embeddings POST. Ollama's cold-model
   * load can wedge a request for minutes; without this every RAG
   * caller (`muse ask`, `muse notes reindex`, `muse recall`, the
   * episode-index pipeline) hangs the CLI indefinitely. Default 30s,
   * same posture goal 636 set for the RSS feed loader. Non-finite
   * / non-positive values fall back to the default.
   */
  readonly timeoutMs?: number;
}

export async function embed(text: string, model: string, options: EmbedOptions = {}): Promise<number[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = (options.baseUrlResolver ?? resolveOllamaUrl)();
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? (options.timeoutMs as number)
    : DEFAULT_EMBED_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(`${baseUrl}/api/embeddings`, {
      body: JSON.stringify({ model, prompt: text }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: controller.signal
    });
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new Error(`embeddings ${baseUrl}/api/embeddings timed out after ${timeoutMs.toString()}ms`, { cause });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    throw new Error(`embeddings ${resp.status.toString()}: ${await resp.text().catch(() => "")}`);
  }
  const body = await resp.json() as { embedding?: number[] };
  // An empty or non-finite vector (wrong model, empty prompt on
  // some backends) silently makes cosineSimilarity return 0/NaN
  // for every hit — garbage RAG ranking with no error. Reject it.
  if (!Array.isArray(body.embedding)
    || body.embedding.length === 0
    || !body.embedding.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error("embedding response missing a valid numeric 'embedding' vector");
  }
  return body.embedding;
}

/**
 * Pure cosine similarity over two equal-length number arrays.
 * Returns 0 on length mismatch / zero-norm vectors instead of
 * throwing so a callsite can rank a list without per-pair
 * exception handling. Exported so goal 091 reuses the same
 * implementation the notes-RAG path already trusts.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  const result = dot / Math.sqrt(na * nb);
  return Number.isFinite(result) ? result : 0;
}
