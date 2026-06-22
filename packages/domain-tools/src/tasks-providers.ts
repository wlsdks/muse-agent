/**
 * Provider-neutral tasks abstraction (mirrors `notes-providers.ts`).
 *
 * introduces a registry over the personal-todo surface so
 * future iterations can wire macOS Reminders.app (osascript) and
 * Notion DB next to the existing single-file backend without
 * rewriting `createTasksMcpServer`. The inline filesystem-only
 * `muse.tasks.*` MCP server in `loopback-tasks.ts` continues to
 * coexist; this abstraction adds a parallel registry-aware path.
 *
 * Three concrete adapters land in their own per-provider files:
 *   - `LocalFileTasksProvider`   → `tasks-providers-local-file.ts`
 *   - `AppleRemindersProvider`   → `tasks-providers-apple.ts`
 *   - `NotionTasksProvider`      → `tasks-providers-notion.ts`
 *
 * They are re-exported at the bottom of this file so external
 * `import { LocalFileTasksProvider } from "@muse/mcp"` call sites
 * stay byte-identical.
 *
 * Design rules:
 *   - `id` is provider-scoped. Cross-provider operations include
 *     `providerId`.
 *   - Failure: providers throw `TasksProviderError` for upstream
 *     failures. Validation errors throw `TasksValidationError`.
 *   - Status semantics: tasks are `"open"` until completed (via
 *     `complete(id)`), at which point they become `"done"` with a
 *     `completedAt` timestamp.
 */

import { isPrimarySentinel } from "@muse/mcp";

export interface Task {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly createdAt: Date;
  readonly completedAt?: Date;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export interface TaskInput {
  readonly title: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export interface TaskSearchHit {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly status: "open" | "done";
  readonly snippet?: string;
}

export interface TasksProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
}

export interface TasksProvider {
  readonly id: string;
  describe(): TasksProviderInfo;
  list(status?: "open" | "done" | "all"): Promise<readonly Task[]>;
  add(input: TaskInput): Promise<Task>;
  complete(id: string): Promise<Task | undefined>;
  search(query: string, limit: number): Promise<readonly TaskSearchHit[]>;
}

export class TasksValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "TasksValidationError";
    this.code = code;
  }
}

export class TasksProviderError extends Error {
  readonly providerId: string;
  readonly code: string;

  constructor(providerId: string, code: string, message: string) {
    super(message);
    this.name = "TasksProviderError";
    this.providerId = providerId;
    this.code = code;
  }
}

export class TasksProviderRegistry {
  private readonly providers = new Map<string, TasksProvider>();

  constructor(providers: Iterable<TasksProvider> = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: TasksProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): readonly TasksProvider[] {
    return [...this.providers.values()];
  }

  describe(): readonly TasksProviderInfo[] {
    return this.list().map((provider) => provider.describe());
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  primary(): TasksProvider | undefined {
    return this.list()[0];
  }

  require(providerId: string): TasksProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new TasksProviderError(
        providerId,
        "PROVIDER_NOT_FOUND",
        `Tasks provider not registered: ${providerId}${registeredHint([...this.providers.keys()])}`
      );
    }
    return provider;
  }

  requireOrPrimary(providerId: string | undefined): TasksProvider {
    const trimmed = providerId?.trim();
    if (trimmed && !isPrimarySentinel(trimmed)) {
      return this.require(trimmed);
    }
    const primary = this.primary();
    if (!primary) {
      throw new TasksProviderError("", "NO_PROVIDERS", "No tasks provider is registered");
    }
    return primary;
  }
}

function registeredHint(ids: readonly string[]): string {
  return ids.length > 0 ? ` (registered: ${ids.join(", ")})` : " (none registered)";
}

// LocalFile adapter is in its own file. Re-export so
// external `import { LocalFileTasksProvider } from "@muse/mcp"`
// stays byte-identical.
export { LocalFileTasksProvider } from "./tasks-providers-local-file.js";
export type { LocalFileTasksProviderOptions } from "./tasks-providers-local-file.js";

// Apple Reminders adapter is in its own file.
export { AppleRemindersProvider } from "./tasks-providers-apple.js";
export type { AppleRemindersProviderOptions } from "./tasks-providers-apple.js";

// Notion DB adapter — talks to api.notion.com/v1.
export { NotionTasksProvider } from "./tasks-providers-notion.js";
export type { NotionTasksProviderOptions } from "./tasks-providers-notion.js";
