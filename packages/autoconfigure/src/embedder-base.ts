/**
 * The local embedder's base URL + the embedder constructors that build on it.
 * This is the embedder's natural home: `resolveEmbedderBase` is the single
 * source of truth both the runtime fail-close guard (`createOllamaEmbedder`)
 * and the `muse doctor` local-only posture (`evaluateLocalOnlyPosture`) resolve
 * the base from — `OLLAMA_BASE_URL` (empty/whitespace treated as unset)
 * defaulting to loopback, trailing slashes stripped. They MUST agree, or doctor
 * would report a posture the runtime doesn't enforce; sharing one helper makes
 * that parity structural instead of two hand-kept string literals.
 */

import { createCachingEmbedder, normalizeForRecall } from "@muse/agent-core";
import { canonicalizeLocalOnlyModelBaseUrl, isLocalOnlyEnabled } from "@muse/model";

export function resolveEmbedderBase(env: Readonly<Record<string, string | undefined>>): string {
  return (env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/+$/u, "");
}

// Zero-cost local embedder: Ollama `/api/embeddings` (nomic-embed-text
// by default). Zero-dep (global fetch). Throwing here is fine — the
// StoreBacked provider treats a thrown embedder as fail-open and
// degrades that resolve to Jaccard, so recall never breaks if Ollama
// is down or the model isn't pulled.
export function createOllamaEmbedder(model: string): (text: string) => Promise<readonly number[]> {
  // Empty / whitespace OLLAMA_BASE_URL is treated as unset (loopback default);
  // shared with the doctor posture so the two never diverge (see resolveEmbedderBase).
  const configuredBase = resolveEmbedderBase(process.env);
  const base = isLocalOnlyEnabled(process.env)
    ? canonicalizeLocalOnlyModelBaseUrl("ollama", configuredBase)
    : configuredBase;
  if (!base) {
    throw new Error("local Ollama embedder requires an explicit base URL");
  }
  // Keep the embed model warm with the SAME knob as the chat model (01717219):
  // grounding embeds the query every turn, so an embed model that cold-reloads
  // after a 5-minute idle gap would stall the FIRST grounded answer after a
  // break — the always-on companion sets this to 2h via MuseBridge.
  const keepAlive = process.env.MUSE_OLLAMA_KEEP_ALIVE?.trim() || "30m";
  return async (text: string) => {
    // NFC-normalise the embed input too (sibling of the lexical tokeniser) so an NFD note
    // (macOS) and an NFC query embed from the SAME bytes — KO semantic recall stays consistent.
    const resp = await fetch(`${base}/api/embeddings`, {
      body: JSON.stringify({ model, prompt: normalizeForRecall(text), keep_alive: keepAlive }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    if (!resp.ok) {
      throw new Error(`embeddings ${resp.status.toString()}`);
    }
    const body = (await resp.json()) as { embedding?: unknown };
    if (!Array.isArray(body.embedding)) {
      throw new Error("embedding response missing 'embedding'");
    }
    return body.embedding as number[];
  };
}

/**
 * The single embedder every held-out gate (skill-merge, playbook, preference)
 * must use: honors MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL (default nomic-embed-text-v2-moe)
 * and caches, so all gates share one model — the gate floors are calibrated for
 * one embedder, so a surface that silently used a different model would apply a
 * miscalibrated threshold. Use this instead of hand-rolling createOllamaEmbedder.
 */
export function createGateEmbedder(env: NodeJS.ProcessEnv): (text: string) => Promise<readonly number[]> {
  return createCachingEmbedder(createOllamaEmbedder(
    env.MUSE_KNOWLEDGE_SEARCH_EMBED_MODEL?.trim() || env.MUSE_EMBED_MODEL?.trim() || "nomic-embed-text-v2-moe"
  ));
}
