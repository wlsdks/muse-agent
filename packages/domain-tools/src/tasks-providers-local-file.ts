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
import { promises as fs } from "node:fs";
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
    this.maxListEntries = Math.max(1, Math.trunc(options.maxListEntries ?? 200));
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
    const tasks = await this.readTasks();
    const created: PersistedTask = {
      createdAt: this.now().toISOString(),
      id: this.idFactory(),
      status: "open",
      title,
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {})
    };
    try {
      await this.writeTasks([...tasks, created]);
    } catch (error) {
      throw new TasksProviderError(this.id, "WRITE_FAILED", this.errorMessage(error));
    }
    return this.toTask(created);
  }

  async complete(id: string): Promise<Task | undefined> {
    if (!id || id.trim().length === 0) {
      throw new TasksValidationError("EMPTY_ID", "TasksProvider.complete requires a non-empty id");
    }
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
    const next = tasks.map((task) => (task.id === id ? updated : task));
    try {
      await this.writeTasks(next);
    } catch (error) {
      throw new TasksProviderError(this.id, "WRITE_FAILED", this.errorMessage(error));
    }
    return this.toTask(updated);
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
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { tasks?: unknown }).tasks)) {
      return [];
    }
    // Use Array#filter with a type predicate so TypeScript narrows the
    // result to PersistedTask[] without the verbose flatMap-with-empty-arr
    // workaround. Same idiom that `LocalDirNotesProvider.list` could use.
    return (parsed as { tasks: unknown[] }).tasks.filter(isPersistedTask);
  }

  private async writeTasks(tasks: readonly PersistedTask[]): Promise<void> {
    const payload = `${JSON.stringify({ tasks }, null, 2)}\n`;
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    await fs.mkdir(dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, this.file);
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
    return error instanceof Error ? error.message : String(error);
  }
}

function isPersistedTask(value: unknown): value is PersistedTask {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as PersistedTask).id === "string"
    && typeof (value as PersistedTask).title === "string"
    && typeof (value as PersistedTask).createdAt === "string"
    && ((value as PersistedTask).status === "open" || (value as PersistedTask).status === "done");
}
