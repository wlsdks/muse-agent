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
import { parseIcsCalendar } from "./ics-parse.js";
import type {
  CalendarEvent,
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
    return parseIcsCalendar(text, this.id).filter(
      (event) => event.endsAt.getTime() >= range.from.getTime() && event.startsAt.getTime() <= range.to.getTime()
    );
  }

  createEvent(_input: CalendarEventInput): Promise<CalendarEvent> {
    return Promise.reject(this.readOnly());
  }

  updateEvent(_id: string, _input: CalendarEventUpdate): Promise<CalendarEvent> {
    return Promise.reject(this.readOnly());
  }

  deleteEvent(_id: string): Promise<void> {
    return Promise.reject(this.readOnly());
  }

  private readOnly(): CalendarProviderError {
    return new CalendarProviderError(this.id, "WRITE_FAILED", "the local .ics calendar is read-only — edit the source file");
  }
}
