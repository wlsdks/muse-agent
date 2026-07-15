/**
 * File-backed agent task board (S2) — persists the Kanban board across sessions so a
 * long-running multi-agent objective survives a restart (the durability hermes/openclaw
 * get from a SQLite board; here a single JSON file, single-user). Writes are atomic
 * (tmp + fsync + rename, 0o600) so a crash mid-write never leaves a torn board. The PURE
 * board transforms (`task-board.ts`) do the logic; this only reads/persists them.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "@muse/shared";

import type { AgentTask } from "./task-board.js";

export function defaultBoardFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_BOARD_FILE?.trim() || join(homedir(), ".muse", "agent-board.json");
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid.toString()}`;
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, file);
}

/** Load the board's tasks. A missing or corrupt file reads as an empty board (never throws). */
export async function readBoard(file: string): Promise<AgentTask[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.tasks)) {
      return [];
    }
    return parsed.tasks.filter(isAgentTask);
  } catch {
    return [];
  }
}

function isAgentTask(value: unknown): value is AgentTask {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "string"
    && typeof value.title === "string"
    && Array.isArray(value.dependsOn)
    && value.dependsOn.every((dependency) => typeof dependency === "string")
    && Array.isArray(value.runs)
    && value.runs.every((run) => isTaskRun(run))
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && typeof value.status === "string"
  );
}

function isTaskRun(value: unknown): value is { readonly at: string; readonly status: "completed" | "failed"; readonly reason?: string; readonly output?: string } {
  return isRecord(value)
    && typeof value.at === "string"
    && (value.status === "completed" || value.status === "failed")
    && (value.reason === undefined || typeof value.reason === "string")
    && (value.output === undefined || typeof value.output === "string");
}

export async function writeBoard(file: string, tasks: readonly AgentTask[]): Promise<void> {
  await atomicWrite(file, `${JSON.stringify({ tasks }, null, 2)}\n`);
}

/**
 * Thin persistence wrapper: `mutate` applies a PURE board transform (from task-board.ts)
 * to the current persisted board and writes the result back, returning it. The single
 * read-modify-write seam every board mutation (CLI, dispatcher) goes through.
 */
export class FileAgentTaskBoard {
  constructor(private readonly file: string = defaultBoardFile()) {}

  async list(): Promise<AgentTask[]> {
    return readBoard(this.file);
  }

  async mutate(transform: (tasks: readonly AgentTask[]) => AgentTask[]): Promise<AgentTask[]> {
    const next = transform(await readBoard(this.file));
    await writeBoard(this.file, next);
    return next;
  }
}
