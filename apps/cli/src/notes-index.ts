/**
 * CLI binding of `@muse/recall`'s notes-index core. `reindexNotes` is wrapped
 * so its embeddings resolve the Ollama host through `resolveOllamaUrl`
 * (env merged with `muse setup model`'s `~/.muse/models.json`) — the package
 * default is env-only. Everything else re-exports unchanged;
 * `extractDocumentText` keeps its historical CLI name (the package calls it
 * `extractNoteText` to avoid clashing with the document reader's).
 */

import { reindexNotes as reindexNotesCore, type FullReindexSummary, type ReindexOptions, type ReindexSummary } from "@muse/recall";

import { resolveOllamaUrl } from "./ollama-url.js";
import { resolveAutoReindexBudget } from "./auto-reindex-budget.js";

export {
  NOTE_FILE_RE,
  NOTES_INDEX_SCHEMA_VERSION,
  cosine,
  defaultIndexPath,
  extractNoteText as extractDocumentText,
  formatReindexOutcome,
  isNotesIndexStale,
  isNotesIndexValid,
  loadIndex,
  noteCentroid,
  parseRagBoundedInt,
  rankRelatedNotes,
  resolveIndexNotePath,
  walkMarkdown,
  type RelatedNote,
  type ReindexSummary,
  type FullReindexSummary
} from "@muse/recall";

export async function reindexNotes(
  options: Omit<ReindexOptions, "baseUrlResolver" | "maxEmbeddingAttempts">
): Promise<FullReindexSummary> {
  const baseUrlResolver = options.fetchImpl
    ? () => process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"
    : resolveOllamaUrl;
  const summary = await reindexNotesCore({ baseUrlResolver, ...options }) as ReindexSummary;
  if (summary.status === "busy") throw new Error("another notes index writer is active; retry shortly");
  if (summary.status === "aborted") throw new Error("notes reindex cancelled");
  if (!summary.index) throw new Error("notes reindex completed without a readable index");
  return { ...summary, index: summary.index } as FullReindexSummary;
}

export async function autoReindexNotes(
  options: Omit<Parameters<typeof reindexNotesCore>[0], "baseUrlResolver" | "embedTimeoutMs" | "maxEmbeddingAttempts">,
  env: Record<string, string | undefined> = process.env
): Promise<ReindexSummary> {
  const baseUrlResolver = options.fetchImpl
    ? () => env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434"
    : resolveOllamaUrl;
  return reindexNotesCore({
    baseUrlResolver,
    ...resolveAutoReindexBudget(env),
    ...options
  });
}
