/**
 * Read-only LOCAL `.ics` calendar provider (B3 perception ②).
 *
 * Reads a user's exported iCalendar file from disk — LOCAL, no network, no
 * cloud — and exposes its events to the agent so `muse ask` can ground on and
 * cite "what's on my calendar". A pure READ connector: every mutator throws,
 * and `describe().local === true` so the local-only registry filter keeps it
 * in (and a remote provider out). A missing/unreadable file ⇒ no events
 * (fail-soft, never throws on read).
 */
import { readFile } from "node:fs/promises";

import { CalendarProviderError } from "./errors.js";
import { selectExactCalendarEvent } from "./exact-event.js";
import { expandRecurringEvent, parseIcsCalendar } from "./ics-parse.js";
import type {
  CalendarEvent,
  CalendarEventLocator,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderInfo,
  CalendarRange
} from "./types.js";

export interface LocalIcsCalendarProviderOptions {
  readonly file: string;
  /** Test seam — defaults to reading `file` from disk. */
  readonly readFileImpl?: (file: string) => Promise<string>;
}

export class LocalIcsCalendarProvider implements CalendarProvider {
  readonly id = "ics";
  private readonly file: string;
  private readonly read: (file: string) => Promise<string>;

  constructor(options: LocalIcsCalendarProviderOptions) {
    this.file = options.file;
    this.read = options.readFileImpl ?? ((f) => readFile(f, "utf8"));
  }

  describe(): CalendarProviderInfo {
    return {
      credentials: [],
      description: `Read-only local iCalendar file (${this.file})`,
      displayName: "Local .ics calendar",
      id: this.id,
      local: true
    };
  }

  async listEvents(range: CalendarRange): Promise<readonly CalendarEvent[]> {
    let text: string;
    try {
      text = await this.read(this.file);
    } catch {
      return []; // missing/unreadable .ics ⇒ no events, never throw
    }
    return parseIcsCalendar(text, this.id)
      // Expand recurring events so a weekly/daily series surfaces its NEXT
      // instance in the window even though the base DTSTART is in the past.
      .flatMap((event) => expandRecurringEvent(event, range.from, range.to))
      .filter((event) => event.endsAt.getTime() >= range.from.getTime() && event.startsAt.getTime() <= range.to.getTime())
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  async resolveExactEvent(locator: CalendarEventLocator): Promise<CalendarEvent | undefined> {
    let text: string;
    try {
      text = await this.read(this.file);
    } catch (cause) {
      throw new CalendarProviderError(this.id, "READ_FAILED", `Failed to read exact calendar source: ${this.file}`, cause);
    }
    const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gu) ?? [];
    const baseEvents = parseIcsCalendar(text, this.id);
    if (baseEvents.length !== blocks.length) {
      throw new CalendarProviderError(this.id, "MALFORMED_EVENT", "Local .ics source contains a malformed event");
    }
    const instant = new Date(locator.startsAt);
    const events = baseEvents.flatMap((event) => expandRecurringEvent(event, instant, instant));
    return selectExactCalendarEvent(events, locator, this.id);
  }

  async createEvent(_input: CalendarEventInput): Promise<CalendarEvent> {
    throw this.readOnly();
  }

  async updateEvent(_id: string, _input: CalendarEventUpdate): Promise<CalendarEvent> {
    throw this.readOnly();
  }

  async deleteEvent(_id: string): Promise<void> {
    throw this.readOnly();
  }

  private readOnly(): CalendarProviderError {
    return new CalendarProviderError(this.id, "WRITE_FAILED", "the local .ics calendar is read-only — edit the source file");
  }
}
