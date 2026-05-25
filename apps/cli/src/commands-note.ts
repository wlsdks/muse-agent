/**
 * `muse note "<thought>"` — frictionless capture. Appends one timestamped
 * bullet to today's inbox note (auto-routed, no path needed) and auto-indexes
 * it so it's immediately recall-/ask-able. The whole point of a second brain
 * is that capture costs nothing: one command, no filename, no manual reindex.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveNotesDir } from "@muse/autoconfigure";
import { createNotesMcpServer } from "@muse/mcp";
import type { Command } from "commander";

import { isNotesIndexStale, reindexNotes } from "./commands-notes-rag.js";
import { rankRecallCandidates, type RecallHit } from "./commands-recall.js";
import { embed } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import type { ProgramIO } from "./program.js";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Today's inbox note, by LOCAL date: `inbox/YYYY-MM-DD.md`. */
export function dailyInboxNotePath(now: Date): string {
  return `inbox/${now.getFullYear().toString()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.md`;
}

/** One timestamped bullet per captured thought (local HH:MM), single-line. */
export function formatCaptureLine(text: string, now: Date): string {
  return `- ${pad(now.getHours())}:${pad(now.getMinutes())} ${text.replace(/\s+/gu, " ").trim()}`;
}

function notesIndexPath(): string {
  return join(homedir(), ".muse", "notes-index.json");
}

/**
 * SB-3: from ranked recall hits for the fresh capture, pick the related PRIOR
 * knowledge to surface — drop the self note (the capture just indexed), drop
 * weak matches below `minScore`, keep the top `limit`. Pure; hits arrive
 * pre-sorted by the ranker.
 */
export function selectConnections(
  hits: readonly RecallHit[],
  selfRef: string,
  minScore: number,
  limit: number
): RecallHit[] {
  return hits
    .filter((h) => h.ref !== selfRef && !h.ref.endsWith(`/${selfRef}`) && !h.ref.endsWith(selfRef) && h.score >= minScore)
    .slice(0, Math.max(0, limit));
}

interface NotesIndexShape {
  readonly model: string;
  readonly files: ReadonlyArray<{ readonly path: string; readonly chunks: ReadonlyArray<{ readonly text: string; readonly embedding: readonly number[] }> }>;
}

/** Rank the fresh capture against the on-disk notes + episode indices. */
async function findConnections(captureText: string, embedModel: string): Promise<readonly RecallHit[]> {
  let notesIndex: NotesIndexShape | undefined;
  try {
    notesIndex = JSON.parse(await readFile(notesIndexPath(), "utf8")) as NotesIndexShape;
  } catch {
    notesIndex = undefined;
  }
  if (!notesIndex || notesIndex.model !== embedModel) {
    return [];
  }
  const noteChunks = notesIndex.files.flatMap((f) => f.chunks.map((c) => ({ embedding: c.embedding, path: f.path, text: c.text })));
  const epIndex = await loadEpisodeIndex(defaultEpisodeIndexFile());
  const episodeEntries = epIndex && epIndex.model === embedModel ? epIndex.entries : [];
  const queryVec = await embed(captureText, embedModel);
  return rankRecallCandidates({ episodeEntries, limit: 6, noteChunks, queryVec, source: "all" });
}

export function registerNoteCommand(program: Command, io: ProgramIO): void {
  program
    .command("note")
    .description("Frictionless capture: append a one-line thought to today's inbox note and auto-index it")
    .argument("<text...>", "The thought to capture, e.g. `muse note buy milk after the dentist`")
    .option("--embed-model <tag>", "Embedding model for the auto-index", "nomic-embed-text")
    .action(async (parts: string[], options: { readonly embedModel?: string }) => {
      const text = parts.join(" ").trim();
      if (text.length === 0) {
        io.stderr("muse note: nothing to capture\n");
        process.exitCode = 1;
        return;
      }
      const now = new Date();
      const path = dailyInboxNotePath(now);
      const line = formatCaptureLine(text, now);

      const notesDir = resolveNotesDir(process.env as Record<string, string | undefined>);
      const server = createNotesMcpServer({ notesDir });
      const append = server.tools.find((t) => t.name === "append");
      if (!append) {
        io.stderr("muse note: local notes append tool unavailable\n");
        process.exitCode = 1;
        return;
      }
      const result = (await append.execute({ content: `${line}\n`, path } as Parameters<typeof append.execute>[0])) as Record<string, unknown>;
      if (typeof result.error === "string") {
        io.stderr(`muse note: ${result.error}\n`);
        process.exitCode = 1;
        return;
      }

      // Auto-index so the captured thought is immediately recall-/ask-able.
      // Fail-soft: a down embedding endpoint must not lose the capture.
      let indexed = false;
      try {
        if (await isNotesIndexStale(notesDir, notesIndexPath())) {
          const summary = await reindexNotes({ dir: notesDir, indexPath: notesIndexPath(), model: options.embedModel ?? "nomic-embed-text" });
          indexed = summary.embedded > 0 || summary.skipped > 0;
        } else {
          indexed = true;
        }
      } catch (cause) {
        io.stderr(`(auto-index skipped — ${cause instanceof Error ? cause.message : String(cause)}; run \`muse notes reindex\` later)\n`);
      }
      io.stdout(`captured → ${path}${indexed ? " (indexed)" : ""}\n`);

      // SB-3 (proactive connection): surface related PRIOR knowledge for the
      // thought just captured — the second brain connects new input to old
      // without being asked. A bonus; never fails the capture.
      if (indexed) {
        try {
          const hits = await findConnections(text, options.embedModel ?? "nomic-embed-text");
          const connections = selectConnections(hits, path, 0.5, 2);
          if (connections.length > 0) {
            io.stdout("💡 Related in your brain:\n");
            for (const c of connections) {
              io.stdout(`  [${c.source}] ${c.ref.split("/").pop() ?? c.ref} — ${c.snippet.replace(/\s+/gu, " ").trim().slice(0, 80)}\n`);
            }
          }
        } catch {
          // connections are a bonus — a down embed endpoint must not fail capture
        }
      }
    });
}
