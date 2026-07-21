import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";

import { atomicWriteFile, withFileLock, withFileMutationQueue } from "@muse/stores";

import {
  calendarEncryptionEnabled,
  decryptCalendarEnvelope,
  encryptCalendarEnvelope,
  isEncryptedCalendarEnvelope
} from "./calendar-encryption.js";
import { quarantineCorruptStore } from "./corrupt-quarantine.js";
import { CalendarProviderError, CalendarValidationError } from "./errors.js";
import { selectExactCalendarEvent } from "./exact-event.js";
import { expandRecurringEvent } from "./ics-parse.js";
import type {
  CalendarEvent,
  CalendarEventLocator,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderInfo,
  CalendarRange
} from "./types.js";

export interface LocalCalendarProviderOptions {
  readonly file: string;
  readonly idFactory?: () => string;
  /** Defaults to `process.env`; tests inject `MUSE_MEMORY_KEY` / `MUSE_CALENDAR_ENCRYPT`. */
  readonly env?: NodeJS.ProcessEnv;
}

interface PersistedEvent {
  readonly id: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly allDay: boolean;
  readonly location?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly recurrence?: string;
}

/**
 * File-backed calendar provider. Persists events as a single JSON
 * array (`{ events: PersistedEvent[] }`) at `options.file`. Reads are
 * idempotent — a missing or unparseable file is treated as empty so a
 * fresh install never throws on first read. Writes are atomic
 * (`tmp` file → rename) so a crash mid-write can't corrupt the store.
 */
