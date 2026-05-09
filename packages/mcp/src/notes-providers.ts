/**
 * Provider-neutral notes abstraction (mirrors @muse/calendar).
 *
 * The existing `createNotesMcpServer({ notesDir })` serves as the
 * single LocalDir provider. This module declares the abstraction
 * shape and ships scaffolds for Apple Notes / Notion so future
 * adapters slot in without rewiring the MCP surface.
 *
 * Design rules:
 *   - `id` is provider-scoped. Cross-provider operations include
 *     `providerId`.
 *   - Failure: providers throw `NotesProviderError` for upstream
 *     failures. Validation errors throw `NotesValidationError`.
 *   - LocalDirNotesProvider is the only adapter with a real
 *     implementation today; Apple Notes + Notion are typed scaffolds
 *     that throw NOT_IMPLEMENTED so the registry shape compiles.
 *
 * Note: `createNotesMcpServer({ notesDir })` continues to work as the
 * built-in single-provider entrypoint. This file gives consumers a
 * future path to register additional providers via the registry.
 */

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
}

export class NotesValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NotesValidationError";
    this.code = code;
  }
}

export class NotesProviderError extends Error {
  readonly providerId: string;
  readonly code: string;

  constructor(providerId: string, code: string, message: string) {
    super(message);
    this.name = "NotesProviderError";
    this.providerId = providerId;
    this.code = code;
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
      throw new NotesProviderError(providerId, "PROVIDER_NOT_FOUND", `Notes provider not registered: ${providerId}`);
    }
    return provider;
  }
}

/**
 * Apple Notes scaffold — placeholder. The real adapter would shell
 * out to `osascript` against `Notes.app` (similar to MacOsCalendarProvider).
 * Throws NOT_IMPLEMENTED until that adapter lands.
 */
export class AppleNotesProvider implements NotesProvider {
  readonly id = "apple";

  describe(): NotesProviderInfo {
    return {
      description: "Apple Notes via AppleScript (NOT_IMPLEMENTED).",
      displayName: "Apple Notes",
      id: this.id,
      local: false
    };
  }

  list(): Promise<readonly NotesEntry[]> {
    return Promise.reject(this.notImplemented("list"));
  }

  read(): Promise<NotesContent | undefined> {
    return Promise.reject(this.notImplemented("read"));
  }

  search(): Promise<readonly NotesSearchHit[]> {
    return Promise.reject(this.notImplemented("search"));
  }

  save(): Promise<NotesContent> {
    return Promise.reject(this.notImplemented("save"));
  }

  append(): Promise<NotesContent> {
    return Promise.reject(this.notImplemented("append"));
  }

  private notImplemented(operation: string): NotesProviderError {
    return new NotesProviderError(
      this.id,
      "NOT_IMPLEMENTED",
      `AppleNotesProvider.${operation} is not implemented yet — open a follow-up to wire osascript against Notes.app.`
    );
  }
}

export interface NotionNotesProviderOptions {
  readonly token: string;
  readonly databaseId?: string;
}

/**
 * Notion scaffold — placeholder. The real adapter would call
 * https://api.notion.com/v1 with the provided integration token,
 * mapping NotesEntry to Notion pages inside `databaseId`. Throws
 * NOT_IMPLEMENTED until that adapter lands.
 */
export class NotionNotesProvider implements NotesProvider {
  readonly id = "notion";
  // Stored for future use when the adapter is wired up.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(private readonly options: NotionNotesProviderOptions) {}

  describe(): NotesProviderInfo {
    return {
      description: "Notion pages (NOT_IMPLEMENTED).",
      displayName: "Notion",
      id: this.id,
      local: false
    };
  }

  list(): Promise<readonly NotesEntry[]> {
    return Promise.reject(this.notImplemented("list"));
  }

  read(): Promise<NotesContent | undefined> {
    return Promise.reject(this.notImplemented("read"));
  }

  search(): Promise<readonly NotesSearchHit[]> {
    return Promise.reject(this.notImplemented("search"));
  }

  save(): Promise<NotesContent> {
    return Promise.reject(this.notImplemented("save"));
  }

  append(): Promise<NotesContent> {
    return Promise.reject(this.notImplemented("append"));
  }

  private notImplemented(operation: string): NotesProviderError {
    return new NotesProviderError(
      this.id,
      "NOT_IMPLEMENTED",
      `NotionNotesProvider.${operation} is not implemented yet — open a follow-up to wire api.notion.com calls.`
    );
  }
}
