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
import { createNotesMcpServer } from "@muse/domain-tools";
import { isRecord , errorMessage} from "@muse/shared";
import type { SpeechToTextProvider } from "@muse/voice";
import type { Command } from "commander";

import { autoReindexNotes, isNotesIndexStale } from "./commands-notes-rag.js";
import { autoReindexNotice } from "./auto-reindex-budget.js";
import { rankRecallCandidates, type RecallHit } from "./commands-recall.js";
import { embed } from "./embed.js";
import { defaultEpisodeIndexFile, loadEpisodeIndex } from "./episode-index.js";
import { defaultBuildVoiceProviders, defaultShells, type ListenShells } from "./commands-listen.js";
import { parseJsonWith } from "./json-parse.js";
import type { ProgramIO } from "./program.js";
import { captureVoiceText } from "./voice-capture.js";
import { DEFAULT_EMBED_MODEL } from "./embed-model-default.js";

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

/**
 * Read all of a piped stdin into a string so a thought can be captured from a
 * pipe with zero ceremony — `pbpaste | muse note` (clipboard), `echo … | muse
 * note`, or any command's output into the second brain. Fail-soft: an empty or
 * errored stream resolves to `""` (the caller then reports "nothing to
 * capture" rather than crashing).
 */
export async function readAllStdin(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
  } catch {
    return "";
  }
  return Buffer.concat(chunks).toString("utf8");
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

type NotesChunk = { readonly text: string; readonly embedding: readonly number[] };
type NotesFile = { readonly path: string; readonly chunks: ReadonlyArray<NotesChunk> };

function isNotesNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function isNotesChunk(value: unknown): value is NotesChunk {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    isNotesNumberArray(value.embedding)
  );
}

function isNotesIndex(value: unknown): value is NotesIndexShape {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.model !== "string" || !Array.isArray(value.files)) {
    return false;
  }
  return value.files.every((file): file is NotesFile =>
    isRecord(file) &&
    typeof file.path === "string" &&
    Array.isArray(file.chunks) &&
    file.chunks.every(isNotesChunk)
  );
}

/** Rank the fresh capture against the on-disk notes + episode indices. */
async function findConnections(captureText: string, embedModel: string): Promise<readonly RecallHit[]> {
  let notesIndex: NotesIndexShape | undefined;
  try {
    notesIndex = parseJsonWith(await readFile(notesIndexPath(), "utf8"), isNotesIndex);
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

export interface NoteCommandHelpers {
  /** Injection seam for tests: STT provider + mic shells used by `--voice`. */
  readonly buildVoiceProviders?: () => { readonly stt?: SpeechToTextProvider };
  readonly shells?: ListenShells;
}

export function registerNoteCommand(program: Command, io: ProgramIO, helpers: NoteCommandHelpers = {}): void {
  program
    .command("note")
    .description("Frictionless capture: append a one-line thought to today's inbox note and auto-index it (pass text, pipe via stdin `pbpaste | muse note`, or speak it with --voice)")
    .argument("[text...]", "The thought to capture, e.g. `muse note buy milk after the dentist` — omit to read from a stdin pipe or use --voice")
    .option("--embed-model <tag>", "Embedding model for the auto-index", DEFAULT_EMBED_MODEL)
    .option("--voice", "Speak the thought: record a short mic clip and transcribe it via the configured STT")
    .option("--clip-seconds <n>", "Seconds to record with --voice (default 6, clamped 1–30)", "6")
    .option("--lang <code>", "STT language hint for --voice, e.g. 'ko'")
    .action(async (parts: string[], options: { readonly embedModel?: string; readonly voice?: boolean; readonly clipSeconds?: string; readonly lang?: string }) => {
      const argText = parts.join(" ").trim();
      let text: string;
      if (options.voice) {
        const providers = (helpers.buildVoiceProviders ?? defaultBuildVoiceProviders)();
        if (!providers.stt) {
          io.stderr("muse note --voice: no STT provider configured (run `muse setup voice`)\n");
          process.exitCode = 1;
          return;
        }
        const clipSeconds = Math.min(30, Math.max(1, Math.trunc(Number(options.clipSeconds) || 6)));
        io.stderr(`(listening ${clipSeconds.toString()}s — speak your thought…)\n`);
        text = (await captureVoiceText(
          { clipSeconds, shells: helpers.shells ?? defaultShells(), stt: providers.stt, ...(options.lang ? { language: options.lang } : {}) },
          io
        )) ?? "";
        if (text.length === 0) {
          io.stderr("muse note --voice: nothing captured (no speech / transcription failed)\n");
          process.exitCode = 1;
          return;
        }
      } else {
        // No inline text → read a piped stdin (clipboard/pipe capture). A TTY
        // with no args is just an empty invocation, not a pipe to wait on.
        text = argText.length > 0
          ? argText
          : (process.stdin.isTTY ? "" : (await readAllStdin(process.stdin)).trim());
      }
      if (text.length === 0) {
        io.stderr("muse note: nothing to capture (pass text, pipe via stdin, or use --voice)\n");
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
          const summary = await autoReindexNotes({ dir: notesDir, indexPath: notesIndexPath(), model: options.embedModel ?? DEFAULT_EMBED_MODEL }, process.env);
          indexed = summary.status === "complete";
          const notice = autoReindexNotice(summary);
          if (notice) io.stderr(`(${notice})\n`);
        } else {
          indexed = true;
        }
      } catch (cause) {
        io.stderr(`(auto-index skipped — ${errorMessage(cause)}; run \`muse notes reindex\` later)\n`);
      }
      io.stdout(`captured → ${path}${indexed ? " (indexed)" : ""}\n`);

      // SB-3 (proactive connection): surface related PRIOR knowledge for the
      // thought just captured — the second brain connects new input to old
      // without being asked. A bonus; never fails the capture.
      if (indexed) {
        try {
          const hits = await findConnections(text, options.embedModel ?? DEFAULT_EMBED_MODEL);
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
