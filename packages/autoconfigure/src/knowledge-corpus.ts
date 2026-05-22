import type { KnowledgeChunk } from "@muse/agent-core";
import type { NotesProvider } from "@muse/mcp";

/**
 * Assemble a multi-document knowledge corpus from the user's LIVE
 * stores for `rankKnowledgeChunks` / `createKnowledgeSearchTool`
 * (P20 knowledge). Each note becomes one `KnowledgeChunk` sourced as
 * `notes/<id>`; `extraChunks` carries other sources (e.g. an ingested
 * document's text, sourced `docs/<name>`) so the corpus genuinely
 * spans notes + ingested docs.
 *
 * Lives in @muse/autoconfigure — the wiring layer that may depend on
 * both @muse/mcp (NotesProvider) and @muse/agent-core (KnowledgeChunk);
 * @muse/mcp itself deliberately does not depend on @muse/agent-core.
 *
 * Fail-open: a notes store that can't list / a note that can't be
 * read is skipped, never thrown — a partial corpus still grounds an
 * answer.
 */
export interface AssembleKnowledgeCorpusOptions {
  readonly notesProvider?: NotesProvider;
  readonly extraChunks?: readonly KnowledgeChunk[];
  /** Cap notes pulled into the corpus. Default 200. */
  readonly maxNotes?: number;
  /** Truncate each note body to bound prompt/CPU cost. Default 4000. */
  readonly maxCharsPerNote?: number;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function assembleKnowledgeCorpus(
  options: AssembleKnowledgeCorpusOptions
): Promise<KnowledgeChunk[]> {
  const maxNotes = Math.max(1, Math.trunc(finiteOr(options.maxNotes, 200)));
  const maxChars = Math.max(1, Math.trunc(finiteOr(options.maxCharsPerNote, 4_000)));
  const chunks: KnowledgeChunk[] = [];

  if (options.notesProvider) {
    let entries: readonly { readonly id: string }[];
    try {
      entries = await options.notesProvider.list();
    } catch {
      entries = [];
    }
    for (const entry of entries.slice(0, maxNotes)) {
      let body: string | undefined;
      try {
        body = (await options.notesProvider.read(entry.id))?.body?.trim();
      } catch {
        body = undefined;
      }
      if (!body) {
        continue;
      }
      chunks.push({ source: `notes/${entry.id}`, text: body.length > maxChars ? body.slice(0, maxChars) : body });
    }
  }

  if (options.extraChunks?.length) {
    chunks.push(...options.extraChunks);
  }

  return chunks;
}
