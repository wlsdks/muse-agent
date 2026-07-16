import { errorMessage, isErrorLike } from "@muse/shared";
/**
 * `muse watch-folder` — credential-free external-signal trigger.
 *
 * Any external system that can drop a file (Mail rule that exports
 * matching messages, a .ics calendar invite handler, a webhook that
 * shells out to `echo > file`, Hazel / Folder Actions / etc.) becomes
 * a proactive signal source for Muse the moment its output lands in
 * the watched directory.
 *
 * On each new file:
 *   1. Read the file (text preview, max 10 KB — bigger payloads are
 *      truncated). A binary blob (image / PDF / archive) is surfaced
 *      as a clean "name (N bytes)" line instead of garbled bytes, and
 *      contributes no body.
 *   2. Send a notice via the configured messaging provider with:
 *        title    = filename (sans extension)
 *        body     = first non-empty line, or "(empty)"
 *   3. Move the file to `<watched>/.processed/<timestamp>-<name>`
 *      so it isn't re-fired on the next event.
 *
 * Pure open-source path: Node's `fs.watch` on darwin/linux, no
 * external daemon, no credentials. The user wires Mail / Calendar /
 * any other producer to drop into the watched directory.
 */

import { mkdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { watch } from "node:fs";

import { randomUUID } from "node:crypto";

import {
  buildMessagingRegistry,
  resolveNotesDir,
  resolveProactiveHistoryFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { appendProactiveHistory, mutateTasks, parseTaskDueAt, type PersistedTask } from "@muse/stores";
import type { Command } from "commander";

import { closestCommandName } from "./closest-command.js";
import { waitForShutdownSignal } from "./async-promises.js";
import { ensureNoteMarkdownExtension, extractDocumentText, isLikelyBinary, saveDocumentToNotes } from "./commands-read.js";
import type { ProgramIO } from "./program.js";

const MAX_PREVIEW_BYTES = 10 * 1024;

/** Note id for a watched file ingested into the corpus: `<prefix>/<basename-no-ext>.md`. */
export function watchIngestNoteId(filename: string, prefix: string): string {
  const clean = prefix.trim().replace(/^\/+|\/+$/gu, "");
  const stem = basename(filename, extname(filename));
  return ensureNoteMarkdownExtension(`${clean.length > 0 ? `${clean}/` : ""}${stem}`);
}

interface WatchOptions {
  readonly path?: string;
  readonly provider?: string;
  readonly destination?: string;
  readonly asTask?: boolean;
  readonly defaultLeadMinutes?: string;
  readonly ingest?: boolean;
  readonly notesPrefix?: string;
}

/**
 * If the file body has a recognisable "due:" / "마감:" / "due at"
 * line, return the parsed dueAt. Otherwise return undefined and the
 * caller falls back to `defaultLeadMinutes` from now.
 *
 * Recognised patterns (case-insensitive):
 *   due: tomorrow at 6pm
 *   due: 2026-05-15T14:00Z
 *   마감: 내일 오후 3시
 */
export function extractDueHint(body: string): string | undefined {
  const lines = body.split("\n").slice(0, 8);
  for (const line of lines) {
    const m = /^\s*(?:due|마감|deadline)\s*[:-]\s*(.+)$/i.exec(line.trim());
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return undefined;
}

export interface InboxDueResolution {
  readonly dueAt: string;
  /**
   * Set when a due:/마감: line was present but unparseable. The caller
   * surfaces this so a typo'd hint ("due: next freday") doesn't
   * silently degrade to the default lead with no feedback.
   */
  readonly unparsedHint?: string;
}

export interface InboxNotice {
  readonly title: string;
  /** True when the dropped file is binary (image/PDF/archive). */
  readonly binary: boolean;
  /** The messaging notice text. */
  readonly text: string;
  /**
   * UTF-8 body for due-hint parsing + task notes. Empty for a binary
   * file — so a dropped photo never spills mojibake into a task's
   * notes or gets mis-parsed for a fake `due:` line.
   */
  readonly body: string;
}

/**
 * Build the inbox notice for a dropped file. A binary blob (image,
 * PDF, archive) becomes a clean "📎 name: <ext> file (N bytes)" line
 * instead of a notice full of garbled bytes, and contributes no body
 * — the documented "binary blobs are ignored" behaviour that the
 * UTF-8-everything read path silently dropped.
 */
export function buildInboxNotice(filename: string, buffer: Buffer, maxPreviewBytes: number): InboxNotice {
  const title = basename(filename, extname(filename));
  if (isLikelyBinary(buffer)) {
    const ext = extname(filename).replace(/^\./u, "") || "binary";
    return {
      binary: true,
      body: "",
      text: `📎 ${title}: ${ext} file (${buffer.length.toString()} bytes) — binary, no text preview`,
      title
    };
  }
  const body = buffer.subarray(0, maxPreviewBytes).toString("utf8");
  const firstLine = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "(empty)";
  return {
    binary: false,
    body,
    text: `📥 ${title}: ${firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine}`,
    title
  };
}

export function resolveInboxDueAt(
  raw: string,
  defaultLeadMinutes: number,
  now: () => Date
): InboxDueResolution {
  const fallback = (): string =>
    new Date(now().getTime() + defaultLeadMinutes * 60_000).toISOString();
  const hint = extractDueHint(raw);
  if (hint === undefined) {
    return { dueAt: fallback() };
  }
  const parsed = parseTaskDueAt(hint, now);
  if (isErrorLike(parsed)) {
    return { dueAt: fallback(), unparsedHint: hint };
  }
  return { dueAt: parsed };
}

export function registerWatchFolderCommand(program: Command, io: ProgramIO): void {
  program
    .command("watch-folder")
    .description("Watch a folder for new files and fire each one as a proactive notice — credential-free external-signal trigger")
    .option("--path <dir>", "Directory to watch (default ~/.muse/inbox)")
    .option("--provider <id>", "Messaging provider (default 'log')")
    .option("--destination <id>", "Messaging destination (default '@me')")
    .option(
      "--as-task",
      "Also create a tracked task per file (title=filename, notes=body, dueAt parsed or +1h). Lets the proactive daemon pick it up later."
    )
    .option(
      "--default-lead-minutes <n>",
      "When --as-task is set and no due:/마감: line is found, use this many minutes from now as the default dueAt (default 60)",
      "60"
    )
    .option(
      "--ingest",
      "Ingest each new file INTO the notes corpus (a citable `.md` note, searchable via `muse ask`) instead of firing a proactive notice — keeps the corpus live as you drop documents."
    )
    .option(
      "--notes-prefix <p>",
      "With --ingest, the folder prefix under MUSE_NOTES_DIR for ingested notes (default 'inbox')",
      "inbox"
    )
    .action(async (options: WatchOptions) => {
      const dir = options.path ?? join(homedir(), ".muse", "inbox");
      const processedDir = join(dir, ".processed");
      const provider = options.provider ?? "log";
      const destination = options.destination ?? "@me";
      const asTask = options.asTask === true;
      const ingestMode = options.ingest === true;
      const notesPrefix = (options.notesPrefix ?? "inbox").trim().replace(/^\/+|\/+$/gu, "");
      const notesDir = ingestMode ? resolveNotesDir(process.env as Record<string, string | undefined>) : undefined;
      // strict Number() so a "90m" unit-slip rejects instead of
      // becoming 90 (parseInt eats the suffix).
      let defaultLead = 60;
      if (options.defaultLeadMinutes !== undefined) {
        const trimmed = options.defaultLeadMinutes.trim();
        if (trimmed.length === 0) {
          io.stderr("--default-lead-minutes must not be empty\n");
          process.exitCode = 1;
          return;
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed < 1) {
          io.stderr(`--default-lead-minutes must be >= 1 (got '${options.defaultLeadMinutes}')\n`);
          process.exitCode = 1;
          return;
        }
        defaultLead = Math.max(1, Math.trunc(parsed));
      }
      const tasksFile = asTask ? resolveTasksFile(process.env as Record<string, string | undefined>) : undefined;

      await mkdir(dir, { recursive: true });
      await mkdir(processedDir, { recursive: true });

      const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
      if (!registry.has(provider)) {
        const known = registry.list().map((p) => p.id);
        const suggestion = closestCommandName(provider, known);
        const hint = suggestion ? ` — did you mean --provider ${suggestion}?` : "";
        io.stderr(`Provider '${provider}' is not registered${hint}. Try --provider log.\n`);
        process.exitCode = 1;
        return;
      }
      const historyFile = resolveProactiveHistoryFile(process.env as Record<string, string | undefined>);

      io.stdout(`muse watch-folder — watching ${dir}\n`);
      if (ingestMode) {
        io.stdout(`  ingest: ON (each file → a citable note under '${notesPrefix}/' in ${notesDir!})\n`);
        io.stdout(`  (Drop any document here to add it to your corpus. Ctrl-C to stop.)\n\n`);
      } else {
        io.stdout(`  provider=${provider}, destination=${destination}\n`);
        if (asTask) {
          io.stdout(`  as-task: ON (each file also becomes an open task in ${tasksFile!})\n`);
        }
        io.stdout(`  (Drop any text file here to fire a notice. Ctrl-C to stop.)\n\n`);
      }

      // De-dupe: fs.watch can fire "rename" twice for one file on some
      // platforms. Process each filename at most once until the file
      // has been moved into .processed.
      const inFlight = new Set<string>();

      const handleFile = async (filename: string): Promise<void> => {
        if (filename.startsWith(".")) return; // skip hidden / .processed
        if (inFlight.has(filename)) return;
        inFlight.add(filename);
        try {
          const full = join(dir, filename);
          let stats;
          try {
            stats = await stat(full);
          } catch {
            return; // file may have been renamed away by another consumer
          }
          if (!stats.isFile()) return;

          // --ingest path: fold the dropped file INTO the notes corpus as a
          // citable note instead of firing a notice, so the corpus stays live
          // as documents land. Reuses the same extract/save contract as
          // `muse read` (partial-failure tolerant: a corrupt/binary file is
          // skipped, never crashes the watcher), then archives the original.
          if (ingestMode && notesDir) {
            let extracted: { text: string; pageCount: number };
            try {
              const buffer = await readFile(full);
              const parsed = await extractDocumentText(full, buffer);
              extracted = { pageCount: parsed.pageCount, text: (parsed.text ?? "").trim() };
            } catch (cause) {
              io.stderr(`  ✗ ${filename} (could not read — skipped: ${errorMessage(cause)})\n`);
              return;
            }
            if (extracted.text.length === 0) {
              io.stderr(`  ✗ ${filename} (no text extracted — skipped)\n`);
              return;
            }
            const noteId = watchIngestNoteId(filename, notesPrefix);
            try {
              await saveDocumentToNotes(notesDir, noteId, full, extracted.text, extracted.pageCount);
            } catch (cause) {
              io.stderr(`  ✗ ${filename} (save failed — skipped: ${errorMessage(cause)})\n`);
              return;
            }
            const archived = join(processedDir, `${Date.now().toString()}-${filename}`);
            try {
              await rename(full, archived);
            } catch { /* best-effort archive; the note is already saved */ }
            io.stdout(`[${new Date().toISOString()}] ingested ${filename} → ${noteId} (searchable via \`muse ask\`)\n`);
            return;
          }

          let notice: InboxNotice;
          try {
            const buffer = await readFile(full);
            notice = buildInboxNotice(filename, buffer, MAX_PREVIEW_BYTES);
          } catch (cause) {
            io.stderr(`Failed to read ${filename}: ${errorMessage(cause)}\n`);
            return;
          }

          const { body: raw, text, title } = notice;

          await registry.send(provider, { destination, text });

          // --as-task path: also create a tracked task so the
          // proactive daemon later fires its own reminder for the
          // imminent dueAt. The inbox file becomes a first-class
          // task that participates in done/snooze/dismiss flows.
          if (asTask && tasksFile) {
            try {
              const { dueAt, unparsedHint } = resolveInboxDueAt(raw, defaultLead, () => new Date());
              if (unparsedHint !== undefined) {
                io.stderr(
                  `  due hint ${JSON.stringify(unparsedHint)} not understood — using default +${defaultLead}m\n`
                );
              }
              const task: PersistedTask = {
                createdAt: new Date().toISOString(),
                dueAt,
                id: `inbox_${randomUUID()}`,
                notes: raw.slice(0, 1000),
                status: "open",
                tags: ["inbox", "watch-folder"],
                title
              };
              await mutateTasks(tasksFile, (current) => [...current, task]);
              io.stdout(`  + task created: ${task.id} (dueAt ${dueAt})\n`);
            } catch (cause) {
              io.stderr(`  task-create failed for ${filename}: ${errorMessage(cause)}\n`);
            }
          }

          // Archive so the next fs.watch event doesn't re-trigger.
          const archived = join(processedDir, `${Date.now().toString()}-${filename}`);
          try {
            await rename(full, archived);
          } catch (cause) {
            io.stderr(`Failed to archive ${filename}: ${errorMessage(cause)}\n`);
          }

          await appendProactiveHistory(historyFile, {
            destination,
            firedAtIso: new Date().toISOString(),
            itemId: `inbox:${filename}`,
            kind: "task",
            providerId: provider,
            startIso: new Date().toISOString(),
            status: "delivered",
            text,
            title
          });

          io.stdout(`[${new Date().toISOString()}] fired ${filename} → ${provider}/${destination}\n`);
        } catch (cause) {
          io.stderr(`Handler error: ${errorMessage(cause)}\n`);
        } finally {
          inFlight.delete(filename);
        }
      };

      // Process files that already exist when the watcher starts (in
      // case external producers wrote between previous runs).
      try {
        const { readdir } = await import("node:fs/promises");
        for (const entry of await readdir(dir)) {
          if (!entry.startsWith(".")) {
            await handleFile(entry);
          }
        }
      } catch { /* dir empty / unreadable — fs.watch will handle live writes */ }

      const watcher = watch(dir, (event, filename) => {
        if (!filename) return;
        if (event === "rename" || event === "change") {
          void handleFile(filename);
        }
      });

      await waitForShutdownSignal();
      watcher.close();
      io.stdout("\n(ctrl-c — stopping)\n");
    });
}
