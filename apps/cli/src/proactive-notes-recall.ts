/**
 * Wires Muse's confidence-gated proactive recall (the north star) into the
 * LOCAL daemon over the pre-embedded `~/.muse/notes-index.json`. The proactive
 * loop's `investigate` seam asks "is there something in the user's own notes
 * worth surfacing for this imminent item?" — and this answers with a cited
 * finding ONLY when the recall is confident, reusing the same deterministic
 * CRAG gate (`decideProactiveRecall`) as `muse ask`. Re-embeds only the QUERY
 * each tick (the corpus is already embedded), so it's cheap to run on a timer.
 *
 * Fail-open everywhere: a missing index, an embed error, or a weak recall →
 * `undefined`, and the proactive notice still fires without a finding.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { decideProactiveRecall, type KnowledgeMatch } from "@muse/agent-core";

import { cosineSimilarity, embed } from "./embed.js";

interface IndexChunk {
  readonly file: string;
  readonly text: string;
  readonly embedding: number[];
}

interface NotesIndex {
  readonly model?: string;
  readonly files?: readonly { readonly chunks?: readonly IndexChunk[] }[];
}

/**
 * Pure: cosine-rank the pre-embedded chunks against an already-embedded query
 * vector and return the top-K as KnowledgeMatch[] (cosine = score). Exported
 * for direct unit coverage without touching disk or Ollama.
 */
export function proactiveMatchesFromIndex(
  queryVec: readonly number[],
  chunks: readonly IndexChunk[],
  topK = 3
): KnowledgeMatch[] {
  return chunks
    .map((c): KnowledgeMatch => {
      const cos = cosineSimilarity(queryVec, c.embedding);
      return { cosine: cos, score: cos, source: c.file, text: c.text };
    })
    .sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0))
    .slice(0, Math.max(1, Math.trunc(topK)));
}

export interface IndexedProactiveInvestigatorOptions {
  readonly indexFile?: string;
  readonly embedModel?: string;
  readonly topK?: number;
  readonly confidentAt?: number;
  /** Test seam — defaults to the real Ollama embedder. */
  readonly embedText?: (text: string, model: string) => Promise<readonly number[]>;
}

export function createIndexedProactiveInvestigator(
  options: IndexedProactiveInvestigatorOptions = {}
): (item: { readonly title: string; readonly kind: string; readonly factSheet: string }) => Promise<string | undefined> {
  const indexFile = options.indexFile ?? join(homedir(), ".muse", "notes-index.json");
  const embedText = options.embedText ?? ((text, model) => embed(text, model));
  return async (item) => {
    const query = item.title.trim();
    if (query.length === 0) return undefined;
    let index: NotesIndex;
    try {
      index = JSON.parse(await readFile(indexFile, "utf8")) as NotesIndex;
    } catch {
      return undefined;
    }
    const chunks = (index.files ?? []).flatMap((f) => f.chunks ?? []);
    if (chunks.length === 0) return undefined;
    let queryVec: readonly number[];
    try {
      queryVec = await embedText(query, options.embedModel ?? index.model ?? "nomic-embed-text");
    } catch {
      return undefined;
    }
    const matches = proactiveMatchesFromIndex(queryVec, chunks, options.topK ?? 3);
    const decision = decideProactiveRecall(matches, options.confidentAt !== undefined ? { confidentAt: options.confidentAt } : {});
    return decision.surface ? decision.finding : undefined;
  };
}
