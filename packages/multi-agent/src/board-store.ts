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

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";
import { quarantineCorruptFile } from "@muse/shared";

import type { AgentTask, TaskRun, TaskStatus } from "./task-board.js";

const MAX_BOARD_FILE_BYTES = 5 * 1024 * 1024;

export function defaultBoardFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUSE_BOARD_FILE?.trim() || join(homedir(), ".muse", "agent-board.json");
}

/** Load the board's tasks. A missing or corrupt file reads as an empty board (never throws). */
export async function readBoard(file: string): Promise<AgentTask[]> {
  let raw: string;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) {
      return [];
    }
    if (stat.size > MAX_BOARD_FILE_BYTES) {
      await quarantineCorruptFile(file);
      return [];
    }
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!Array.isArray(parsed.tasks)) {
      await quarantineCorruptFile(file);
      return [];
    }
    return parsed.tasks.flatMap((task): AgentTask[] => {
      const parsedTask = parseAgentTask(task);
      return parsedTask ? [parsedTask] : [];
    });
  } catch {
    await quarantineCorruptFile(file);
    return [];
  }
}

export async function writeBoard(file: string, tasks: readonly AgentTask[]): Promise<void> {
  await withFileMutationQueue(file, () => withFileLock(file, () => writeBoardUnlocked(file, tasks)));
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
    return withFileMutationQueue(this.file, () => withFileLock(this.file, async () => {
      const next = transform(await readBoard(this.file));
      await writeBoardUnlocked(this.file, next);
      return next;
    }));
  }
}

async function writeBoardUnlocked(file: string, tasks: readonly AgentTask[]): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  await atomicWriteFile(file, `${JSON.stringify({ tasks }, null, 2)}\n`);
}

function parseAgentTask(value: unknown): AgentTask | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const title = readNonEmptyString(value.title);
  const status = isTaskStatus(value.status) ? value.status : undefined;
  const createdAt = readNonEmptyString(value.createdAt);
  const updatedAt = readNonEmptyString(value.updatedAt);
  const dependsOn = Array.isArray(value.dependsOn) && value.dependsOn.every((dependency) => typeof dependency === "string")
    ? value.dependsOn
    : undefined;
  if (!id || !title || !status || !createdAt || !updatedAt || !dependsOn) {
    return undefined;
  }
  const runs = Array.isArray(value.runs) ? value.runs.flatMap((run): TaskRun[] => {
    const parsedRun = parseTaskRun(run);
    return parsedRun ? [parsedRun] : [];
  }) : [];
  return {
    createdAt,
    dependsOn,
    id,
    runs,
    status,
    title,
    updatedAt,
    ...(typeof value.assignee === "string" ? { assignee: value.assignee } : {}),
    ...(typeof value.blockedReason === "string" ? { blockedReason: value.blockedReason } : {}),
    ...(typeof value.decomposed === "boolean" ? { decomposed: value.decomposed } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.result === "string" ? { result: value.result } : {}),
    ...(typeof value.synthesize === "boolean" ? { synthesize: value.synthesize } : {}),
    ...(typeof value.depth === "number" && Number.isSafeInteger(value.depth) && value.depth > 0 ? { depth: value.depth } : {})
  };
}

function parseTaskRun(value: unknown): TaskRun | undefined {
  if (!isRecord(value) || typeof value.at !== "string" || (value.status !== "completed" && value.status !== "failed")) {
    return undefined;
  }
  return {
    at: value.at,
    status: value.status,
    ...(typeof value.output === "string" ? { output: value.output } : {}),
    ...(typeof value.reason === "string" ? { reason: value.reason } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "todo" || value === "in_progress" || value === "review" || value === "blocked" || value === "done" || value === "failed";
}
