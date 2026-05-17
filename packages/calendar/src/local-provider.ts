import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { CalendarProviderError, CalendarValidationError } from "./errors.js";
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderInfo,
  CalendarRange
} from "./types.js";

export interface LocalCalendarProviderOptions {
  readonly file: string;
  readonly idFactory?: () => string;
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

  constructor(options: LocalCalendarProviderOptions) {
    this.file = options.file;
    this.idFactory = options.idFactory ?? (() => `cal_${randomUUID()}`);
  }

  describe(): CalendarProviderInfo {
    return {
      credentials: [],
      description: `Local file-backed calendar (${this.file}).`,
      displayName: "Local file",
      id: this.id,
      local: true
    };
  }

  async listEvents(range: CalendarRange): Promise<readonly CalendarEvent[]> {
    const events = await this.readAll();
    return events
      .filter((event) => event.endsAt.getTime() >= range.from.getTime() && event.startsAt.getTime() <= range.to.getTime())
      .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    validateEventInput(input);

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
      ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {})
    };

    await this.writeAll([...events, created]);
    return created;
  }

  async updateEvent(id: string, input: CalendarEventUpdate): Promise<CalendarEvent> {
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
        : {})
    };

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
  }

  async deleteEvent(id: string): Promise<void> {
    const events = await this.readAll();
    const next = events.filter((event) => event.id !== id);

    if (next.length === events.length) {
      throw new CalendarProviderError(this.id, "EVENT_NOT_FOUND", `Calendar event not found: ${id}`);
    }

    await this.writeAll(next);
  }

  private async readAll(): Promise<readonly CalendarEvent[]> {
    let raw: string;

    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }

      throw new CalendarProviderError(this.id, "READ_FAILED", `Failed to read calendar file: ${this.file}`, error);
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return [];
    }

    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { events?: unknown }).events)) {
      return [];
    }

    const persisted = (parsed as { events: unknown[] }).events.flatMap((entry): readonly PersistedEvent[] =>
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
      ...(event.tags && event.tags.length > 0 ? { tags: [...event.tags] } : {})
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
      ...(event.tags && event.tags.length > 0 ? { tags: [...event.tags] } : {})
    }));

    const payload = `${JSON.stringify({ events: persisted }, null, 2)}\n`;
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;

    await fs.mkdir(dirname(this.file), { recursive: true });
    await fs.writeFile(tmp, payload, "utf8");
    await fs.rename(tmp, this.file);
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

  return next ?? existing;
}

function applyOptionalArray(
  existing: readonly string[] | undefined,
  next: readonly string[] | null | undefined
): readonly string[] | undefined {
  if (next === null) {
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
