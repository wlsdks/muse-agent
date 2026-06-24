/**
 * X-3 (slice 5a) — read-only `muse bg` surface over the background-process
 * registry. `list` shows what the agent has running/finished across turns;
 * `logs <id>` tails a process's captured output. Read-only by design (no
 * spawn/kill here) so it's safe to ship without a live model-selection
 * check; the spawn/stop tool + agent wiring is the attended follow-up.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Command } from "commander";

import { readBackgroundProcesses, type BackgroundProcessRecord } from "@muse/stores";

import type { ProgramIO } from "./program.js";

export function backgroundStoreFile(): string {
  return process.env.MUSE_BACKGROUND_PROCESSES_FILE ?? join(homedir(), ".muse", "background-processes.json");
}

export function formatBackgroundProcessList(records: readonly BackgroundProcessRecord[]): string {
  if (records.length === 0) {
    return "No background processes.";
  }
  const running = records.filter((record) => record.status === "running").length;
  const lines = [`${records.length.toString()} background process(es), ${running.toString()} running:`];
  for (const record of records) {
    const detail =
      record.status === "running"
        ? `pid ${record.pid.toString()}`
        : `${record.status}${record.exitCode !== undefined && record.exitCode !== null ? ` (exit ${record.exitCode.toString()})` : ""}`;
    lines.push(`  ${record.id}  [${record.status}]  ${record.command}  — ${detail}`);
  }
  return lines.join("\n");
}

export function registerBackgroundCommand(program: Command, io: ProgramIO): void {
  const bg = program.command("bg").description("Inspect background processes Muse has started");

  bg.command("list")
    .description("List tracked background processes (running + recently finished)")
    .action(async () => {
      const records = await readBackgroundProcesses(backgroundStoreFile());
      io.stdout(`${formatBackgroundProcessList(records)}\n`);
    });

  bg.command("logs <id>")
    .description("Show the captured output of a background process by id")
    .action(async (id: string) => {
      const record = (await readBackgroundProcesses(backgroundStoreFile())).find((entry) => entry.id === id);
      if (!record) {
        io.stderr(`No background process with id '${id}'.\n`);
        return;
      }
      if (!record.logFile) {
        io.stdout("(no log file recorded for this process)\n");
        return;
      }
      let body: string;
      try {
        body = await fs.readFile(record.logFile, "utf8");
      } catch {
        io.stderr(`Could not read log file ${record.logFile}.\n`);
        return;
      }
      io.stdout(body.endsWith("\n") ? body : `${body}\n`);
    });
}
