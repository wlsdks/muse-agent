/**
 * Resolve the Ollama base URL the way the runtime does — env first,
 * then the `~/.muse/models.json` credentials file written by
 * `muse setup model`. Two CLI commands embed against Ollama
 * directly (`muse ask` for notes-RAG, `muse notes index` for the
 * vector build); both used to read `process.env.OLLAMA_BASE_URL`
 * only, which means a wizard-only setup (no shell `export`) would
 * silently send the embedding calls to `http://127.0.0.1:11434`
 * instead of the host the user configured.
 *
 * Same merge `@muse/autoconfigure` already runs for the agent
 * runtime — kept consistent so a remote Ollama works on every
 * surface, not just chat.
 *
 * Returns the URL with any trailing slashes stripped so callers can
 * append `/api/embeddings` directly without producing a `//`.
 */

import { mergeModelKeysFromFile, type MuseEnvironment } from "@muse/autoconfigure";

export function resolveOllamaUrl(env: MuseEnvironment = process.env): string {
  const merged = mergeModelKeysFromFile(env);
  const raw = merged.OLLAMA_BASE_URL?.trim();
  const base = raw && raw.length > 0 ? raw : "http://127.0.0.1:11434";
  return base.replace(/\/+$/u, "");
}
