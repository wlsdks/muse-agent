/**
 * Minimal iCalendar (.ics) parser scoped to what
 * `muse calendar import <file.ics>` actually consumes. Reads the
 * VEVENT blocks, pulls UID / SUMMARY / DTSTART / DTEND / LOCATION
 * / DESCRIPTION, and ignores everything else (recurrence rules,
 * timezones, attendees, alarms) — those need stateful expansion
 * the local-file calendar provider doesn't model anyway.
 *
 * Why hand-rolled instead of pulling in `node-ical`: we only
 * support a one-shot manual import, the input format we touch is
 * limited, and adding a transitive dep for ~50 lines of parsing
 * is poor scope discipline. If a future goal needs RRULE / VTIMEZONE
 * expansion, swap to `node-ical` then; the export surface
 * (`parseIcsEvents`) stays.
 */

export interface ParsedIcsEvent {
  readonly uid?: string;
  readonly title: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly allDay: boolean;
  readonly location?: string;
  readonly notes?: string;
}

/**
 * Parse a .ics document body into the subset of fields the CLI
 * importer creates events for. Returns the events newest-first
 * (sorted by `startsAt`). Skips malformed entries silently — a
 * one-bad-block file should still surface the rest.
 *
 * Caller-supplied `now` lets tests pin "today" without depending
 * on the real clock. Default is `new Date()`.
 */
export function parseIcsEvents(body: string): readonly ParsedIcsEvent[] {
  const unfolded = unfoldLines(body);
  const events: ParsedIcsEvent[] = [];
  let inEvent = false;
  let buffer: Record<string, { value: string; isDate: boolean }> = {};

  for (const line of unfolded) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      buffer = {};
      continue;
    }
    if (line === "END:VEVENT") {
      const parsed = finalizeEvent(buffer);
      if (parsed) events.push(parsed);
      inEvent = false;
      buffer = {};
      continue;
    }
    if (!inEvent) continue;
    const split = splitContentLine(line);
    if (!split) continue;
    buffer[split.key] = { value: split.value, isDate: split.isDate };
  }

  return events.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/**
 * iCalendar wraps long lines with a leading whitespace
 * continuation. Re-join those before the splitter sees them.
 */
function unfoldLines(body: string): readonly string[] {
  const raw = body.split(/\r?\n/u);
  const unfolded: string[] = [];
  for (const line of raw) {
    if (line.length === 0) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/**
 * Parse one iCal content line into a normalised
 * `{ key, value, isDate }` triple. `isDate` is true when the
 * line carries `VALUE=DATE` — those are all-day events.
 *
 * Returns `undefined` when the line isn't a key-value pair so
 * the caller can skip unrecognised lines.
 */
function splitContentLine(line: string): { key: string; value: string; isDate: boolean } | undefined {
  const colon = line.indexOf(":");
  if (colon < 0) return undefined;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const semi = head.indexOf(";");
  const key = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
  const params = semi < 0 ? "" : head.slice(semi + 1).toUpperCase();
  const isDate = /(?:^|;)VALUE=DATE(?:;|$)/u.test(params);
  return { key, value, isDate };
}

function finalizeEvent(buffer: Record<string, { value: string; isDate: boolean }>): ParsedIcsEvent | undefined {
  const summary = buffer["SUMMARY"]?.value?.trim();
  const dtstart = buffer["DTSTART"];
  const dtend = buffer["DTEND"];
  if (!summary || !dtstart) return undefined;
  const startsAt = parseIcsDateValue(dtstart.value, dtstart.isDate);
  if (!startsAt) return undefined;
  const allDay = dtstart.isDate;
  // End is optional in iCal (default = startsAt + 0). Make it
  // startsAt + 30 min for timed events, +1 day for all-day, so
  // the local provider's listEvents range filter still finds them.
  let endsAt: Date | undefined;
  if (dtend) {
    endsAt = parseIcsDateValue(dtend.value, dtend.isDate);
  }
  if (!endsAt) {
    endsAt = allDay
      ? new Date(startsAt.getTime() + 24 * 60 * 60 * 1000)
      : new Date(startsAt.getTime() + 30 * 60 * 1000);
  }
  const event: ParsedIcsEvent = {
    title: unescapeIcsText(summary),
    startsAt,
    endsAt,
    allDay,
    ...(buffer["UID"]?.value ? { uid: buffer["UID"].value } : {}),
    ...(buffer["LOCATION"]?.value ? { location: unescapeIcsText(buffer["LOCATION"].value) } : {}),
    ...(buffer["DESCRIPTION"]?.value ? { notes: unescapeIcsText(buffer["DESCRIPTION"].value) } : {})
  };
  return event;
}

/**
 * iCal dates come in two shapes:
 *   - `YYYYMMDD` (VALUE=DATE) — all-day, interpret as UTC midnight.
 *   - `YYYYMMDDTHHMMSS[Z]` — timed. Trailing `Z` = UTC, otherwise
 *     local. We can't honour VTIMEZONE without a real tz library
 *     so we treat unsuffixed times as UTC too; that round-trips
 *     cleanly back out via the LocalCalendarProvider, which is
 *     all the importer needs.
 */
function parseIcsDateValue(raw: string, isDate: boolean): Date | undefined {
  const value = raw.trim();
  if (isDate || /^\d{8}$/u.test(value)) {
    if (!/^\d{8}$/u.test(value)) return undefined;
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(4, 6), 10);
    const day = Number.parseInt(value.slice(6, 8), 10);
    return new Date(Date.UTC(year, month - 1, day));
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(value);
  if (!m) return undefined;
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(Date.UTC(
    Number.parseInt(y!, 10),
    Number.parseInt(mo!, 10) - 1,
    Number.parseInt(d!, 10),
    Number.parseInt(hh!, 10),
    Number.parseInt(mm!, 10),
    Number.parseInt(ss!, 10)
  ));
}

// Single left-to-right pass: an escaped backslash must be consumed
// as one unit so `\\n` is `\` + literal `n`, not a newline (RFC 5545
// §3.3.11). A sequential `\n`→newline-then-`\\`→`\` mangles it.
function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/gu, (_match, ch: string) =>
    ch === "n" || ch === "N" ? "\n" : ch
  );
}
