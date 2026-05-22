import { chunkText, rankKnowledgeChunks, renderKnowledgeMatches, type KnowledgeChunk } from "@muse/agent-core";
import type { NotesProvider } from "@muse/mcp";
import type { MuseTool } from "@muse/tools";

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
      // Chunk long notes / ingested docs so a passage past the first
      // `maxChars` is still retrievable + citable, instead of truncated
      // away. A short note stays one chunk sourced `notes/<id>`.
      const pieces = chunkText(body, maxChars);
      pieces.forEach((piece, index) => {
        chunks.push({ source: pieces.length > 1 ? `notes/${entry.id}#${(index + 1).toString()}` : `notes/${entry.id}`, text: piece });
      });
    }
  }

  if (options.extraChunks?.length) {
    chunks.push(...options.extraChunks);
  }

  return chunks;
}

export interface NotesKnowledgeSearchToolOptions {
  readonly notesProvider: NotesProvider;
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly topK?: number;
  readonly maxNotes?: number;
  readonly maxCharsPerNote?: number;
  readonly extraChunks?: readonly KnowledgeChunk[];
}

/**
 * A read-only `knowledge_search` tool wired over the user's LIVE notes
 * store: each call re-assembles the corpus (so a note added since the
 * last query is searchable) then ranks + renders with source labels.
 * This is what makes the P20 knowledge engine reachable from a real
 * `muse ask --with-tools` run.
 */
export function createNotesKnowledgeSearchTool(options: NotesKnowledgeSearchToolOptions): MuseTool {
  return {
    definition: {
      description: "Search the user's personal notes (and ingested documents) for relevant passages. Returns each passage labelled with its [source] — cite the source you use.",
      inputSchema: {
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object"
      },
      name: "knowledge_search",
      risk: "read"
    },
    execute: async (args) => {
      const query = typeof (args as { query?: unknown }).query === "string" ? (args as { query: string }).query : "";
      const corpus = await assembleKnowledgeCorpus({
        notesProvider: options.notesProvider,
        ...(options.extraChunks ? { extraChunks: options.extraChunks } : {}),
        ...(options.maxNotes !== undefined ? { maxNotes: options.maxNotes } : {}),
        ...(options.maxCharsPerNote !== undefined ? { maxCharsPerNote: options.maxCharsPerNote } : {})
      });
      const matches = await rankKnowledgeChunks(query, corpus, {
        embed: options.embed,
        ...(options.topK !== undefined ? { topK: options.topK } : {})
      });
      return renderKnowledgeMatches(matches);
    }
  };
}
