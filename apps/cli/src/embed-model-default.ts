/**
 * The embedding-model default lives in this LEAF module (no heavy imports) so
 * the chat path can read it without pulling the notes-RAG module into the
 * bundled desktop binary's startup graph.
 *
 * Default switched to the multilingual embedder after a measured A/B
 * (eval:embedder-ab): the EN-centric v1 ranked the right Korean note first on
 * only 50% of paraphrased KO queries; v2-moe scored 100% KO and 100% EN on the
 * same corpus — Korean recall was a silent ceiling under every grounded surface.
 */
export const LEGACY_EMBED_MODEL = "nomic-embed-text";

export const DEFAULT_EMBED_MODEL = process.env.MUSE_EMBED_MODEL?.trim() || "nomic-embed-text-v2-moe";

/**
 * Which model a (re)index should use: an explicitly chosen custom model is
 * always preserved, but an index built with the LEGACY default migrates to the
 * new default once — otherwise the embedder upgrade would never reach existing
 * users (the chat path deliberately re-embeds a stale index with its own model).
 */
export function resolveIndexModel(existing: string | undefined, requested: string): string {
  if (!existing || existing.trim().length === 0) {
    return requested;
  }
  if (existing === LEGACY_EMBED_MODEL && requested === DEFAULT_EMBED_MODEL && requested !== LEGACY_EMBED_MODEL) {
    return requested;
  }
  return existing;
}
