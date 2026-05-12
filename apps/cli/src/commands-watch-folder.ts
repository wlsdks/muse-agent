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
 *   1. Read the file (text only, max 10 KB — bigger payloads are
 *      truncated). Binary blobs are ignored.
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
  resolveProactiveHistoryFile,
  resolveTasksFile
} from "@muse/autoconfigure";
import { appendProactiveHistory, parseTaskDueAt, readTasks, writeTasks, type PersistedTask } from "@muse/mcp";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

const MAX_PREVIEW_BYTES = 10 * 1024;

interface WatchOptions {
  readonly path?: string;
  readonly provider?: string;
  readonly destination?: string;
  readonly asTask?: boolean;
  readonly defaultLeadMinutes?: string;
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
function extractDueHint(body: string): string | undefined {
  const lines = body.split("\n").slice(0, 8);
  for (const line of lines) {
    const m = /^\s*(?:due|마감|deadline)\s*[:\-]\s*(.+)$/i.exec(line.trim());
    if (m && m[1]) {
      return m[1].trim();
    }
  }
  return undefined;
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
    .action(async (options: WatchOptions) => {
      const dir = options.path ?? join(homedir(), ".muse", "inbox");
      const processedDir = join(dir, ".processed");
      const provider = options.provider ?? "log";
      const destination = options.destination ?? "@me";
      const asTask = options.asTask === true;
      const defaultLead = Math.max(1, Number.parseInt(options.defaultLeadMinutes ?? "60", 10) || 60);
      const tasksFile = asTask ? resolveTasksFile(process.env as Record<string, string | undefined>) : undefined;

      await mkdir(dir, { recursive: true });
      await mkdir(processedDir, { recursive: true });

      const registry = buildMessagingRegistry(process.env as Record<string, string | undefined>);
      if (!registry.has(provider)) {
        io.stderr(`Provider '${provider}' is not registered. Try --provider log.\n`);
        process.exitCode = 1;
        return;
      }
      const historyFile = resolveProactiveHistoryFile(process.env as Record<string, string | undefined>);

      io.stdout(`muse watch-folder — watching ${dir}\n`);
      io.stdout(`  provider=${provider}, destination=${destination}\n`);
      if (asTask) {
        io.stdout(`  as-task: ON (each file also becomes an open task in ${tasksFile!})\n`);
      }
      io.stdout(`  (Drop any text file here to fire a notice. Ctrl-C to stop.)\n\n`);

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

          let raw = "";
          try {
            const buffer = await readFile(full);
            raw = buffer.subarray(0, MAX_PREVIEW_BYTES).toString("utf8");
          } catch (cause) {
            io.stderr(`Failed to read ${filename}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            return;
          }

          const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "(empty)";
          const title = basename(filename, extname(filename));
          const text = `📥 ${title}: ${firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine}`;

          await registry.send(provider, { destination, text });

          // --as-task path: also create a tracked task so the
          // proactive daemon later fires its own reminder for the
          // imminent dueAt. The inbox file becomes a first-class
          // task that participates in done/snooze/dismiss flows.
          if (asTask && tasksFile) {
            try {
              const hint = extractDueHint(raw);
              let dueAt: string | undefined;
              if (hint) {
                const parsed = parseTaskDueAt(hint, () => new Date());
                if (parsed instanceof Error) {
                  dueAt = undefined;
                } else {
                  dueAt = parsed;
                }
              }
              if (!dueAt) {
                dueAt = new Date(Date.now() + defaultLead * 60_000).toISOString();
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
              const existing = await readTasks(tasksFile);
              await writeTasks(tasksFile, [...existing, task]);
              io.stdout(`  + task created: ${task.id} (dueAt ${dueAt})\n`);
            } catch (cause) {
              io.stderr(`  task-create failed for ${filename}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            }
          }

          // Archive so the next fs.watch event doesn't re-trigger.
          const archived = join(processedDir, `${Date.now().toString()}-${filename}`);
          try {
            await rename(full, archived);
          } catch (cause) {
            io.stderr(`Failed to archive ${filename}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
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
          io.stderr(`Handler error: ${cause instanceof Error ? cause.message : String(cause)}\n`);
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

      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        watcher.close();
        io.stdout("\n(ctrl-c — stopping)\n");
        process.exit(0);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);

      // Block the event loop so the watcher keeps running.
      await new Promise(() => { /* never resolves */ });
    });
}
