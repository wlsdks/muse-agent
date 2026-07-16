/**
 * Shared Notion HTTP + response-shape primitives used by BOTH the Notion
 * notes provider and the Notion tasks provider — a single source of truth
 * for the api.notion.com endpoint/version defaults, the transient-status
 * retry classification, the error-code mapping, and the page-shape value
 * extractors that were previously hand-duplicated in each provider file.
 */

export const NOTION_DEFAULT_ENDPOINT = "https://api.notion.com/v1";
export const NOTION_DEFAULT_VERSION = "2022-06-28";
export const NOTION_DEFAULT_TITLE_PROPERTY = "Name";
export const NOTION_LIST_MAX_PAGES = 10;
export const NOTION_DEFAULT_RETRIES = 2;
export const NOTION_MAX_RETRIES = 5;
export const NOTION_DEFAULT_RETRY_DELAY_MS = 250;
export const NOTION_MAX_RETRY_DELAY_MS = 30_000;
export const NOTION_MAX_ERROR_BODY_BYTES = 4 * 1024;

export interface NotionRetryOptions {
  readonly retries?: number;
  readonly baseDelayMs?: number;
}

export interface NotionRetryPolicy {
  readonly retries: number;
  readonly baseDelayMs: number;
}

/** Keep retry configuration bounded even when adapter options come from untrusted config. */
export function normalizeNotionRetryPolicy(options: NotionRetryOptions | undefined): NotionRetryPolicy {
  return {
    baseDelayMs: normalizeNonNegativeNumber(options?.baseDelayMs, NOTION_DEFAULT_RETRY_DELAY_MS, NOTION_MAX_RETRY_DELAY_MS),
    retries: normalizeNonNegativeInteger(options?.retries, NOTION_DEFAULT_RETRIES, NOTION_MAX_RETRIES)
  };
}

/**
 * Notion integration tokens must only be attached to Notion's official API
 * origin. A fetch override remains available for tests; it does not expand
 * the credential egress boundary.
 */
export function resolveNotionEndpoint(endpoint: string | undefined): string {
  const configured = endpoint ?? NOTION_DEFAULT_ENDPOINT;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("Notion endpoint must be a valid URL");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "api.notion.com" || parsed.port || parsed.pathname.replace(/\/$/u, "") !== "/v1" || parsed.search || parsed.hash) {
    throw new Error("Notion endpoint must be https://api.notion.com/v1");
  }
  return NOTION_DEFAULT_ENDPOINT;
}

/** Read a bounded Notion error body so a hostile upstream cannot exhaust memory. */
export async function readNotionErrorText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > NOTION_MAX_ERROR_BODY_BYTES) {
    return `<response body exceeds ${NOTION_MAX_ERROR_BODY_BYTES} byte limit>`;
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      size += value.byteLength;
      if (size > NOTION_MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return `<response body exceeds ${NOTION_MAX_ERROR_BODY_BYTES} byte limit>`;
      }
      chunks.push(value);
    }
  } catch {
    return `<status ${response.status}>`;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function isTransientNotionStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export function mapNotionStatus(status: number): string {
  if (status === 401 || status === 403) {
    return "NOTION_AUTH";
  }
  if (status === 404) {
    return "NOTION_NOT_FOUND";
  }
  if (status === 429) {
    return "NOTION_RATE_LIMIT";
  }
  return `HTTP_${status}`;
}

export function isRecordArray(body: unknown, key: string): readonly unknown[] {
  if (!body || typeof body !== "object") {
    return [];
  }
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

export function extractTitleString(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const titleArr = (value as { title?: unknown }).title;
  if (!Array.isArray(titleArr)) {
    return undefined;
  }
  const text = titleArr
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      const plain = (entry as { plain_text?: string }).plain_text;
      if (typeof plain === "string") {
        return plain;
      }
      const inner = (entry as { text?: { content?: string } }).text?.content;
      return typeof inner === "string" ? inner : "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(0, Math.trunc(value)));
}

function normalizeNonNegativeNumber(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(0, value));
}