export class LocalCalendarProvider implements CalendarProvider {
  readonly id = "local";
  private readonly file: string;
  private readonly idFactory: () => string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: LocalCalendarProviderOptions) {
    this.file = options.file;
    this.idFactory = options.idFactory ?? (() => `cal_${randomUUID()}`);
    this.env = options.env ?? process.env;
  }

  describe(): CalendarProviderInfo {
    return {
      credentials: [],
      description: "Local file-backed calendar.",
      displayName: "Local file",
      id: this.id,
      local: true
    };
  }

  async listEvents(range: CalendarRange): Promise<readonly CalendarEvent[]> {
    const events = await this.readAll();
    // Expand any recurring event (a stored RRULE — from import or `add --repeat`)
    // into its in-window instances; a non-recurring event passes through unchanged.
    return events
      .flatMap((event) => expandRecurringEvent(event, range.from, range.to))
      .filter((event) => event.endsAt.getTime() >= range.from.getTime() && event.startsAt.getTime() <= range.to.getTime())
      .sort((left, right) =>
        left.startsAt.getTime() - right.startsAt.getTime() || left.id.localeCompare(right.id)
      );
  }

  async resolveExactEvent(locator: CalendarEventLocator): Promise<CalendarEvent | undefined> {
    const instant = new Date(locator.startsAt);
    const events = (await this.readAll({ strict: true }))
      .flatMap((event) => expandRecurringEvent(event, instant, instant));
    return selectExactCalendarEvent(events, locator, this.id);
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    validateEventInput(input);

    return this.mutateEvents(async () => {
      const events = await this.readAll();
      const created: CalendarEvent = {
        allDay: input.allDay ?? false,
        endsAt: input.endsAt,
        id: this.idFactory(),
        providerId: this.id,
        startsAt: input.startsAt,
        title: input.title.trim(),
        ...(input.location ? { location: input.location } : {}),
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
        ...(input.recurrence ? { recurrence: input.recurrence } : {})
      };

      await this.writeAll([...events, created]);
      return created;
    });
  }

  async updateEvent(id: string, input: CalendarEventUpdate): Promise<CalendarEvent> {
    return this.mutateEvents(async () => {
      const events = await this.readAll();
      const index = events.findIndex((event) => event.id === id);

      if (index < 0) {
        throw new CalendarProviderError(this.id, "EVENT_NOT_FOUND", `Calendar event not found: ${id}`);
      }

      const existing = events[index]!;
      const merged: CalendarEvent = {
        allDay: input.allDay ?? existing.allDay,
        endsAt: input.endsAt ?? existing.endsAt,
        id: existing.id,
        providerId: existing.providerId,
        startsAt: input.startsAt ?? existing.startsAt,
        title: (input.title ?? existing.title).trim(),
        ...(applyOptionalString(existing.location, input.location) !== undefined
          ? { location: applyOptionalString(existing.location, input.location)! }
          : {}),
        ...(applyOptionalString(existing.notes, input.notes) !== undefined
          ? { notes: applyOptionalString(existing.notes, input.notes)! }
          : {}),
        ...(applyOptionalArray(existing.tags, input.tags) !== undefined
          ? { tags: applyOptionalArray(existing.tags, input.tags)! }
          : {}),
        // Preserve recurrence across an edit — a title/time change must not silently
        // turn a recurring event into a one-off (CalendarEventUpdate can't alter it).
        ...(existing.recurrence ? { recurrence: existing.recurrence } : {})
      };

      if (!(merged.startsAt instanceof Date) || Number.isNaN(merged.startsAt.getTime())) {
        throw new CalendarValidationError("INVALID_START", "startsAt must be a valid Date");
      }

      if (!(merged.endsAt instanceof Date) || Number.isNaN(merged.endsAt.getTime())) {
        throw new CalendarValidationError("INVALID_END", "endsAt must be a valid Date");
      }

      if (merged.endsAt.getTime() < merged.startsAt.getTime()) {
        throw new CalendarValidationError("INVALID_TIME_RANGE", "endsAt must be at or after startsAt");
      }

      if (merged.title.length === 0) {
        throw new CalendarValidationError("INVALID_TITLE", "title must be a non-empty string");
      }

      const next = [...events];
      next[index] = merged;
      await this.writeAll(next);
      return merged;
    });
  }

  async deleteEvent(id: string): Promise<void> {
    await this.mutateEvents(async () => {
      const events = await this.readAll();
      const next = events.filter((event) => event.id !== id);

      if (next.length === events.length) {
        throw new CalendarProviderError(this.id, "EVENT_NOT_FOUND", `Calendar event not found: ${id}`);
      }

      await this.writeAll(next);
    });
  }

  private async readAll(options: { readonly strict?: boolean } = {}): Promise<readonly CalendarEvent[]> {
    let raw: string;

    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        if (!options.strict) return [];
      }

      throw new CalendarProviderError(this.id, "READ_FAILED", `Failed to read calendar file: ${this.file}`, error);
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (cause) {
      if (options.strict) {
        throw new CalendarProviderError(this.id, "MALFORMED_STORE", `Calendar store is malformed: ${this.file}`, cause);
      }
      await quarantineCorruptStore(this.file);
      return [];
    }

    if (isEncryptedCalendarEnvelope(parsed)) {
      // A decrypt failure (wrong MUSE_MEMORY_KEY / tamper) is NOT corruption —
      // it must propagate and MUST NOT fall into the quarantine path below,
      // which would move the user's only copy of the ciphertext aside.
      let decrypted: string;
      try {
        decrypted = decryptCalendarEnvelope(parsed, this.env);
      } catch (error) {
        throw new CalendarProviderError(this.id, "DECRYPT_FAILED", (error as Error).message, error);
      }

      try {
        parsed = JSON.parse(decrypted) as unknown;
      } catch (cause) {
        if (options.strict) {
          throw new CalendarProviderError(this.id, "MALFORMED_STORE", `Decrypted calendar store is malformed: ${this.file}`, cause);
        }
        await quarantineCorruptStore(this.file);
        return [];
      }
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { events?: unknown }).events)) {
      if (options.strict) {
        throw new CalendarProviderError(this.id, "MALFORMED_STORE", `Calendar store is malformed: ${this.file}`);
      }
      await quarantineCorruptStore(this.file);
      return [];
    }

    const entries = (parsed as { events: unknown[] }).events;
    if (options.strict && entries.some((entry) => !isPersistedEvent(entry))) {
      throw new CalendarProviderError(this.id, "MALFORMED_EVENT", `Calendar store contains a malformed event: ${this.file}`);
    }
    const persisted = entries.flatMap((entry): readonly PersistedEvent[] =>
      isPersistedEvent(entry) ? [entry] : []
    );

    return persisted.map((event): CalendarEvent => ({
      allDay: event.allDay,
      endsAt: new Date(event.endsAt),
      id: event.id,
      providerId: this.id,
      startsAt: new Date(event.startsAt),
      title: event.title,
      ...(event.location ? { location: event.location } : {}),
      ...(event.notes ? { notes: event.notes } : {}),
      ...(event.tags && event.tags.length > 0 ? { tags: [...event.tags] } : {}),
      ...(typeof event.recurrence === "string" ? { recurrence: event.recurrence } : {})
    }));
  }

  private async writeAll(events: readonly CalendarEvent[]): Promise<void> {
    const persisted: readonly PersistedEvent[] = events.map((event) => ({
      allDay: event.allDay,
      endsAt: event.endsAt.toISOString(),
      id: event.id,
      startsAt: event.startsAt.toISOString(),
      title: event.title,
      ...(event.location ? { location: event.location } : {}),
      ...(event.notes ? { notes: event.notes } : {}),
      ...(event.tags && event.tags.length > 0 ? { tags: [...event.tags] } : {}),
      ...(event.recurrence ? { recurrence: event.recurrence } : {})
    }));

    const payload = `${JSON.stringify({ events: persisted }, null, 2)}\n`;
    // Format-preserving: once a store is encrypted it STAYS encrypted even if
    // MUSE_CALENDAR_ENCRYPT is later unset — an env flip must never silently
    // decrypt a file at rest on the next write.
    const alreadyEncrypted = await isCalendarFileCurrentlyEncrypted(this.file);
    const shouldEncrypt = calendarEncryptionEnabled(this.env) || alreadyEncrypted;
    if (shouldEncrypt && !alreadyEncrypted) {
      await this.backupPlaintextBeforeEncrypt();
    }
    const content = shouldEncrypt ? `${JSON.stringify(encryptCalendarEnvelope(payload, this.env))}\n` : payload;
    // 0o600: events carry title / location / notes / attendees that
    // are private user data. The credential-store sibling in this
    // package already uses 0o600 + chmod; default umask would
    // otherwise leave the schedule world-readable on a shared box.
    await atomicWriteFile(this.file, content);
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }

  private async mutateEvents<T>(mutator: () => Promise<T>): Promise<T> {
    return withFileMutationQueue(this.file, async () =>
      withFileLock(this.file, mutator)
    );
  }

  /**
   * Before the FIRST plaintext→encrypted write, snapshot the existing on-disk
   * plaintext so a lost or rotated MUSE_MEMORY_KEY can't make the schedule
   * unrecoverable. No plaintext on disk yet ⇒ nothing to back up.
   */
  private async backupPlaintextBeforeEncrypt(): Promise<void> {
    const existing = await fs.readFile(this.file, "utf8").catch(() => undefined);
    if (existing === undefined || existing.trim().length === 0) {
      return;
    }
    const backupPath = `${this.file}.plaintext-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
    await fs.writeFile(backupPath, existing, { encoding: "utf8", mode: 0o600 });
  }
}

async function isCalendarFileCurrentlyEncrypted(file: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return isEncryptedCalendarEnvelope(JSON.parse(raw));
  } catch {
    return false;
  }
}

function validateEventInput(input: CalendarEventInput): void {
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new CalendarValidationError("INVALID_TITLE", "title must be a non-empty string");
  }

  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) {
    throw new CalendarValidationError("INVALID_START", "startsAt must be a valid Date");
  }

  if (!(input.endsAt instanceof Date) || Number.isNaN(input.endsAt.getTime())) {
    throw new CalendarValidationError("INVALID_END", "endsAt must be a valid Date");
  }

  if (input.endsAt.getTime() < input.startsAt.getTime()) {
    throw new CalendarValidationError("INVALID_TIME_RANGE", "endsAt must be at or after startsAt");
  }
}

function applyOptionalString(existing: string | undefined, next: string | null | undefined): string | undefined {
  if (next === null) {
    return undefined;
  }
  // `createEvent` strips empty strings via the `input.location ? …` truthy
  // check, so an empty string never makes it into the persisted shape on
  // create. Update must match: a caller passing `""` to clear a field
  // sees the same omit-on-write behavior as create, not a literal "" in
  // the JSON store. `"   "` (whitespace) is treated the same as create —
  // a truthy non-empty string passes through unchanged.
  if (next === "") {
    return undefined;
  }
  return next ?? existing;
}

function applyOptionalArray(
  existing: readonly string[] | undefined,
  next: readonly string[] | null | undefined
): readonly string[] | undefined {
  if (next === null) {
    return undefined;
  }
  if (next !== undefined && next.length === 0) {
    return undefined;
  }
  return next ?? existing;
}

function isPersistedEvent(value: unknown): value is PersistedEvent {
  // Require startsAt/endsAt to actually PARSE: a hand-edited /
  // imported calendar.json with `"tomorrow"` or a typo'd date
  // would otherwise pass the type guard, become an Invalid Date,
  // and then vanish silently from every listEvents view (NaN
  // fails the range filter). Drop it here instead — the same
  // unparseable-event posture CalDAV's parseVEvent uses.
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as PersistedEvent).id === "string"
    && typeof (value as PersistedEvent).title === "string"
    && isParsableDateString((value as PersistedEvent).startsAt)
    && isParsableDateString((value as PersistedEvent).endsAt)
    && typeof (value as PersistedEvent).allDay === "boolean";
}

function isParsableDateString(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: string }).code === "ENOENT";
}
