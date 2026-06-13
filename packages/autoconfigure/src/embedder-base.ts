/**
 * The single source of truth for the local embedder's base URL (Ollama
 * `/api/embeddings`). Both the runtime fail-close guard (`createOllamaEmbedder`)
 * and the `muse doctor` local-only posture (`evaluateLocalOnlyPosture`) resolve
 * the base the SAME way — `OLLAMA_BASE_URL` (empty/whitespace treated as unset)
 * defaulting to loopback, trailing slashes stripped. They MUST agree, or doctor
 * would report a posture the runtime doesn't enforce; sharing one helper makes
 * that parity structural instead of two hand-kept string literals.
 */
export function resolveEmbedderBase(env: Readonly<Record<string, string | undefined>>): string {
  return (env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/+$/u, "");
}
