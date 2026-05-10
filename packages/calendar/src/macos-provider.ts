import { spawn } from "node:child_process";

import { CalendarProviderError } from "./errors.js";
import type {
  CalendarEvent,
  CalendarEventInput,
  CalendarEventUpdate,
  CalendarProvider,
  CalendarProviderInfo,
  CalendarRange,
  CredentialRequirement
} from "./types.js";

export interface MacOsCalendarProviderOptions {
  readonly calendarName?: string;
  readonly osascriptPath?: string;
}

const credentialRequirements: readonly CredentialRequirement[] = [
  {
    description: "Calendar.app calendar to read/write (defaults to the primary calendar)",
    key: "calendarName",
    label: "Calendar name",
    secret: false
  }
];

/**
 * macOS Calendar.app adapter via AppleScript (osascript).
 *
 * The first call triggers the system permission prompt — until the
 * user grants Calendar access to the parent process (e.g. Terminal /
 * iTerm / VS Code), every script will fail with `EVENT_PERMISSION`.
 * We surface that explicitly so the CLI wizard can guide the user.
 *
 * AppleScript output is structured as `id\tisoStart\tisoEnd\ttitle\tlocation`
 * lines so the agent never has to parse free-form text.
 */
export class MacOsCalendarProvider implements CalendarProvider {
  readonly id = "macos";
  private readonly calendarName?: string;
  private readonly osascriptPath: string;

  constructor(options: MacOsCalendarProviderOptions = {}) {
    this.calendarName = options.calendarName;
    this.osascriptPath = options.osascriptPath ?? "/usr/bin/osascript";
  }

  describe(): CalendarProviderInfo {
    return {
      credentials: credentialRequirements,
      description: "macOS Calendar.app via AppleScript (requires Calendar access permission).",
      displayName: "macOS Calendar.app",
      id: this.id,
      local: false
    };
  }

  async listEvents(range: CalendarRange): Promise<readonly CalendarEvent[]> {
    const calendarRef = this.calendarRef();
    const startIso = isoForOsascript(range.from);
    const endIso = isoForOsascript(range.to);
    const script = `
      set output to ""
      set rangeStart to (do shell script "date -j -f '%Y-%m-%dT%H:%M:%SZ' '${startIso}' '+%s'") as integer
      set rangeEnd to (do shell script "date -j -f '%Y-%m-%dT%H:%M:%SZ' '${endIso}' '+%s'") as integer
      tell application "Calendar"
        repeat with cal in (${calendarRef})
          repeat with evt in (every event of cal whose end date >= (rangeStart as date) and start date <= (rangeEnd as date))
            set evtId to (uid of evt as string)
            set evtTitle to (summary of evt as string)
            set evtStart to (start date of evt)
            set evtEnd to (end date of evt)
            set evtLoc to (location of evt as string)
            set output to output & evtId & tab & (evtStart as «class isot» as string) & tab & (evtEnd as «class isot» as string) & tab & evtTitle & tab & evtLoc & linefeed
          end repeat
        end repeat
      end tell
      return output
    `;
    const stdout = await this.runScript(script);
    return parseListOutput(stdout, this.id);
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
    const calendarRef = this.calendarRef();
    const script = `
      tell application "Calendar"
        set targetCal to first item of (${calendarRef})
        set newEvt to make new event at targetCal with properties { ¬
          summary: ${quote(input.title)}, ¬
          start date: (do shell script "date -j -f '%Y-%m-%dT%H:%M:%SZ' '${isoForOsascript(input.startsAt)}' '+%Y-%m-%d %H:%M:%S'") as date, ¬
          end date: (do shell script "date -j -f '%Y-%m-%dT%H:%M:%SZ' '${isoForOsascript(input.endsAt)}' '+%Y-%m-%d %H:%M:%S'") as date${input.location ? `, ¬\n          location: ${quote(input.location)}` : ""}${input.notes ? `, ¬\n          description: ${quote(input.notes)}` : ""}${input.allDay ? `, ¬\n          allday event: true` : ""} ¬
        }
        return uid of newEvt as string
      end tell
    `;
    const uid = (await this.runScript(script)).trim();
    return {
      allDay: input.allDay ?? false,
      endsAt: input.endsAt,
      id: uid,
      providerId: this.id,
      startsAt: input.startsAt,
      title: input.title,
      ...(input.location ? { location: input.location } : {}),
      ...(input.notes ? { notes: input.notes } : {})
    };
  }

