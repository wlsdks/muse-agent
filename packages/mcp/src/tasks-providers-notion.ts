/**
 * Notion tasks provider — talks to `api.notion.com/v1` over HTTPS.
 * Parallels the `NotionNotesProvider` for the tasks domain.
 *
 * Maps `Task` to a row in a Notion database. Required: `databaseId` —
 * unlike notes, tasks are inherently row-shaped, so a free-floating
 * page mode does not exist. The database needs at minimum:
 *   - A `title` property (default name "Name", overridable via
 *     `titleProperty`).
 *   - A `select` property for status (default name "Status",
 *     overridable via `statusProperty`). Default option names are
 *     `Open` / `Done` (overridable via `statusOpenValue` /
 *     `statusDoneValue`).
 *
 * `notes` and `tags` from `TaskInput` are dropped on writes — the
 * v1 adapter is intentionally focused (mirrors how Apple Reminders
 * drops `tags`). A future iter can wire `notes` to a `rich_text`
 * property and `tags` to a `multi_select` once the column-mapping
 * surface is exercised.
 *
 * Errors map to `TasksProviderError` with codes:
 *   - `NOTION_AUTH` for 401/403
 *   - `NOTION_NOT_FOUND` for 404
 *   - `NOTION_RATE_LIMIT` for 429
 *   - `HTTP_<status>` for other non-2xx
 *   - `NOTION_BAD_SHAPE` / `NOTION_BAD_JSON` for malformed responses
 *   - `FETCH_FAILED` when the underlying fetch rejects
 */

import {
  TasksProviderError,
  TasksValidationError,
  type Task,
  type TaskInput,
  type TaskSearchHit,
  type TasksProvider,
  type TasksProviderInfo
} from "./tasks-providers.js";
import {
  NOTION_DEFAULT_ENDPOINT,
  NOTION_DEFAULT_TITLE_PROPERTY,
  NOTION_DEFAULT_VERSION,
  NOTION_LIST_MAX_PAGES,
  extractTitleString,
  isRecordArray,
  isTransientNotionStatus,
  mapNotionStatus
} from "./notion-shared.js";

type NotionFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface NotionTasksProviderOptions {
  readonly token: string;
  readonly databaseId: string;
  /** Title-property name. Defaults to `Name` (Notion's default). */
  readonly titleProperty?: string;
  /** Select-property name holding the open/done state. Defaults to `Status`. */
  readonly statusProperty?: string;
  /** Select-option name representing an open task. Defaults to `Open`. */
  readonly statusOpenValue?: string;
  /** Select-option name representing a completed task. Defaults to `Done`. */
  readonly statusDoneValue?: string;
  /** API base. Defaults to `https://api.notion.com/v1`. */
  readonly endpoint?: string;
  /** `Notion-Version` header value. Defaults to a stable 2022 revision. */
  readonly notionVersion?: string;
  /** `fetch` override for tests. Defaults to the global. */
  readonly fetchImpl?: NotionFetch;
  /** Retry-with-backoff for transient 429/5xx on idempotent reads. */
  readonly retry?: { readonly retries?: number; readonly baseDelayMs?: number; readonly sleep?: (ms: number) => Promise<void> };
}

const NOTION_DEFAULT_STATUS_PROPERTY = "Status";
const NOTION_DEFAULT_STATUS_OPEN = "Open";
const NOTION_DEFAULT_STATUS_DONE = "Done";

