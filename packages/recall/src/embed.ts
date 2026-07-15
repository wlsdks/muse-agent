/**
 * Shared embedding helper. The notes-RAG path, the episode-index
 * pipeline, and cross-store recall all hit the same Ollama
 * `/api/embeddings` endpoint with the same body shape; one source
 * of truth.
 *
 * Wraps Node's global `fetch`. Surfaces that resolve the Ollama host beyond
 * the environment (the CLI merges `muse setup model`'s `~/.muse/models.json`
 * via its `resolveOllamaUrl`) MUST pass `baseUrlResolver`; the package default
 * is env-or-localhost only. A fail-closed `MUSE_LOCAL_ONLY` egress guard sits
 * on the POST so a REMOTE resolved host never receives personal text off-box.
 */

import { canonicalizeLocalOnlyModelBaseUrl, isLocalOnlyEnabled, LocalOnlyViolationError } from "@muse/model";
import { isRecord, withBestEffort } from "@muse/shared";

export { cosineSimilarity } from "@muse/agent-core";

export const DEFAULT_EMBED_TIMEOUT_MS = 30_000;

function resolveEmbedTransportBaseUrl(baseUrl: string, requireLocalOnly?: true): string {
  if (!isLocalOnlyEnabled(process.env) && requireLocalOnly !== true) {
    return baseUrl;
  }
  const canonical = canonicalizeLocalOnlyModelBaseUrl("ollama", baseUrl);
  if (!canonical) {
    throw new LocalOnlyViolationError("ollama", baseUrl);
  }
  return canonical;
}

/** Env-only fallback resolver — no credentials-file merge (that's the caller's seam). */
function envOllamaUrl(): string {
  const raw = process.env.OLLAMA_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : "http://127.0.0.1:11434";
  return base.replace(/\/+$/u, "");
}

export interface EmbedOptions {
  /** Override fetch impl in tests; defaults to `globalThis.fetch`. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Resolve the Ollama base URL; defaults to `OLLAMA_BASE_URL` or localhost. */
  readonly baseUrlResolver?: () => string;
  /**
   * One-way caller posture signal. `true` can add the local-only transport
   * wall; `false` is intentionally not representable and cannot weaken an
   * ambient local-only process.
   */
  readonly requireLocalOnly?: true;
  /**
   * Hard wall-clock cap on the embeddings POST. Ollama's cold-model
   * load can wedge a request for minutes; without this every RAG
   * caller (`muse ask`, `muse notes reindex`, `muse recall`, the
   * episode-index pipeline) hangs the CLI indefinitely. Default 30s,
   * same posture as the RSS feed loader. Non-finite / non-positive
   * values fall back to the default.
   */
  readonly timeoutMs?: number;
}

export async function embed(text: string, model: string, options: EmbedOptions = {}): Promise<number[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const baseUrl = resolveEmbedTransportBaseUrl((options.baseUrlResolver ?? envOllamaUrl)(), options.requireLocalOnly);
  const timeoutMsCandidate = options.timeoutMs ?? Number.NaN;
  const timeoutMs = Number.isFinite(timeoutMsCandidate) && timeoutMsCandidate > 0
    ? Math.trunc(timeoutMsCandidate)
    : DEFAULT_EMBED_TIMEOUT_MS;
  const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  let resp: Response;
  try {
    resp = await fetchImpl(`${baseUrl}/api/embeddings`, {
      body: JSON.stringify({ model, prompt: text }),
      headers: { "content-type": "application/json" },
      method: "POST",
      ...(timeoutSignal ? { signal: timeoutSignal } : {})
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new Error(`embeddings ${baseUrl}/api/embeddings timed out after ${timeoutMs.toString()}ms`, { cause });
    }
    throw cause;
  }
  if (!resp.ok) {
    throw new Error(`embeddings ${resp.status.toString()}: ${await withBestEffort(resp.text(), "")}`);
  }
  const body = await resp.json();
  // An empty or non-finite vector (wrong model, empty prompt on
  // some backends) silently makes cosineSimilarity return 0/NaN
  // for every hit — garbage RAG ranking with no error. Reject it.
  if (!hasValidEmbedding(body)) {
    throw new Error("embedding response missing a valid numeric 'embedding' vector");
  }
  return [...body.embedding];
}

type EmbeddingResponse = {
  readonly embedding: readonly number[];
};

function hasValidEmbedding(body: unknown): body is EmbeddingResponse {
  if (!isRecord(body)) {
    return false;
  }
  if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
    return false;
  }
  return body.embedding.every((value) => typeof value === "number" && Number.isFinite(value));
}