  async updateEvent(id: string, input: CalendarEventUpdate): Promise<CalendarEvent> {
    const calendarRef = this.calendarRef();
    const fragments = [
      input.title !== undefined ? `set summary of evt to ${quote(input.title)}` : null,
      input.startsAt !== undefined ? `set start date of evt to (do shell script "date -j -f '%Y-%m-%dT%H:%M:%SZ' '${isoForOsascript(input.startsAt)}' '+%Y-%m-%d %H:%M:%S'") as date` : null,
      input.endsAt !== undefined ? `set end date of evt to (do shell script "date -j -f '%Y-%m-%dT%H:%M:%SZ' '${isoForOsascript(input.endsAt)}' '+%Y-%m-%d %H:%M:%S'") as date` : null,
      input.location !== undefined ? `set location of evt to ${quote(input.location ?? "")}` : null,
      input.notes !== undefined ? `set description of evt to ${quote(input.notes ?? "")}` : null
    ].filter((fragment): fragment is string => Boolean(fragment));

    if (fragments.length === 0) {
      throw new CalendarProviderError(this.id, "EMPTY_UPDATE", "macOS update requires at least one field");
    }

    const script = `
      tell application "Calendar"
        repeat with cal in (${calendarRef})
          set matches to (every event of cal whose uid is ${quote(id)})
          if (count of matches) > 0 then
            set evt to first item of matches
            ${fragments.join("\n            ")}
            return ""
          end if
        end repeat
      end tell
      error "EVENT_NOT_FOUND"
    `;
    await this.runScript(script);
    const events = await this.listEvents({ from: new Date(0), to: new Date(Date.now() + 365 * 86_400_000) });
    const updated = events.find((event) => event.id === id);
    if (!updated) {
      throw new CalendarProviderError(this.id, "EVENT_NOT_FOUND", `macOS event not found after update: ${id}`);
    }
    return updated;
  }

  async deleteEvent(id: string): Promise<void> {
    const calendarRef = this.calendarRef();
    const script = `
      tell application "Calendar"
        repeat with cal in (${calendarRef})
          set matches to (every event of cal whose uid is ${quote(id)})
          if (count of matches) > 0 then
            delete first item of matches
            return ""
          end if
        end repeat
      end tell
      error "EVENT_NOT_FOUND"
    `;
    await this.runScript(script);
  }

  private calendarRef(): string {
    return this.calendarName
      ? `every calendar whose name is ${quote(this.calendarName)}`
      : `calendars`;
  }

  private async runScript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.osascriptPath, ["-"], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

      child.on("error", (error) => {
        reject(new CalendarProviderError(this.id, "OSASCRIPT_FAILED", error.message, error));
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        if (/not allowed to access|don't have permission/iu.test(stderr)) {
          reject(new CalendarProviderError(this.id, "EVENT_PERMISSION", "Calendar access permission denied — grant access to your terminal in System Settings → Privacy & Security → Calendars."));
          return;
        }

        if (/EVENT_NOT_FOUND/u.test(stderr)) {
          reject(new CalendarProviderError(this.id, "EVENT_NOT_FOUND", "macOS Calendar event not found"));
          return;
        }

        reject(new CalendarProviderError(this.id, `EXIT_${code}`, `osascript failed: ${stderr.trim().slice(0, 500)}`));
      });

      child.stdin.write(script);
      child.stdin.end();
    });
  }
}

function parseListOutput(output: string, providerId: string): readonly CalendarEvent[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line): readonly CalendarEvent[] => {
      const [id, startIso, endIso, title, location] = line.split("\t");
      if (!id || !title || !startIso || !endIso) {
        return [];
      }

      const startsAt = new Date(startIso);
      const endsAt = new Date(endIso);
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        return [];
      }

      return [{
        allDay: false,
        endsAt,
        id,
        providerId,
        startsAt,
        title,
        ...(location && location.length > 0 ? { location } : {})
      }];
    });
}

function quote(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

/**
 * `Date.toISOString()` returns `YYYY-MM-DDTHH:mm:ss.sssZ` (24 chars
 * with milliseconds). The AppleScript shell-out passes the result to
 * `date -j -f '%Y-%m-%dT%H:%M:%SZ'`, which expects the literal `Z`
 * to follow the seconds with no `.SSS` in between — that format
 * silently fails on the millisecond suffix and leaves Calendar.app
 * unable to parse the date. Strip milliseconds so the format matches.
 */
function isoForOsascript(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}
