/**
 * Notion notes provider — talks to `api.notion.com/v1` over HTTPS.
 *
 * Lifted out of `notes-providers.ts` (1,181 LOC) so each upstream
 * adapter (Notion API / Apple Notes osascript / LocalDir filesystem)
 * lives in its own file. The shared abstractions — `NotesProvider`
 * interface, `NotesValidationError`, `NotesProviderError`, and the
 * common payload types — stay in `notes-providers.ts`.
 *
 * Maps `NotesEntry` to Notion pages. `databaseId` is required for
 * `list` and for `save` without an existing page id — Notion creates
 * pages inside a database, not free-floating. `read`, `search`, and
 * `append` work without it (read takes a page id directly; search
 * hits the workspace-wide `/v1/search`; append mutates a known page).
 *
 * Body model: each paragraph in `NotesContent.body` corresponds to
 * one Notion `paragraph` block. `read` joins child paragraph blocks
 * with `\n`; `save`/`append` split the input on `\n` into blocks.
 * Rich-text formatting is not preserved (plain text in/out) — for a
 * personal JARVIS, the simplification is worth it.
 *
 * Errors are mapped to `NotesProviderError` with codes:
 *   - `NOTION_AUTH` for 401/403
 *   - `NOTION_NOT_FOUND` for 404
 *   - `NOTION_RATE_LIMIT` for 429
 *   - `HTTP_<status>` for other non-2xx
 *   - `MISSING_DATABASE_ID` when an op requires databaseId but none was set
 */

import {
  NotesProviderError,
  NotesValidationError,
  type NotesAppendInput,
  type NotesContent,
  type NotesEntry,
  type NotesProvider,
  type NotesProviderInfo,
  type NotesSaveInput,
  type NotesSearchHit
} from "./notes-providers.js";
import {
  NOTION_DEFAULT_ENDPOINT,
  NOTION_DEFAULT_TITLE_PROPERTY,
  NOTION_DEFAULT_VERSION,
  NOTION_LIST_MAX_PAGES,
  extractTitleString,
  readArrayField,
  readBooleanField,
  isRecordArray,
  readRecordField,
  isTransientNotionStatus,
  mapNotionStatus,
  readStringField,
  toRecord
} from "./notion-shared.js";
import { sleep } from "@muse/shared";

type NotionFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface NotionNotesProviderOptions {
  readonly token: string;
  /** Database id (32-char) to scope `list` and `save` against. Required for those ops. */
  readonly databaseId?: string;
  /**
   * Property name on the Notion database that holds page titles. Defaults
   * to `Name` (Notion's default). Override if your database uses a
   * different title-property name.
   */
  readonly titleProperty?: string;
  /** API base. Defaults to `https://api.notion.com/v1`. */
  readonly endpoint?: string;
  /** `Notion-Version` header value. Defaults to a stable 2022 revision. */
  readonly notionVersion?: string;
  /** `fetch` override for tests. Defaults to the global. */
  readonly fetchImpl?: NotionFetch;
  /** Retry-with-backoff for transient 429/5xx on idempotent reads. */
  readonly retry?: { readonly retries?: number; readonly baseDelayMs?: number; readonly sleep?: (ms: number) => Promise<void> };
}

const NOTION_BLOCKS_MAX_PAGES = 10;