export class NotionTasksProvider implements TasksProvider {
  readonly id = "notion";
  private readonly token: string;
  private readonly databaseId: string;
  private readonly titleProperty: string;
  private readonly statusProperty: string;
  private readonly statusOpenValue: string;
  private readonly statusDoneValue: string;
  private readonly endpoint: string;
  private readonly notionVersion: string;
  private readonly fetchImpl: NotionFetch;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: NotionTasksProviderOptions) {
    if (!options.token || options.token.trim().length === 0) {
      throw new TasksValidationError("MISSING_TOKEN", "NotionTasksProvider requires an API token");
    }
    if (!options.databaseId || options.databaseId.trim().length === 0) {
      throw new TasksValidationError("MISSING_DATABASE_ID", "NotionTasksProvider requires a databaseId");
    }
    this.token = options.token;
    this.databaseId = options.databaseId;
    this.titleProperty = options.titleProperty ?? NOTION_DEFAULT_TITLE_PROPERTY;
    this.statusProperty = options.statusProperty ?? NOTION_DEFAULT_STATUS_PROPERTY;
    this.statusOpenValue = options.statusOpenValue ?? NOTION_DEFAULT_STATUS_OPEN;
    this.statusDoneValue = options.statusDoneValue ?? NOTION_DEFAULT_STATUS_DONE;
    this.endpoint = options.endpoint ?? NOTION_DEFAULT_ENDPOINT;
    this.notionVersion = options.notionVersion ?? NOTION_DEFAULT_VERSION;
    const globalFetch = (globalThis as { fetch?: NotionFetch }).fetch;
    this.fetchImpl = options.fetchImpl ?? (globalFetch as NotionFetch);
    if (!this.fetchImpl) {
      throw new TasksValidationError("NO_FETCH", "global fetch unavailable; pass fetchImpl");
    }
    this.retries = Number.isFinite(options.retry?.retries) ? Math.max(0, Math.trunc(options.retry!.retries!)) : 2;
    this.baseDelayMs = Number.isFinite(options.retry?.baseDelayMs) ? Math.max(0, options.retry!.baseDelayMs!) : 250;
    this.sleep = options.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  describe(): TasksProviderInfo {
    return {
      description: `Notion database tasks (database: ${this.databaseId}).`,
      displayName: "Notion Tasks",
      id: this.id,
      local: false
    };
  }

  async list(status: "open" | "done" | "all" = "all"): Promise<readonly Task[]> {
    const all: Task[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < NOTION_LIST_MAX_PAGES; page += 1) {
      const requestBody: Record<string, unknown> = { page_size: 100 };
      if (cursor) {
        requestBody.start_cursor = cursor;
      }
      if (status !== "all") {
        requestBody.filter = this.statusFilter(status);
      }
      const body = await this.request("POST", `/databases/${this.databaseId}/query`, requestBody, true);
      const results = isRecordArray(body, "results");
      for (const result of results) {
        const task = this.parseTask(result);
        if (task) {
          all.push(task);
        }
      }
      const hasMore = (body as { has_more?: unknown }).has_more === true;
      const nextCursor = (body as { next_cursor?: unknown }).next_cursor;
      if (!hasMore || typeof nextCursor !== "string" || nextCursor.length === 0) {
        break;
      }
      cursor = nextCursor;
    }
    return all;
  }

  async add(input: TaskInput): Promise<Task> {
    if (!input.title || input.title.trim().length === 0) {
      throw new TasksValidationError("EMPTY_TITLE", "NotionTasksProvider.add requires a non-empty title");
    }
    const created = await this.request("POST", `/pages`, {
      parent: { database_id: this.databaseId },
      properties: {
        [this.titleProperty]: { title: [{ text: { content: input.title } }] },
        [this.statusProperty]: { select: { name: this.statusOpenValue } }
      }
    });
    const task = this.parseTask(created);
    if (!task) {
      throw new TasksProviderError(this.id, "NOTION_BAD_SHAPE", "Notion page-create response did not match expected shape");
    }
    return task;
  }

  async complete(id: string): Promise<Task | undefined> {
    if (!id || id.trim().length === 0) {
      throw new TasksValidationError("EMPTY_ID", "NotionTasksProvider.complete requires a page id");
    }
    let updated: unknown;
    try {
      updated = await this.request("PATCH", `/pages/${id}`, {
        properties: {
          [this.statusProperty]: { select: { name: this.statusDoneValue } }
        }
      });
    } catch (error) {
      if (error instanceof TasksProviderError && error.code === "NOTION_NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
    const task = this.parseTask(updated);
    return task ?? undefined;
  }

  async search(query: string, limit: number): Promise<readonly TaskSearchHit[]> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length === 0) {
      throw new TasksValidationError("EMPTY_QUERY", "NotionTasksProvider.search requires a non-empty query");
    }
    const cap = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const body = await this.request("POST", `/search`, {
      filter: { property: "object", value: "page" },
      page_size: cap,
      query: trimmed
    }, true);
    const results = isRecordArray(body, "results");
    return results.flatMap((result): readonly TaskSearchHit[] => {
      const parent = (result as { parent?: { database_id?: string } }).parent;
      if (parent?.database_id !== this.databaseId) {
        // Notion's /search is workspace-wide; only surface hits that
        // belong to the configured tasks database so unrelated pages
        // never show up as task results.
        return [];
      }
      const task = this.parseTask(result);
      if (!task) {
        return [];
      }
      return [{
        id: task.id,
        providerId: task.providerId,
        snippet: task.title,
        status: task.status,
        title: task.title
      }];
    });
  }

  private statusFilter(status: "open" | "done"): Record<string, unknown> {
    return {
      property: this.statusProperty,
      select: { equals: status === "open" ? this.statusOpenValue : this.statusDoneValue }
    };
  }

  private parseTask(raw: unknown): Task | undefined {
    if (!raw || typeof raw !== "object") {
      return undefined;
    }
    const id = (raw as { id?: string }).id;
    if (typeof id !== "string" || id.length === 0) {
      return undefined;
    }
    const properties = (raw as { properties?: Record<string, unknown> }).properties ?? {};
    const title = extractTitleString(properties[this.titleProperty]) ?? "(untitled)";
    const statusName = extractSelectName(properties[this.statusProperty]);
    const status: "open" | "done" = statusName === this.statusDoneValue ? "done" : "open";
    const createdRaw = (raw as { created_time?: string }).created_time;
    const createdAt = parseDate(createdRaw) ?? new Date();
    const completedAt = status === "done"
      ? parseDate((raw as { last_edited_time?: string }).last_edited_time)
      : undefined;
    return {
      createdAt,
      id,
      providerId: this.id,
      status,
      title,
      ...(completedAt ? { completedAt } : {})
    };
  }

  private async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: unknown,
    retriable = false
  ): Promise<unknown> {
    const url = `${this.endpoint}${path}`;
    const init: RequestInit = {
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "Notion-Version": this.notionVersion
      },
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    };
    // Retry transient 429 (Notion rate-limit) / 5xx on idempotent reads
    // only — a retried create/update could duplicate or double-apply.
    const maxRetries = retriable ? this.retries : 0;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, init);
      } catch (cause) {
        if (attempt < maxRetries) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        throw new TasksProviderError(
          this.id,
          "FETCH_FAILED",
          `Notion request failed: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
      if (!response.ok) {
        if (attempt < maxRetries && isTransientNotionStatus(response.status)) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        const detail = await safeReadText(response);
        const code = mapNotionStatus(response.status);
        throw new TasksProviderError(
          this.id,
          code,
          `Notion ${method} ${path} → ${response.status}: ${detail.slice(0, 200)}`
        );
      }
      if (response.status === 204) {
        return {};
      }
      try {
        return await response.json();
      } catch (cause) {
        throw new TasksProviderError(
          this.id,
          "NOTION_BAD_JSON",
          `Notion response was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
    }
  }
}

function extractSelectName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const select = (value as { select?: { name?: unknown } }).select;
  if (!select || typeof select !== "object") {
    return undefined;
  }
  return typeof select.name === "string" ? select.name : undefined;
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return `<status ${response.status}>`;
  }
}
