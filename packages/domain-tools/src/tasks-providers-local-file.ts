import { errorMessage } from "@muse/shared";
import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";
/**
 * Filesystem-backed tasks provider — same on-disk JSON shape as
 * the inline `createTasksMcpServer` in `loopback-tasks.ts`
 * (`{ tasks: PersistedTask[] }` with atomic-rename writes).
 *
 * Lifted out of the inline server to live behind the
 * `TasksProvider` interface so it slots into the new
 * `TasksProviderRegistry` alongside the upcoming
 * `AppleRemindersProvider` + `NotionTasksProvider`. The inline
 * `muse.tasks` MCP server stays as the default no-config surface;
 * this provider adds the same backend behind the registry-aware
 * path that future per-backend factories will compose.
 *
 * Behavior parity with the inline server:
 *   - Missing or unparseable file is treated as empty (so a fresh
 *     install never throws)
 *   - Writes are atomic (`tmp` → rename) so crash mid-write doesn't
 *     leave a half-written file
 *   - `add` always lands at the end of the file (newest by
 *     createdAt)
 *   - `list` returns newest-first (createdAt descending)
 *   - `complete` is idempotent — completing an already-done task
 *     leaves the existing `completedAt` untouched
 *   - `search` does case-insensitive substring match on title +
 *     notes; returns the matching field as `snippet`
 */

import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { dirname } from "node:path";

import {
  TasksProviderError,
  TasksValidationError,
  type Task,
  type TaskInput,
  type TaskSearchHit,
  type TasksProvider,
  type TasksProviderInfo
} from "./tasks-providers.js";
import { readTasks as readStoredTasks } from "@muse/stores";

export interface LocalFileTasksProviderOptions {
  readonly file: string;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
  readonly maxListEntries?: number;
}

interface PersistedTask {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export class LocalFileTasksProvider implements TasksProvider {
  readonly id = "local";
  private readonly file: string;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly maxListEntries: number;

  constructor(options: LocalFileTasksProviderOptions) {
    if (!options.file || options.file.trim().length === 0) {
      throw new TasksValidationError("MISSING_FILE", "LocalFileTasksProvider requires a file path");
    }
    this.file = options.file;
    this.idFactory = options.idFactory ?? (() => `task_${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
    this.maxListEntries = normalizeListLimit(options.maxListEntries);
  }

  describe(): TasksProviderInfo {
    return {
      description: `Filesystem-backed personal todo list (${this.file}).`,
      displayName: "Local file",
      id: this.id,
      local: true
    };
  }

  async list(status: "open" | "done" | "all" = "open"): Promise<readonly Task[]> {
    const tasks = await this.readTasks();
    const filtered = tasks
      .filter((task) => status === "all" || task.status === status)
      .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""))
      .slice(0, this.maxListEntries);
    return filtered.map((task) => this.toTask(task));
  }

  async add(input: TaskInput): Promise<Task> {
    const title = input.title?.trim();
    if (!title) {
      throw new TasksValidationError("EMPTY_TITLE", "TaskInput.title must not be empty");
    }
    const created: PersistedTask = {
      createdAt: this.now().toISOString(),
      id: this.idFactory(),
      status: "open",
      title,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {})
    };
    try {
      await this.mutateTasks(async () => {
        const tasks = await this.readTasks();
        await this.writeTasks([...tasks, created]);
      });
    } catch (error) {
      throw new TasksProviderError(this.id, "WRITE_FAILED", this.errorMessage(error));
    }
    return this.toTask(created);
  }

  async complete(id: string): Promise<Task | undefined> {
    if (!id || id.trim().length === 0) {
      throw new TasksValidationError("EMPTY_ID", "TasksProvider.complete requires a non-empty id");
    }
    try {
      return await this.mutateTasks(async () => {
        const tasks = await this.readTasks();
        const target = tasks.find((task) => task.id === id);
        if (!target) {
          return undefined;
        }
        if (target.status === "done") {
          return this.toTask(target);
        }
        const updated: PersistedTask = {
          ...target,
          completedAt: this.now().toISOString(),
          status: "done"
        };
        await this.writeTasks(tasks.map((task) => (task.id === id ? updated : task)));
        return this.toTask(updated);
      });
    } catch (error) {
      throw new TasksProviderError(this.id, "WRITE_FAILED", this.errorMessage(error));
    }
  }

  async search(query: string, limit: number): Promise<readonly TaskSearchHit[]> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length === 0) {
      throw new TasksValidationError("EMPTY_QUERY", "TasksProvider.search requires a non-empty query");
    }
    const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 20));
    const needle = trimmed.toLowerCase();
    const tasks = await this.readTasks();
    const hits: TaskSearchHit[] = [];
    for (const task of tasks) {
      if (hits.length >= cap) {
        break;
      }
      const titleMatch = task.title.toLowerCase().includes(needle);
      const notesMatch = task.notes ? task.notes.toLowerCase().includes(needle) : false;
      if (!titleMatch && !notesMatch) {
        continue;
      }
      hits.push({
        id: task.id,
        providerId: this.id,
        status: task.status,
        title: task.title,
        ...(notesMatch && task.notes ? { snippet: task.notes } : {})
      });
    }
    return hits;
  }

  private async readTasks(): Promise<readonly PersistedTask[]> {
    return readStoredTasks(this.file);
  }

  private async writeTasks(tasks: readonly PersistedTask[]): Promise<void> {
    const payload = `${JSON.stringify({ tasks }, null, 2)}\n`;
    await fs.mkdir(dirname(this.file), { recursive: true });
    await atomicWriteFile(this.file, payload);
  }

  private toTask(persisted: PersistedTask): Task {
    return {
      createdAt: new Date(persisted.createdAt),
      id: persisted.id,
      providerId: this.id,
      status: persisted.status,
      title: persisted.title,
      ...(persisted.completedAt ? { completedAt: new Date(persisted.completedAt) } : {}),
      ...(persisted.notes ? { notes: persisted.notes } : {}),
      ...(persisted.tags && persisted.tags.length > 0 ? { tags: [...persisted.tags] } : {})
    };
  }

  private errorMessage(error: unknown): string {
    return errorMessage(error);
  }

  private async mutateTasks<T>(operation: () => Promise<T>): Promise<T> {
    const parent = dirname(this.file);
    await fs.mkdir(parent, { recursive: true });
    await fs.access(parent, fsConstants.W_OK);
    return withFileMutationQueue(this.file, () => withFileLock(this.file, operation));
  }
}

function normalizeListLimit(value: number | undefined): number {
  const resolved = value ?? 200;
  if (!Number.isFinite(resolved)) {
    throw new TasksValidationError("INVALID_LIST_LIMIT", "maxListEntries must be finite");
  }
  return Math.max(1, Math.trunc(resolved));
}

function isPersistedTask(value: unknown): value is PersistedTask {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as PersistedTask).id === "string"
    && typeof (value as PersistedTask).title === "string"
    && typeof (value as PersistedTask).createdAt === "string"
    && ((value as PersistedTask).status === "open" || (value as PersistedTask).status === "done");
}