export class NotionNotesProvider implements NotesProvider {
  readonly id = "notion";
  private readonly token: string;
  private readonly databaseId?: string;
  private readonly titleProperty: string;
  private readonly endpoint: string;
  private readonly notionVersion: string;
  private readonly fetchImpl: NotionFetch;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: NotionNotesProviderOptions) {
    if (!options.token || options.token.trim().length === 0) {
      throw new NotesValidationError("MISSING_TOKEN", "NotionNotesProvider requires an API token");
    }
    this.token = options.token;
    this.databaseId = options.databaseId;
    this.titleProperty = options.titleProperty ?? NOTION_DEFAULT_TITLE_PROPERTY;
    this.endpoint = options.endpoint ?? NOTION_DEFAULT_ENDPOINT;
    this.notionVersion = options.notionVersion ?? NOTION_DEFAULT_VERSION;
    const fetchImpl = createNotionFetch(options.fetchImpl);
    if (!fetchImpl) {
      throw new NotesValidationError("NO_FETCH", "global fetch unavailable; pass fetchImpl");
    }
    this.fetchImpl = fetchImpl;
    this.retries = Number.isFinite(options.retry?.retries) ? Math.max(0, Math.trunc(options.retry!.retries!)) : 2;
    this.baseDelayMs = Number.isFinite(options.retry?.baseDelayMs) ? Math.max(0, options.retry!.baseDelayMs!) : 250;
    this.sleep = options.retry?.sleep ?? sleep;
  }

  describe(): NotesProviderInfo {
    return {
      description: this.databaseId
        ? `Notion pages (database: ${this.databaseId}).`
        : "Notion pages (workspace search; databaseId required for list/save).",
      displayName: "Notion",
      id: this.id,
      local: false
    };
  }

  async list(): Promise<readonly NotesEntry[]> {
    const databaseId = this.requireDatabaseId("list");
    const all: NotesEntry[] = [];
    let cursor: string | undefined;
    // Notion's `/databases/:id/query` returns at most `page_size` (capped
    // at 100) per call and signals more via `has_more` + `next_cursor`.
    // Cap pages at 10 (≈1000 entries) — a personal user with that many
    // notes likely wants the agent to search instead of listing all.
    for (let page = 0; page < NOTION_LIST_MAX_PAGES; page += 1) {
      const requestBody: Record<string, unknown> = { page_size: 100 };
      if (cursor) {
        requestBody.start_cursor = cursor;
      }
      const body = await this.request("POST", `/databases/${databaseId}/query`, requestBody, true);
      const results = isRecordArray(body, "results");
      for (const result of results) {
        const entry = parsePageSummary(result, this.id, this.titleProperty);
        if (entry) {
          all.push(entry);
        }
      }
      const hasMore = readBooleanField(body, "has_more") === true;
      const nextCursor = readStringField(body, "next_cursor");
      if (!hasMore || typeof nextCursor !== "string" || nextCursor.length === 0) {
        break;
      }
      cursor = nextCursor;
    }
    return all;
  }

  async read(id: string): Promise<NotesContent | undefined> {
    if (!id || id.trim().length === 0) {
      throw new NotesValidationError("EMPTY_ID", "NotionNotesProvider.read requires a page id");
    }
    let page: unknown;
    try {
      page = await this.request("GET", `/pages/${id}`, undefined, true);
    } catch (error) {
      if (error instanceof NotesProviderError && error.code === "NOTION_NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
    const blockResults = await this.fetchAllBlockChildren(id);
    const body = blockResults.map(extractParagraphText).filter((line) => line.length > 0).join("\n");
    const summary = parsePageSummary(page, this.id, this.titleProperty);
    if (!summary) {
      throw new NotesProviderError(this.id, "NOTION_BAD_SHAPE", `Notion page ${id} did not match expected shape`);
    }
    return {
      body,
      id: summary.id,
      providerId: summary.providerId,
      title: summary.title,
      ...(summary.folder ? { folder: summary.folder } : {}),
      ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {})
    };
  }

  async search(query: string, limit: number): Promise<readonly NotesSearchHit[]> {
    const trimmed = (query ?? "").trim();
    if (trimmed.length === 0) {
      throw new NotesValidationError("EMPTY_QUERY", "NotionNotesProvider.search requires a non-empty query");
    }
    const cap = Math.max(1, Math.min(100, Math.trunc(limit) || 20));
    const body = await this.request("POST", `/search`, {
      filter: { property: "object", value: "page" },
      page_size: cap,
      query: trimmed
    }, true);
    const results = isRecordArray(body, "results");
    return results.flatMap((result): readonly NotesSearchHit[] => {
      const summary = parsePageSummary(result, this.id, this.titleProperty);
      if (!summary) {
        return [];
      }
      return [{
        id: summary.id,
        providerId: summary.providerId,
        snippet: summary.title,
        title: summary.title
      }];
    });
  }

  async save(input: NotesSaveInput): Promise<NotesContent> {
    if (!input.title || input.title.trim().length === 0) {
      throw new NotesValidationError("EMPTY_TITLE", "NotionNotesProvider.save requires a title");
    }
    if (input.id) {
      const overwrite = input.overwrite === true;
      await this.request("PATCH", `/pages/${input.id}`, {
        properties: {
          [this.titleProperty]: { title: [{ text: { content: input.title } }] }
        }
      });
      if (overwrite) {
        await this.replaceBlocks(input.id, input.body);
      }
      const after = await this.read(input.id);
      if (!after) {
        throw new NotesProviderError(this.id, "NOTION_NOT_FOUND", `Notion page ${input.id} not readable after save`);
      }
      return after;
    }

    const databaseId = this.requireDatabaseId("save");
    const created = await this.request("POST", `/pages`, {
      children: bodyToParagraphBlocks(input.body),
      parent: { database_id: databaseId },
      properties: {
        [this.titleProperty]: { title: [{ text: { content: input.title } }] }
      }
    });
    const newId = readStringField(created, "id");
    if (!newId || newId.length === 0) {
      throw new NotesProviderError(this.id, "NOTION_BAD_SHAPE", "Notion page-create response missing id");
    }
    const after = await this.read(newId);
    if (!after) {
      throw new NotesProviderError(this.id, "NOTION_NOT_FOUND", `created Notion page ${newId} not readable`);
    }
    return after;
  }

  async append(input: NotesAppendInput): Promise<NotesContent> {
    if (!input.id || input.id.trim().length === 0) {
      throw new NotesValidationError("EMPTY_ID", "NotionNotesProvider.append requires an id");
    }
    await this.request("PATCH", `/blocks/${input.id}/children`, {
      children: bodyToParagraphBlocks(input.body)
    });
    const after = await this.read(input.id);
    if (!after) {
      throw new NotesProviderError(this.id, "NOTION_NOT_FOUND", `Notion page ${input.id} not readable after append`);
    }
    return after;
  }

  private requireDatabaseId(operation: string): string {
    if (!this.databaseId) {
      throw new NotesProviderError(
        this.id,
        "MISSING_DATABASE_ID",
        `NotionNotesProvider.${operation} requires databaseId in constructor options`
      );
    }
    return this.databaseId;
  }

  /**
   * Fetch every child block of a Notion page, paginating via `start_cursor`
   * until exhaustion or the per-page cap. Notion caps `page_size` at 100,
   * so a long page (e.g. a daily journal in one Notion page) silently
   * truncated at 100 paragraph blocks before this helper existed.
   */
  private async fetchAllBlockChildren(pageId: string): Promise<readonly unknown[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < NOTION_BLOCKS_MAX_PAGES; page += 1) {
      const url = cursor
        ? `/blocks/${pageId}/children?page_size=100&start_cursor=${encodeURIComponent(cursor)}`
        : `/blocks/${pageId}/children?page_size=100`;
      const body = await this.request("GET", url, undefined, true);
      const results = isRecordArray(body, "results");
      for (const result of results) {
        all.push(result);
      }
      const hasMore = readBooleanField(body, "has_more") === true;
      const nextCursor = readStringField(body, "next_cursor");
      if (!hasMore || typeof nextCursor !== "string" || nextCursor.length === 0) {
        break;
      }
      cursor = nextCursor;
    }
    return all;
  }

  private async replaceBlocks(pageId: string, body: string): Promise<void> {
    const blockResults = await this.fetchAllBlockChildren(pageId);
    for (const block of blockResults) {
      const blockId = readStringField(block, "id");
      if (!blockId) {
        continue;
      }
      try {
        await this.request("DELETE", `/blocks/${blockId}`, undefined);
      } catch {
        // best-effort delete; the subsequent append will just stack on top
      }
    }
    await this.request("PATCH", `/blocks/${pageId}/children`, {
      children: bodyToParagraphBlocks(body)
    });
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
    // only — a retried create/append could duplicate a page/block.
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
        throw new NotesProviderError(this.id, "FETCH_FAILED", `Notion request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (!response.ok) {
        if (attempt < maxRetries && isTransientNotionStatus(response.status)) {
          await this.sleep(this.baseDelayMs * 2 ** attempt);
          continue;
        }
        const detail = await safeReadText(response);
        const code = mapNotionStatus(response.status);
        // Forward status so callers get err.retryable for free.
        throw new NotesProviderError(
          this.id,
          code,
          `Notion ${method} ${path} → ${response.status}: ${detail.slice(0, 200)}`,
          response.status
        );
      }
      if (response.status === 204) {
        return {};
      }
      try {
        return await response.json();
      } catch (cause) {
        throw new NotesProviderError(this.id, "NOTION_BAD_JSON", `Notion response was not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
}

function parsePageSummary(
  raw: unknown,
  providerId: string,
  titleProperty: string
): NotesEntry | undefined {
  const rawRecord = toRecord(raw);
  if (!rawRecord) {
    return undefined;
  }
  const id = readStringField(rawRecord, "id");
  if (typeof id !== "string" || id.length === 0) {
    return undefined;
  }
  const properties = readRecordField(rawRecord, "properties") ?? {};
  const titleEntry = properties[titleProperty];
  const title = extractTitleString(titleEntry) ?? "(untitled)";
  const lastEdited = readStringField(rawRecord, "last_edited_time");
  const updatedAt = typeof lastEdited === "string" ? new Date(lastEdited) : undefined;
  const parent = readRecordField(rawRecord, "parent");
  const folder = readStringField(parent ?? {}, "database_id");
  return {
    id,
    providerId,
    title,
    ...(folder ? { folder } : {}),
    ...(updatedAt && !Number.isNaN(updatedAt.getTime()) ? { updatedAt } : {})
  };
}

function extractParagraphText(block: unknown): string {
  const blockRecord = toRecord(block);
  if (!blockRecord) {
    return "";
  }
  const type = readStringField(blockRecord, "type");
  if (type !== "paragraph") {
    return "";
  }
  const paragraph = readRecordField(blockRecord, "paragraph");
  const richText = readArrayField(paragraph ?? {}, "rich_text");
  if (!richText) {
    return "";
  }
  return richText
    .map((entry) => {
      const entryRecord = toRecord(entry);
      if (!entryRecord) {
        return "";
      }
      const plain = readStringField(entryRecord, "plain_text");
      if (typeof plain === "string") {
        return plain;
      }
      const innerRecord = readRecordField(entryRecord, "text");
      const inner = readStringField(innerRecord ?? {}, "content");
      return inner ?? "";
    })
    .join("");
}

function bodyToParagraphBlocks(body: string): readonly Record<string, unknown>[] {
  return body.split(/\n/u).map((line) => ({
    object: "block",
    paragraph: {
      rich_text: line.length > 0 ? [{ text: { content: line }, type: "text" }] : []
    },
    type: "paragraph"
  }));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return `<status ${response.status}>`;
  }
}

function createNotionFetch(fetchImpl?: NotionFetch): NotionFetch | undefined {
  if (fetchImpl) {
    return fetchImpl;
  }
  const globalFetch = globalThis.fetch;
  if (typeof globalFetch !== "function") {
    return undefined;
  }
  return (input, init) => globalFetch(input, init);
}
