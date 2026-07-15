/**
 * Ollama `/api/tags` model-entry shape + tag-matching utilities for `muse doctor`.
 * Split out of commands-doctor.ts; pure (no IO), so directly testable.
 */

/**
 * Shape of the `/api/tags` model entry we rely on for
 * the model-pulled check. Real Ollama responses also carry
 * `digest`, `modified_at`, and a `details` block; we only need
 * `name` (the full tag, e.g. `qwen3.5:9b-q4_K_M`) and `size` (for
 * the friendly "(6.6 GB)" suffix).
 */
export interface OllamaTagsEntry {
  readonly name: string;
  readonly size?: number;
}

export function isOllamaTagsEntry(value: unknown): value is OllamaTagsEntry {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as { name?: unknown }).name === "string"
    && ((value as { size?: unknown }).size === undefined
      || typeof (value as { size?: unknown }).size === "number");
}

/**
 * Match `configuredTag` against an Ollama `/api/tags`
 * response. Ollama serialises model identities two ways:
 *   - `name: "qwen3.5:9b-q4_K_M"` for an explicit tag
 *   - `name: "qwen3.5:latest"` when the user pulled `qwen3.5`
 *     without a tag suffix (the "latest" tag is implicit).
 * The doctor user may have configured either form; treat
 * `<base>` and `<base>:latest` as the same identity so a config of
 * `ollama/qwen3.5` still matches when Ollama recorded
 * `qwen3.5:latest`. Returns the matched entry (so callers can
 * surface `.size`) or `undefined`.
 */
export function findOllamaModelTag(
  models: readonly OllamaTagsEntry[],
  configuredTag: string
): OllamaTagsEntry | undefined {
  const normalize = (s: string): string => (s.includes(":") ? s : `${s}:latest`);
  const target = normalize(configuredTag.trim());
  return models.find((m) => normalize(m.name) === target);
}
