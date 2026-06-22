/**
 * Provider-neutral notes abstraction (mirrors @muse/calendar).
 *
 * This file holds the abstraction layer only — `NotesProvider`
 * interface, the common payload types, the validation/upstream
 * error classes, and the `NotesProviderRegistry`. The three concrete
 * adapters live in their own per-provider files:
 *
 *   - `LocalDirNotesProvider` → `notes-providers-local.ts`
 *   - `AppleNotesProvider`    → `notes-providers-apple.ts`
 *   - `NotionNotesProvider`   → `notes-providers-notion.ts`
 *
 * They are re-exported at the bottom of this file so existing
 * `import { LocalDirNotesProvider } from "@muse/mcp/.../notes-providers"`
 * call-sites stay byte-identical.
 *
 * Design rules:
 *   - `id` is provider-scoped. Cross-provider operations include
 *     `providerId`.
 *   - Failure: providers throw `NotesProviderError` for upstream
 *     failures. Validation errors throw `NotesValidationError`.
 */

import { isPrimarySentinel } from "@muse/mcp";

export interface NotesEntry {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly folder?: string;
  readonly sizeBytes?: number;
  readonly updatedAt?: Date;
}

export interface NotesContent {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly body: string;
  readonly folder?: string;
  readonly updatedAt?: Date;
}

export interface NotesSearchHit {
  readonly id: string;
  readonly providerId: string;
  readonly title: string;
  readonly snippet: string;
  readonly score?: number;
  readonly line?: number;
}

export interface NotesSaveInput {
  readonly id?: string;
  readonly title: string;
  readonly body: string;
  readonly folder?: string;
  readonly overwrite?: boolean;
}

export interface NotesAppendInput {
  readonly id: string;
  readonly body: string;
}

export interface NotesProviderInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly local: boolean;
}

export interface NotesProvider {
  readonly id: string;
  describe(): NotesProviderInfo;
  list(folder?: string): Promise<readonly NotesEntry[]>;
  read(id: string): Promise<NotesContent | undefined>;
  search(query: string, limit: number): Promise<readonly NotesSearchHit[]>;
  save(input: NotesSaveInput): Promise<NotesContent>;
  append(input: NotesAppendInput): Promise<NotesContent>;
  /**
   * Remove a note by id. Returns `true` when a note was deleted,
   * `false` when none matched the id. Optional — a provider that
   * can't delete (or hasn't implemented it) leaves it undefined, and
   * the caller reports "delete not supported" rather than failing
   * silently.
   */
  delete?(id: string): Promise<boolean>;
}

export class NotesValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotesValidationError";
    this.code = code;
  }
}

/**
 * Classify an HTTP status from a notes provider
 * (today only Notion) as retryable. Mirrors the shared
 * retryable-status contract:
 *
 *   - 5xx: server-side failure, transient.
 *   - 429: Notion's rate limit (with Retry-After header).
 *
 * Anything else (401 / 403 / 404 / 422) fails fast — bad token,
 * missing page, malformed body. Local + Apple Notes providers
 * never construct with a `status`, so they always land on
 * `retryable: false`.
 */
export function isRetryableNotesStatus(status: number | undefined): boolean {
  if (status === undefined || !Number.isFinite(status)) return false;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

export class NotesProviderError extends Error {
  readonly providerId: string;
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(providerId: string, code: string, message: string, status?: number) {
    super(message);
    this.name = "NotesProviderError";
    this.providerId = providerId;
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
    this.retryable = isRetryableNotesStatus(status);
  }
}

export class NotesProviderRegistry {
  private readonly providers = new Map<string, NotesProvider>();

  constructor(providers: Iterable<NotesProvider> = []) {
    for (const provider of providers) {
      this.register(provider);
    }
  }

  register(provider: NotesProvider): void {
    this.providers.set(provider.id, provider);
  }

  list(): readonly NotesProvider[] {
    return [...this.providers.values()];
  }

  describe(): readonly NotesProviderInfo[] {
    return this.list().map((provider) => provider.describe());
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  primary(): NotesProvider | undefined {
    return this.list()[0];
  }

  require(providerId: string): NotesProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new NotesProviderError(
        providerId,
        "PROVIDER_NOT_FOUND",
        `Notes provider not registered: ${providerId}${registeredHint([...this.providers.keys()])}`
      );
    }
    return provider;
  }

  requireOrPrimary(providerId: string | undefined): NotesProvider {
    const trimmed = providerId?.trim();
    if (trimmed && !isPrimarySentinel(trimmed)) {
      return this.require(trimmed);
    }
    const primary = this.primary();
    if (!primary) {
      throw new NotesProviderError("", "NO_PROVIDERS", "No notes provider is registered");
    }
    return primary;
  }
}

function registeredHint(ids: readonly string[]): string {
  return ids.length > 0 ? ` (registered: ${ids.join(", ")})` : " (none registered)";
}

// Local-dir adapter is in its own file. Re-export so
// existing `import { LocalDirNotesProvider } from "@muse/mcp/.../notes-providers"`
// stays byte-identical.
export { LocalDirNotesProvider } from "./notes-providers-local.js";
export type { LocalDirNotesProviderOptions } from "./notes-providers-local.js";

// Apple Notes adapter is in its own file. Re-export so
// existing `import { AppleNotesProvider } from "@muse/mcp/.../notes-providers"`
// stays byte-identical.
export { AppleNotesProvider } from "./notes-providers-apple.js";
export type { AppleNotesProviderOptions } from "./notes-providers-apple.js";

// Notion adapter is in its own file. Re-export so
// existing `import { NotionNotesProvider } from "@muse/mcp/.../notes-providers"`
// stays byte-identical.
export { NotionNotesProvider } from "./notes-providers-notion.js";
export type { NotionNotesProviderOptions } from "./notes-providers-notion.js";
