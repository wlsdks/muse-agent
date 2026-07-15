/**
 * X-3 (slice 5a) — read-only `muse bg` surface over the background-process
 * registry. `list` shows what the agent has running/finished across turns;
 * `logs <id>` tails a process's captured output. Read-only by design (no
 * spawn/kill here) so it's safe to ship without a live model-selection
 * check; the spawn/stop tool + agent wiring is the attended follow-up.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";



import type { Command } from "commander";

import { classifyDangerousCommand } from "@muse/tools";
import {
  createNodeBackgroundSpawner,
  defaultBackgroundProcessesFile,
  pruneTerminalBackgroundProcesses,
  readBackgroundProcesses,
  reconcileBackgroundProcesses,
  spawnBackgroundProcess,
  stopBackgroundProcess,
  type BackgroundProcessRecord
} from "@muse/stores";

import { commandErrorLine } from "./format-cli-error.js";
import { waitForChildProcessResult } from "./async-promises.js";
import type { ProgramIO } from "./program.js";
import { withBestEffort } from "./async-promises.js";

export function backgroundStoreFile(): string {
  return defaultBackgroundProcessesFile();
}

/** Compact uptime for a running process, e.g. "3m", "2h", "1d". Empty for an unparseable/future start. */
export function formatUptime(startedAt: string, now: Date): string {
  const ms = now.getTime() - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) {
    return "";
  }
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes.toString()}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours.toString()}h`;
  return `${Math.floor(hours / 24).toString()}d`;
}

export function formatBackgroundProcessList(records: readonly BackgroundProcessRecord[], now: Date = new Date()): string {
  if (records.length === 0) {
    return "No background processes.";
  }
  const running = records.filter((record) => record.status === "running").length;
  const lines = [`${records.length.toString()} background process(es), ${running.toString()} running:`];
  for (const record of records) {
    let detail: string;
    if (record.status === "running") {
      const up = formatUptime(record.startedAt, now);
      detail = `pid ${record.pid.toString()}${up ? `, up ${up}` : ""}`;
    } else {
      detail = `${record.status}${record.exitCode !== undefined && record.exitCode !== null ? ` (exit ${record.exitCode.toString()})` : ""}`;
    }
    lines.push(`  ${record.id}  [${record.status}]  ${record.command}  — ${detail}`);
  }
  return lines.join("\n");
}

/** True when a process with `pid` exists. `kill(pid, 0)` sends no signal — it only probes existence. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The OS-level start-time for a live pid, or undefined if it can't be read
 * (pid gone, or `ps` unavailable). `ps -o lstart=` works on both macOS (BSD)
 * and Linux (GNU) with a stable per-process value — unlike `/proc`, which is
 * Linux-only — so it portably distinguishes "same process" from "OS reused
 * this pid for someone else" without needing to parse the date format.
 */
export async function readProcessStartTime(pid: number): Promise<string | undefined> {
  const processStartReader: ChildProcess = spawn("ps", ["-o", "lstart=", "-p", String(pid)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stderrChunks: Buffer[] = [];
  const stdoutChunks: Buffer[] = [];
  processStartReader.stdout?.on("data", (chunk) => {
    stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });
  processStartReader.stderr?.on("data", (chunk) => {
    stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  });

  try {
    await waitForChildProcessResult(processStartReader, "ps", stderrChunks);
  } catch {
    return undefined;
  }
  const value = Buffer.concat(stdoutChunks).toString("utf8").trim();
  return value.length > 0 ? value : undefined;
}

/** Last `n` lines of `text` (a single trailing newline is ignored). Returns all when n<=0 or non-finite. */
export function tailLines(text: string, n: number): string {
  if (!Number.isFinite(n) || n <= 0) {
    return text;
  }
  const lines = text.replace(/\n$/u, "").split("\n");
  return lines.slice(-n).join("\n");
}

export function registerBackgroundCommand(program: Command, io: ProgramIO): void {
  const bg = program.command("bg").description("Inspect background processes Muse has started");

  bg.command("list")
    .description("List tracked background processes (running + recently finished)")
    .option("--json", "Emit the registry as JSON (for scripts / jq)")
    .action(async (options: { readonly json?: boolean }) => {
      // Crash-recovery: a 'running' record whose PID is gone (the process
      // died while Muse was off, so its exit handler never ran) is corrected
      // to exited before display, so the list reflects reality.
      await withBestEffort(reconcileBackgroundProcesses(backgroundStoreFile(), isProcessAlive, () => new Date(), readProcessStartTime), undefined);
      const records = await readBackgroundProcesses(backgroundStoreFile());
      if (options.json) {
        io.stdout(`${JSON.stringify({ processes: records }, null, 2)}\n`);
        return;
      }
      io.stdout(`${formatBackgroundProcessList(records)}\n`);
    });

  bg.command("logs <id>")
    .description("Show the captured output of a background process by id")
    .option("--tail <n>", "Show only the last N lines (a long-running process's log can be huge)")
    .action(async (id: string, options: { readonly tail?: string }) => {
      const record = (await readBackgroundProcesses(backgroundStoreFile())).find((entry) => entry.id === id);
      if (!record) {
        io.stderr(commandErrorLine("bg logs", `No background process with id '${id}'.`));
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
      const tail = options.tail !== undefined ? Number.parseInt(options.tail, 10) : 0;
      const shown = tail > 0 ? tailLines(body, tail) : body;
      io.stdout(shown.endsWith("\n") ? shown : `${shown}\n`);
    });

  bg.command("run <command...>")
    .description("Start a long-running command in the background (survives this turn)")
    .action(async (parts: string[]) => {
      const command = parts.join(" ");
      try {
        const record = await spawnBackgroundProcess(command, {}, {
          storeFile: backgroundStoreFile(),
          spawner: createNodeBackgroundSpawner(),
          logFileFor: (id) => join(homedir(), ".muse", "bg-logs", `${id}.log`),
          now: () => new Date(),
          newId: () => `bg-${randomUUID().slice(0, 8)}`,
          classifyDanger: (cmd) => {
            const verdict = classifyDangerousCommand(cmd);
            return verdict.dangerous ? verdict.reason : undefined;
          },
          readProcessStartTime
        });
        io.stdout(`Started '${record.id}' (pid ${record.pid.toString()}). Logs: muse bg logs ${record.id}\n`);
      } catch (error) {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

  bg.command("prune")
    .description("Remove finished background processes from the registry and delete their log files")
    .action(async () => {
      const removed = await pruneTerminalBackgroundProcesses(backgroundStoreFile());
      for (const record of removed) {
        if (record.logFile) {
          await withBestEffort(fs.rm(record.logFile, { force: true }), undefined);
        }
      }
      io.stdout(`Pruned ${removed.length.toString()} finished background process(es).\n`);
    });

  bg.command("restart <id>")
    .description("Re-run a previously-started background process by id (same command + cwd)")
    .action(async (id: string) => {
      const prior = (await readBackgroundProcesses(backgroundStoreFile())).find((entry) => entry.id === id);
      if (!prior) {
        io.stderr(commandErrorLine("bg restart", `No background process with id '${id}'.`));
        return;
      }
      try {
        const record = await spawnBackgroundProcess(prior.command, prior.cwd ? { cwd: prior.cwd } : {}, {
          storeFile: backgroundStoreFile(),
          spawner: createNodeBackgroundSpawner(),
          logFileFor: (newId) => join(homedir(), ".muse", "bg-logs", `${newId}.log`),
          now: () => new Date(),
          newId: () => `bg-${randomUUID().slice(0, 8)}`,
          classifyDanger: (cmd) => {
            const verdict = classifyDangerousCommand(cmd);
            return verdict.dangerous ? verdict.reason : undefined;
          },
          readProcessStartTime
        });
        io.stdout(`Restarted '${prior.id}' as '${record.id}' (pid ${record.pid.toString()}).\n`);
      } catch (error) {
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

  bg.command("stop <id>")
    .description("Stop a running background process by id (sends SIGTERM)")
    .action(async (id: string) => {
      const result = await stopBackgroundProcess(
        backgroundStoreFile(),
        id,
        (pid) => process.kill(pid),
        () => new Date(),
        readProcessStartTime
      );
      if (result === "not_found") {
        io.stderr(commandErrorLine("bg stop", `No background process with id '${id}'.`));
      } else if (result === "already_done") {
        io.stdout(`'${id}' is not running.\n`);
      } else if (result === "pid_reused") {
        io.stdout(`'${id}' had already exited (its pid was reused by another process) — marked exited, nothing signalled.\n`);
      } else {
        io.stdout(`Stopped '${id}'.\n`);
      }
    });
}
