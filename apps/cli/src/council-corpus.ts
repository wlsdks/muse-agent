/**
 * Corpus retrieval for council self-abstention. A council member, when running in
 * grounded mode (`MUSE_A2A_COUNCIL_GROUNDED`), grounds its reasoning against ITS
 * OWN notes — these are the `KnowledgeMatch[]` `produceGroundedCouncilReasoning`
 * grades retrieval confidence on, so the member weighs in only when its corpus
 * confidently bears on the question. The corpus NEVER crosses the wire (only the
 * abstain/speak decision does); this is purely local evidence.
 *
 * Reuses the precomputed notes index (no re-embedding the corpus per council) and
 * the SAME absolute cosine the recall wedge grades by. Fail-CLOSED to silence
 * (empty ⇒ abstain) when there is no index or the embedder is down — an
 * unreachable corpus must make a member abstain, never guess.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { cosineSimilarity, type KnowledgeMatch } from "@muse/agent-core";
import { isRecord, parseBooleanFromEnv } from "@muse/shared";

import { filterLiveNoteIndexFiles } from "./commands-recall.js";
import { embed } from "./embed.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";
import { parseJsonWith } from "./json-parse.js";

interface NotesIndexShape {
  readonly model?: string;
  readonly files?: ReadonlyArray<{
    readonly path: string;
    readonly chunks?: ReadonlyArray<{ readonly text: string; readonly embedding: readonly number[] }>;
  }>;
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isCouncilChunk(value: unknown): value is { readonly text: string; readonly embedding: readonly number[] } {
  return isRecord(value) && typeof value.text === "string" && isNumberArray(value.embedding);
}

function isCouncilFile(value: unknown): value is { readonly path: string; readonly chunks?: ReadonlyArray<{ readonly text: string; readonly embedding: readonly number[] }> } {
  return (
    isRecord(value) &&
    typeof value.path === "string" &&
    (
      value.chunks === undefined ||
      (
        Array.isArray(value.chunks) &&
        value.chunks.every(isCouncilChunk)
      )
    )
  );
}

function isCouncilIndex(value: unknown): value is NotesIndexShape {
  return (
    isRecord(value) &&
    (value.model === undefined || typeof value.model === "string") &&
    (
      value.files === undefined ||
      (Array.isArray(value.files) && value.files.every(isCouncilFile))
    )
  );
}

function parseNotesIndex(raw: unknown): NotesIndexShape | undefined {
  return isCouncilIndex(raw) ? raw : undefined;
}

export function defaultEmbedModel(env: Record<string, string | undefined> = process.env): string {
  return env.MUSE_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
}

function notesIndexFile(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env.MUSE_NOTES_INDEX_FILE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".muse", "notes-index.json");
}

export interface CouncilCorpusOptions {
  readonly env?: Record<string, string | undefined>;
  /** Override the embedder (tests). Defaults to the local nomic-embed via `embed`. */
  readonly embedFn?: (text: string, model: string) => Promise<readonly number[]>;
  readonly topK?: number;
}

/** This Muse's own corpus matches for a council question — the evidence its self-abstention gate grounds against. */
export async function councilCorpusMatches(
  question: string,
  options: CouncilCorpusOptions = {}
): Promise<readonly KnowledgeMatch[]> {
  const env = options.env ?? process.env;
  const embedFn = options.embedFn ?? embed;
  const topK = options.topK ?? 6;
  let index: NotesIndexShape | undefined;
  try {
    index = parseJsonWith(await readFile(notesIndexFile(env), "utf8"), parseNotesIndex);
  } catch {
    return [];
  }
  if (!index) {
    return [];
  }
  const liveFiles = filterLiveNoteIndexFiles(index.files ?? [], existsSync);
  const chunks = liveFiles.flatMap((file) =>
    (file.chunks ?? []).map((chunk) => ({ embedding: chunk.embedding, source: file.path, text: chunk.text }))
  );
  if (chunks.length === 0) {
    return [];
  }
  let queryVec: readonly number[];
  try {
    queryVec = await embedFn(question, defaultEmbedModel(env));
  } catch {
    return [];
  }
  return chunks
    .map((chunk) => {
      const cosine = cosineSimilarity(queryVec, chunk.embedding);
      return { cosine, score: cosine, source: chunk.source, text: chunk.text };
    })
    .sort((a, b) => b.cosine - a.cosine)
    .slice(0, topK);
}

/** Whether THIS Muse opted its council voice into grounded self-abstention. */
export function isCouncilGroundedMode(env: Record<string, string | undefined> = process.env): boolean {
  return parseBooleanFromEnv(env.MUSE_A2A_COUNCIL_GROUNDED, false);
}
